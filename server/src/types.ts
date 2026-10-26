/**
 * Shared domain types for the BTC liquidation service.
 * These describe the normalized shapes stored in SQLite and sent to the client,
 * plus the raw payloads received from the Binance Futures API.
 */

/**
 * Liquidation side as stored internally.
 * On Binance the forceOrder "S" field is the side of the liquidation order itself:
 * a SELL order liquidates a LONG position, a BUY order liquidates a SHORT position.
 */
export type LiquidationSide = 'LONG' | 'SHORT';

/**
 * A single normalized liquidation event as persisted in the database
 * and broadcast to clients.
 */
export interface Liquidation {
    /**
     * Order trade time in milliseconds since epoch (Binance "T" field).
     * Used as the primary ordering key.
     */
    time: number;
    /**
     * The liquidated position side, derived from the order side.
     */
    side: LiquidationSide;
    /**
     * Average fill price of the liquidation order (Binance "ap" field).
     */
    price: number;
    /**
     * Filled quantity in BTC (Binance "z" field, accumulated filled quantity).
     */
    qty: number;
    /**
     * Notional value of the liquidation in USDT, computed as price * qty.
     * Stored explicitly so the client can filter by dollar amount without recompute.
     */
    usd: number;
}

/**
 * A single OHLCV candle. Time is the candle open time in SECONDS since epoch,
 * which is the unit Lightweight Charts expects for its time axis.
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
 * Raw inner order object of a Binance forceOrder websocket event.
 * Only the fields consumed by this service are declared.
 */
export interface BinanceForceOrderInner {
    /**
     * Symbol, e.g. "BTCUSDT".
     */
    s: string;
    /**
     * Order side: "BUY" or "SELL".
     */
    S: 'BUY' | 'SELL';
    /**
     * Average price as a string.
     */
    ap: string;
    /**
     * Order filled accumulated quantity as a string.
     */
    z: string;
    /**
     * Order trade time in milliseconds.
     */
    T: number;
}

/**
 * Raw Binance forceOrder websocket event envelope.
 */
export interface BinanceForceOrderEvent {
    /**
     * Event type, expected to be "forceOrder".
     */
    e: string;
    /**
     * Event time in milliseconds.
     */
    E: number;
    /**
     * The liquidation order details.
     */
    o: BinanceForceOrderInner;
}

/**
 * Supported chart timeframes. Values match Binance kline interval strings.
 */
export type Timeframe = '5m' | '15m' | '1h' | '4h' | '1d';
