/**
 * Chart component.
 *
 * Creates a Lightweight Charts v5 candlestick chart, attaches the liquidation
 * bubble primitive, loads candles and liquidations for the active timeframe,
 * and subscribes to live liquidations over the websocket. Reacts to timeframe
 * and minimum-USD changes from the controls, and resizes with its container.
 */

import { useEffect, useRef, useState } from 'react';
import {
    createChart,
    CandlestickSeries,
    ColorType,
    type IChartApi,
    type ISeriesApi,
    type CandlestickData,
    type Time,
} from 'lightweight-charts';
import { LiquidationPrimitive } from './LiquidationPrimitive.js';
import { fetchCandles, fetchLiquidations, subscribeLiquidations } from './api.js';
import { formatKyivFull, formatKyivHourMinute, formatKyivDayMonth } from './timeFormat.js';
import { loadRange, saveRange } from './persist.js';
import type { Liquidation, Timeframe } from './types.js';

/**
 * Tooltip state: the hovered liquidation and the cursor position to anchor to.
 */
interface TooltipState {
    liq: Liquidation;
    x: number;
    y: number;
}

/**
 * Bar duration in seconds for each timeframe, used to snap liquidation times to
 * candle boundaries so their coordinates resolve on the time scale.
 */
const BAR_SECONDS: Record<Timeframe, number> = {
    '5m': 5 * 60,
    '15m': 15 * 60,
    '1h': 60 * 60,
    '4h': 4 * 60 * 60,
    '1d': 24 * 60 * 60,
};

/**
 * Props controlling what the chart displays.
 */
interface ChartProps {
    timeframe: Timeframe;
    minUsd: number;
    refreshMs: number;
}

/**
 * Renders the interactive chart for a given timeframe and USD filter.
 */
export function Chart({ timeframe, minUsd, refreshMs }: ChartProps): JSX.Element {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const primitiveRef = useRef<LiquidationPrimitive | null>(null);
    const lastBarTimeRef = useRef<number>(0);
    const timeframeRef = useRef<Timeframe>(timeframe);
    const rangeSaveTimerRef = useRef<number | null>(null);
    const [tooltip, setTooltip] = useState<TooltipState | null>(null);
    const [navVisible, setNavVisible] = useState<boolean>(false);
    const navHideTimerRef = useRef<number | null>(null);

    /**
     * Create the chart once on mount and dispose on unmount. A ResizeObserver
     * keeps the chart sized to its container.
     */
    useEffect(() => {
        const container = containerRef.current;
        if (container === null) {
            return;
        }

        const chart = createChart(container, {
            autoSize: true,
            layout: {
                background: { type: ColorType.Solid, color: '#0e1117' },
                textColor: '#a7b0c0',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            },
            grid: {
                vertLines: { color: 'rgba(255,255,255,0.04)' },
                horzLines: { color: 'rgba(255,255,255,0.04)' },
            },
            rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
            timeScale: {
                borderColor: 'rgba(255,255,255,0.1)',
                timeVisible: true,
                /**
                 * Axis tick labels in Kyiv time. Intraday tick types use
                 * hour:minute; day and higher use day + short month. tickMarkType
                 * values: 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds.
                 */
                tickMarkFormatter: (time: number, tickMarkType: number): string => {
                    if (tickMarkType >= 3) {
                        return formatKyivHourMinute(time);
                    }
                    return formatKyivDayMonth(time);
                },
            },
            localization: {
                /**
                 * Crosshair time label in Kyiv time, full date and time.
                 */
                timeFormatter: (time: number): string => formatKyivFull(time * 1000),
            },
            crosshair: { mode: 0 },
        });

        const series = chart.addSeries(CandlestickSeries, {
            upColor: '#26a69a',
            downColor: '#ef5350',
            borderVisible: false,
            wickUpColor: '#26a69a',
            wickDownColor: '#ef5350',
        });

        const primitive = new LiquidationPrimitive();
        series.attachPrimitive(primitive);

        /**
         * Update the tooltip as the hovered bubble changes. The handler fires
         * from the primitive's hit test on cursor movement.
         */
        primitive.setHoverHandler((liq, x, y) => {
            setTooltip(liq === null ? null : { liq, x, y });
        });

        chartRef.current = chart;
        seriesRef.current = series;
        primitiveRef.current = primitive;

        /**
         * Persist the visible logical range (per timeframe) shortly after the
         * user stops panning or zooming. Debounced to avoid excessive writes.
         */
        const onRangeChange = (range: { from: number; to: number } | null): void => {
            if (range === null) {
                return;
            }
            if (rangeSaveTimerRef.current !== null) {
                window.clearTimeout(rangeSaveTimerRef.current);
            }
            rangeSaveTimerRef.current = window.setTimeout(() => {
                saveRange(timeframeRef.current, { from: range.from, to: range.to });
            }, 400);
        };
        chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);

        return () => {
            chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
            chart.remove();
            chartRef.current = null;
            seriesRef.current = null;
            primitiveRef.current = null;
        };
    }, []);

    /**
     * Keep the timeframe ref in sync so the range-save handler always persists
     * under the currently active timeframe.
     */
    useEffect(() => {
        timeframeRef.current = timeframe;
    }, [timeframe]);

    /**
     * Load candles and historical liquidations whenever the timeframe changes.
     * Liquidations are loaded unfiltered; the USD filter is applied client-side
     * by the primitive so changing it does not require a refetch.
     */
    useEffect(() => {
        const series = seriesRef.current;
        const chart = chartRef.current;
        const primitive = primitiveRef.current;
        if (series === null || chart === null || primitive === null) {
            return;
        }

        let cancelled = false;

        /**
         * Align liquidation snapping to the active timeframe before loading.
         */
        primitive.setBarSeconds(BAR_SECONDS[timeframe]);

        const load = async (): Promise<void> => {
            const candles = await fetchCandles(timeframe);
            if (cancelled) {
                return;
            }
            const data: CandlestickData<Time>[] = candles.map((c) => ({
                time: c.time as Time,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
            }));
            series.setData(data);
            /**
             * Track the newest bar time so polling knows which bars to apply.
             */
            lastBarTimeRef.current = data.length > 0 ? (data[data.length - 1].time as number) : 0;

            /**
             * Restore this timeframe's saved zoom/scroll if present; otherwise
             * fit all data. Each timeframe keeps its own range.
             */
            const saved = loadRange(timeframe);
            if (saved !== null) {
                chart.timeScale().setVisibleLogicalRange(saved);
            } else {
                chart.timeScale().fitContent();
            }

            const liquidations = await fetchLiquidations();
            if (cancelled) {
                return;
            }
            primitive.setLiquidations(liquidations);
        };

        void load();

        return () => {
            cancelled = true;
        };
    }, [timeframe]);

    /**
     * Apply the USD filter to the primitive whenever it changes.
     */
    useEffect(() => {
        primitiveRef.current?.setMinUsd(minUsd);
    }, [minUsd]);

    /**
     * Poll for fresh data on the selected refresh interval. Each tick updates
     * candles (the forming bar grows and newly closed bars appear) and reloads
     * liquidations so new bubbles are drawn together with the candle update.
     * Re-created when the timeframe or interval changes.
     */
    useEffect(() => {
        const series = seriesRef.current;
        const primitive = primitiveRef.current;
        if (series === null || primitive === null) {
            return;
        }

        let stopped = false;

        const poll = async (): Promise<void> => {
            try {
                const candles = await fetchCandles(timeframe);
                if (stopped || candles.length === 0) {
                    return;
                }
                /**
                 * Apply every bar at or after the last known bar time. update()
                 * upserts by time: it refreshes the still-forming bar and appends
                 * bars that have closed since the previous poll, in order, with no
                 * duplicates or gaps.
                 */
                const lastKnown = lastBarTimeRef.current;
                for (const c of candles) {
                    if (c.time >= lastKnown) {
                        series.update({
                            time: c.time as Time,
                            open: c.open,
                            high: c.high,
                            low: c.low,
                            close: c.close,
                        });
                    }
                }
                lastBarTimeRef.current = candles[candles.length - 1].time;

                /**
                 * Refresh liquidations so newly collected ones appear as bubbles
                 * at the same time as the candle update.
                 */
                const liquidations = await fetchLiquidations();
                if (!stopped) {
                    primitive.setLiquidations(liquidations);
                }
            } catch {
                /**
                 * Ignore a failed poll; the next tick retries.
                 */
            }
        };

        const timer = window.setInterval(() => {
            void poll();
        }, refreshMs);

        return () => {
            stopped = true;
            window.clearInterval(timer);
        };
    }, [timeframe, refreshMs]);

    /**
     * Subscribe to live liquidations once on mount. New events are appended to
     * the primitive, which redraws them with the active filter.
     */
    useEffect(() => {
        const dispose = subscribeLiquidations((liq) => {
            primitiveRef.current?.addLiquidation(liq);
        });
        return dispose;
    }, []);

    /**
     * Reveals the navigation buttons and resets the auto-hide timer. Called on
     * pointer movement and wheel scrolling over the chart, mirroring the
     * TradingView pattern of controls that appear on interaction.
     */
    const revealNav = (): void => {
        setNavVisible(true);
        if (navHideTimerRef.current !== null) {
            window.clearTimeout(navHideTimerRef.current);
        }
        navHideTimerRef.current = window.setTimeout(() => {
            setNavVisible(false);
        }, 2000);
    };

    /**
     * Zooms the time scale by scaling the visible logical range around its
     * center. factor < 1 zooms in (fewer bars), factor > 1 zooms out.
     */
    const zoom = (factor: number): void => {
        const chart = chartRef.current;
        if (chart === null) {
            return;
        }
        const ts = chart.timeScale();
        const range = ts.getVisibleLogicalRange();
        if (range === null) {
            return;
        }
        const center = (range.from + range.to) / 2;
        const half = ((range.to - range.from) / 2) * factor;
        ts.setVisibleLogicalRange({ from: center - half, to: center + half });
        revealNav();
    };

    /**
     * Scrolls back to the most recent bar (real time), like TradingView's
     * jump-to-latest control.
     */
    const goToRealtime = (): void => {
        chartRef.current?.timeScale().scrollToRealTime();
        revealNav();
    };

    return (
        <div
            style={{ position: 'relative', width: '100%', height: '100%' }}
            onPointerMove={revealNav}
            onWheel={revealNav}
        >
            <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
            {tooltip !== null && <LiquidationTooltip state={tooltip} />}
            <div className={navVisible ? 'nav-controls visible' : 'nav-controls'}>
                <button type="button" className="nav-btn" onClick={() => zoom(0.8)} title="Zoom in" aria-label="Zoom in">
                    +
                </button>
                <button type="button" className="nav-btn" onClick={() => zoom(1.25)} title="Zoom out" aria-label="Zoom out">
                    −
                </button>
                <button type="button" className="nav-btn" onClick={goToRealtime} title="Go to latest" aria-label="Go to latest">
                    »
                </button>
            </div>
        </div>
    );
}

/**
 * Formats a USD amount with thousands separators and no decimals.
 */
function formatUsd(usd: number): string {
    return `$${Math.round(usd).toLocaleString('en-US')}`;
}

/**
 * Floating tooltip showing details of the hovered liquidation. Positioned near
 * the cursor and offset so it does not sit under the pointer. Clamped left when
 * close to the right edge is handled by transform on the x anchor.
 */
function LiquidationTooltip({ state }: { state: TooltipState }): JSX.Element {
    const { liq, x, y } = state;
    const sideLabel = liq.side === 'LONG' ? 'Long liquidated' : 'Short liquidated';
    const isAnomaly = liq.usd >= 1_000_000;
    const accent = isAnomaly ? '#ffc107' : liq.side === 'LONG' ? '#ef5350' : '#26a69a';

    return (
        <div
            style={{
                position: 'absolute',
                left: x,
                top: y,
                transform: 'translate(12px, -50%)',
                pointerEvents: 'none',
                background: 'rgba(17, 21, 29, 0.96)',
                border: `1px solid ${accent}`,
                borderRadius: 6,
                padding: '8px 10px',
                font: '12px ui-monospace, SFMono-Regular, Menlo, monospace',
                color: '#d4dae6',
                whiteSpace: 'nowrap',
                zIndex: 10,
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            }}
        >
            <div style={{ color: accent, fontWeight: 600, marginBottom: 4 }}>
                {sideLabel}
                {isAnomaly ? ' · anomaly' : ''}
            </div>
            <div>Size: {formatUsd(liq.usd)}</div>
            <div>Price: ${liq.price.toLocaleString('en-US')}</div>
            <div style={{ color: '#6b7686' }}>{formatKyivFull(liq.time)}</div>
        </div>
    );
}
