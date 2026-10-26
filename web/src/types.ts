/**
 * Frontend domain types. These mirror the shapes returned by the backend API
 * and pushed over the websocket, kept in sync with the server's types module.
 */

/**
 * Liquidated position side.
 */
export type LiquidationSide = 'LONG' | 'SHORT';

/**
 * A normalized liquidation event as received from the API or websocket.
 * Time is in milliseconds since epoch.
 */
export interface Liquidation {
    time: number;
    side: LiquidationSide;
    price: number;
    qty: number;
    usd: number;
}

/**
 * An OHLCV candle. Time is in seconds since epoch, matching Lightweight Charts.
 */
export interface Candle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

/**
 * Supported chart timeframes.
 */
export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d';

/**
 * Timeframe descriptor returned by GET /api/timeframes.
 */
export interface TimeframeInfo {
    interval: Timeframe;
    barSeconds: number;
}

/**
 * Websocket message envelope pushed by the server for live liquidations.
 */
export interface LiquidationMessage {
    type: 'liquidation';
    data: Liquidation;
}
