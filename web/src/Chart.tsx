/**
 * Chart component.
 *
 * Creates a Lightweight Charts v5 candlestick chart, attaches the liquidation
 * bubble primitive, loads candles for the active timeframe and the liquidation
 * history once, and subscribes to live liquidations over the websocket. Reacts
 * to timeframe and minimum-USD changes from the controls, and resizes with its
 * container.
 *
 * Network traffic is kept incremental: candles are cached per timeframe and
 * every later request asks only for bars from the newest cached one onwards;
 * liquidations are loaded in full once and then polled only from the newest
 * one received over REST.
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
import type { Candle, Liquidation, Timeframe } from './types.js';

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
 * Overlap, in milliseconds, when polling liquidations from the newest one
 * already received. Rows stored slightly out of order are still picked up;
 * the primitive drops the duplicates the overlap brings back.
 */
const LIQ_POLL_OVERLAP_MS = 60_000;

/**
 * Converts API candles into series bars.
 */
function toBars(candles: Candle[]): CandlestickData<Time>[] {
    return candles.map((c) => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
    }));
}

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
    const candleCacheRef = useRef<Map<Timeframe, CandlestickData<Time>[]>>(new Map());
    const lastLiqTimeRef = useRef<number | null>(null);
    const liqInFlightRef = useRef<boolean>(false);
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
     * Upserts fresh bars into a timeframe's cache and, while that timeframe is
     * on screen, into the series. Bars older than the newest cached bar are
     * skipped; update() refreshes the still-forming bar and appends bars that
     * closed since, in order, with no duplicates or gaps.
     */
    const applyBars = (tf: Timeframe, candles: Candle[]): void => {
        const cache = candleCacheRef.current.get(tf);
        if (cache === undefined) {
            return;
        }
        const series = timeframeRef.current === tf ? seriesRef.current : null;

        for (const bar of toBars(candles)) {
            const last = cache.length > 0 ? cache[cache.length - 1] : null;
            if (last !== null && (bar.time as number) < (last.time as number)) {
                continue;
            }
            if (last !== null && bar.time === last.time) {
                cache[cache.length - 1] = bar;
            } else {
                cache.push(bar);
            }
            series?.update(bar);
        }
    };

    /**
     * Restores a timeframe's saved zoom/scroll if present; otherwise fits all
     * data. Each timeframe keeps its own range.
     */
    const restoreRange = (tf: Timeframe): void => {
        const chart = chartRef.current;
        if (chart === null) {
            return;
        }
        const saved = loadRange(tf);
        if (saved !== null) {
            chart.timeScale().setVisibleLogicalRange(saved);
        } else {
            chart.timeScale().fitContent();
        }
    };

    /**
     * Brings a timeframe's candles up to date. With a cache, only the bars
     * from the newest cached one onwards are fetched. Without one (first visit,
     * or an earlier load failed) the full history is fetched, cached and, if
     * the timeframe is still on screen, shown.
     */
    const loadCandles = async (tf: Timeframe): Promise<void> => {
        const cache = candleCacheRef.current.get(tf);
        if (cache !== undefined && cache.length > 0) {
            applyBars(tf, await fetchCandles(tf, cache[cache.length - 1].time as number));
            return;
        }

        const bars = toBars(await fetchCandles(tf));
        candleCacheRef.current.set(tf, bars);
        if (timeframeRef.current === tf) {
            seriesRef.current?.setData(bars);
            restoreRange(tf);
        }
    };

    /**
     * Fetches liquidations: the whole history on the first call, afterwards
     * only those from the newest one received over REST (minus a small
     * overlap). Websocket events are not used as the starting point, so
     * anything missed while the socket was down is still caught up here.
     * Overlapping calls are skipped.
     */
    const refreshLiquidations = async (): Promise<void> => {
        if (liqInFlightRef.current) {
            return;
        }
        liqInFlightRef.current = true;
        try {
            const last = lastLiqTimeRef.current;
            const liquidations = await fetchLiquidations(last === null ? undefined : last - LIQ_POLL_OVERLAP_MS);
            if (liquidations.length > 0) {
                lastLiqTimeRef.current = Math.max(last ?? 0, liquidations[liquidations.length - 1].time);
            }
            primitiveRef.current?.addLiquidations(liquidations);
        } finally {
            liqInFlightRef.current = false;
        }
    };

    /**
     * Show candles whenever the timeframe changes. A timeframe seen before is
     * drawn from the cache at once and topped up with the new bars only; a new
     * one is loaded in full. Liquidations do not depend on the timeframe and
     * are not reloaded; the USD filter is applied client-side by the primitive.
     */
    useEffect(() => {
        const series = seriesRef.current;
        const primitive = primitiveRef.current;
        if (series === null || primitive === null) {
            return;
        }

        /**
         * Align liquidation snapping to the active timeframe before loading.
         */
        primitive.setBarSeconds(BAR_SECONDS[timeframe]);

        const cached = candleCacheRef.current.get(timeframe);
        if (cached !== undefined && cached.length > 0) {
            series.setData(cached);
            restoreRange(timeframe);
        }

        void loadCandles(timeframe).catch(() => {
            /**
             * A failed load is retried by the next poll.
             */
        });
    }, [timeframe]);

    /**
     * Apply the USD filter to the primitive whenever it changes.
     */
    useEffect(() => {
        primitiveRef.current?.setMinUsd(minUsd);
    }, [minUsd]);

    /**
     * Poll for fresh data on the selected refresh interval. Each tick fetches
     * only what is new: the forming bar and bars closed since the last tick,
     * and liquidations stored since the last REST response. Re-created when
     * the timeframe or interval changes.
     */
    useEffect(() => {
        const timer = window.setInterval(() => {
            /**
             * A failed poll is ignored; the next tick retries.
             */
            void loadCandles(timeframe).catch(() => undefined);
            void refreshLiquidations().catch(() => undefined);
        }, refreshMs);

        return () => {
            window.clearInterval(timer);
        };
    }, [timeframe, refreshMs]);

    /**
     * Load the liquidation history and subscribe to live liquidations once on
     * mount. Both feed the primitive, which merges them without duplicates and
     * redraws them with the active filter.
     */
    useEffect(() => {
        void refreshLiquidations().catch(() => undefined);
        const dispose = subscribeLiquidations((liq) => {
            primitiveRef.current?.addLiquidations([liq]);
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
