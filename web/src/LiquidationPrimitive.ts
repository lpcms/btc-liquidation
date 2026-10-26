/**
 * Liquidation bubble primitive for Lightweight Charts v5.
 *
 * Implements ISeriesPrimitive to draw each liquidation as a filled circle at
 * its exact (time, price) position on the candlestick series:
 *  - vertical position: series.priceToCoordinate(liquidation price)
 *  - horizontal position: timeScale.timeToCoordinate(liquidation time)
 *  - radius scales with the square root of USD notional so that bubble area is
 *    proportional to value, the convention used by liquidation heatmaps
 *  - color encodes side: long liquidations and short liquidations differ
 *
 * The primitive holds the full liquidation set and a USD filter threshold.
 * Drawing is clipped to the pane and skips bubbles whose coordinates are off
 * screen or unresolved.
 */

import type {
    ISeriesPrimitive,
    IPrimitivePaneView,
    IPrimitivePaneRenderer,
    SeriesAttachedParameter,
    Time,
    ISeriesApi,
    IChartApi,
    SeriesType,
    PrimitiveHoveredItem,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { Liquidation } from './types.js';

/**
 * A liquidation positioned on screen during the last draw, used for hit testing
 * and tooltip lookup.
 */
interface PlacedBubble {
    x: number;
    y: number;
    radius: number;
    liq: Liquidation;
}

/**
 * Visual tuning constants for bubble rendering.
 */
const MIN_RADIUS_PX = 3;
const MAX_RADIUS_PX = 28;

/**
 * USD notional that maps to the maximum bubble radius. Liquidations at or above
 * this value are drawn at MAX_RADIUS_PX; smaller ones scale by sqrt ratio.
 */
const RADIUS_SATURATION_USD = 5_000_000;

/**
 * Threshold above which a liquidation is considered anomalous and highlighted
 * with a distinct bright color regardless of side.
 */
const ANOMALY_USD = 1_000_000;

/**
 * Fill colors per side at 50% opacity so candles remain visible beneath the
 * bubbles. Long liquidations (forced sells) are red, short liquidations
 * (forced buys) are green. Anomalies above ANOMALY_USD use a bright amber that
 * stands out against both sides and the dark background.
 */
const COLOR_LONG = 'rgba(239, 83, 80, 0.5)';
const COLOR_SHORT = 'rgba(38, 166, 154, 0.5)';
const COLOR_ANOMALY = 'rgba(255, 193, 7, 0.5)';
const STROKE_LONG = 'rgba(239, 83, 80, 0.9)';
const STROKE_SHORT = 'rgba(38, 166, 154, 0.9)';
const STROKE_ANOMALY = 'rgba(255, 193, 7, 1)';

/**
 * Returns the fill color for a liquidation, prioritizing the anomaly highlight
 * over the side color.
 */
function fillColor(usd: number, side: 'LONG' | 'SHORT'): string {
    if (usd >= ANOMALY_USD) {
        return COLOR_ANOMALY;
    }
    return side === 'LONG' ? COLOR_LONG : COLOR_SHORT;
}

/**
 * Returns the stroke color for a liquidation, matching the fill logic.
 */
function strokeColor(usd: number, side: 'LONG' | 'SHORT'): string {
    if (usd >= ANOMALY_USD) {
        return STROKE_ANOMALY;
    }
    return side === 'LONG' ? STROKE_LONG : STROKE_SHORT;
}

/**
 * Computes a bubble radius in pixels from a USD notional using a square-root
 * scale clamped to the configured min and max.
 */
function radiusForUsd(usd: number): number {
    const ratio = Math.min(1, Math.sqrt(usd / RADIUS_SATURATION_USD));
    return MIN_RADIUS_PX + ratio * (MAX_RADIUS_PX - MIN_RADIUS_PX);
}

/**
 * Renderer that draws the bubbles for the current viewport.
 */
class BubbleRenderer implements IPrimitivePaneRenderer {
    private readonly source: LiquidationPrimitive;

    constructor(source: LiquidationPrimitive) {
        this.source = source;
    }

    /**
     * Draws all visible bubbles. Uses the media (CSS pixel) coordinate space so
     * positions line up with the chart regardless of device pixel ratio. While
     * drawing, records each bubble's screen position and radius so hit testing
     * and the tooltip can map a cursor location back to a liquidation.
     */
    draw(target: CanvasRenderingTarget2D): void {
        const series = this.source.series;
        const chart = this.source.chart;
        if (series === null || chart === null) {
            return;
        }

        const timeScale = chart.timeScale();
        const placed: PlacedBubble[] = [];

        target.useMediaCoordinateSpace((scope) => {
            const ctx = scope.context;

            for (const liq of this.source.getFiltered()) {
                const barTime = this.source.snapToBar(liq.time);
                const x = timeScale.timeToCoordinate(barTime as Time);
                const y = series.priceToCoordinate(liq.price);
                if (x === null || y === null) {
                    continue;
                }

                /**
                 * Skip bubbles whose center is outside the visible media area to
                 * avoid unnecessary draw work during pans and zooms.
                 */
                if (x < 0 || x > scope.mediaSize.width || y < 0 || y > scope.mediaSize.height) {
                    continue;
                }

                const radius = radiusForUsd(liq.usd);
                ctx.beginPath();
                ctx.arc(x, y, radius, 0, Math.PI * 2);
                ctx.fillStyle = fillColor(liq.usd, liq.side);
                ctx.fill();
                ctx.lineWidth = liq.usd >= ANOMALY_USD ? 1.5 : 1;
                ctx.strokeStyle = strokeColor(liq.usd, liq.side);
                ctx.stroke();

                placed.push({ x, y, radius, liq });
            }
        });

        /**
         * Publish the placed bubbles for hit testing. Larger bubbles are tested
         * first so the topmost (most significant) liquidation wins on overlap.
         */
        placed.sort((a, b) => b.radius - a.radius);
        this.source.setPlaced(placed);
    }
}

/**
 * Pane view that exposes the bubble renderer at the top of the visual stack so
 * bubbles draw above the candles.
 */
class BubblePaneView implements IPrimitivePaneView {
    private readonly bubbleRenderer: BubbleRenderer;

    constructor(source: LiquidationPrimitive) {
        this.bubbleRenderer = new BubbleRenderer(source);
    }

    /**
     * Returns the z-order; "top" places bubbles above series content.
     */
    zOrder(): 'top' {
        return 'top';
    }

    /**
     * Returns the renderer for this view.
     */
    renderer(): IPrimitivePaneRenderer {
        return this.bubbleRenderer;
    }
}

/**
 * Series primitive holding liquidation data and the current USD filter.
 */
export class LiquidationPrimitive implements ISeriesPrimitive<Time> {
    /**
     * Chart and series references, populated on attach. Public for the renderer.
     */
    chart: IChartApi | null = null;
    series: ISeriesApi<SeriesType> | null = null;

    private liquidations: Liquidation[] = [];
    private minUsd = 0;
    private barSeconds = 3600;
    private placed: PlacedBubble[] = [];
    private onHover: ((liq: Liquidation | null, x: number, y: number) => void) | null = null;
    private readonly paneView: BubblePaneView;
    private readonly views: IPrimitivePaneView[];
    private requestUpdate: (() => void) | null = null;

    constructor() {
        this.paneView = new BubblePaneView(this);

        /**
         * Stable array reference returned from paneViews() so the library's
         * reference-based cache is not invalidated on every call.
         */
        this.views = [this.paneView];
    }

    /**
     * Lifecycle hook: capture chart/series references and the update callback.
     */
    attached(param: SeriesAttachedParameter<Time>): void {
        this.chart = param.chart;
        this.series = param.series;
        this.requestUpdate = param.requestUpdate;
    }

    /**
     * Lifecycle hook: release references when removed from the chart.
     */
    detached(): void {
        this.chart = null;
        this.series = null;
        this.requestUpdate = null;
    }

    /**
     * Returns the stable pane views array.
     */
    paneViews(): readonly IPrimitivePaneView[] {
        return this.views;
    }

    /**
     * Replaces the full liquidation set and triggers a redraw.
     */
    setLiquidations(liquidations: Liquidation[]): void {
        this.liquidations = liquidations;
        this.requestUpdate?.();
    }

    /**
     * Appends a single liquidation, keeping the array sorted by time, and
     * triggers a redraw. Used for live websocket events.
     */
    addLiquidation(liq: Liquidation): void {
        this.liquidations.push(liq);
        this.requestUpdate?.();
    }

    /**
     * Updates the minimum USD filter and triggers a redraw.
     */
    setMinUsd(minUsd: number): void {
        this.minUsd = minUsd;
        this.requestUpdate?.();
    }

    /**
     * Sets the active timeframe's bar duration in seconds. Liquidation times are
     * snapped down to the start of their bar so they align with candle times,
     * which is required because timeToCoordinate only resolves coordinates for
     * times that match existing bars.
     */
    setBarSeconds(barSeconds: number): void {
        if (barSeconds > 0) {
            this.barSeconds = barSeconds;
            this.requestUpdate?.();
        }
    }

    /**
     * Snaps a millisecond timestamp down to the start of its bar, returning a
     * time in seconds aligned to candle boundaries.
     */
    snapToBar(timeMs: number): number {
        const sec = Math.floor(timeMs / 1000);
        return Math.floor(sec / this.barSeconds) * this.barSeconds;
    }

    /**
     * Returns the liquidations passing the current USD filter.
     */
    getFiltered(): Liquidation[] {
        if (this.minUsd <= 0) {
            return this.liquidations;
        }
        return this.liquidations.filter((l) => l.usd >= this.minUsd);
    }

    /**
     * Stores the bubbles positioned during the last draw, for hit testing.
     */
    setPlaced(placed: PlacedBubble[]): void {
        this.placed = placed;
    }

    /**
     * Registers a handler invoked when the hovered bubble changes. Receives the
     * hovered liquidation (or null) and the cursor coordinates.
     */
    setHoverHandler(handler: (liq: Liquidation | null, x: number, y: number) => void): void {
        this.onHover = handler;
    }

    /**
     * Returns the topmost bubble whose circle contains the given point, or null.
     * Placed bubbles are pre-sorted largest-first so the most significant wins.
     */
    private bubbleAt(x: number, y: number): Liquidation | null {
        for (const b of this.placed) {
            const dx = x - b.x;
            const dy = y - b.y;
            if (dx * dx + dy * dy <= b.radius * b.radius) {
                return b.liq;
            }
        }
        return null;
    }

    /**
     * Hit test called by the chart on cursor movement. Notifies the hover
     * handler and, when a bubble is hit, requests a pointer cursor.
     */
    hitTest(x: number, y: number): PrimitiveHoveredItem | null {
        const hit = this.bubbleAt(x, y);
        this.onHover?.(hit, x, y);
        if (hit === null) {
            return null;
        }
        return {
            cursorStyle: 'pointer',
            externalId: 'liquidation-bubble',
            zOrder: 'top',
        };
    }
}
