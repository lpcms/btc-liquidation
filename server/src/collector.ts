/**
 * Liquidation collector.
 *
 * Maintains a persistent websocket connection to the Binance USDⓈ-M futures
 * market stream for BTCUSDT forced liquidations, normalizes each event, and
 * writes it to the repository. Newly stored liquidations are emitted via a
 * callback so the API layer can push them to connected clients in real time.
 *
 * Connection rules implemented per Binance documentation:
 *  - The server sends a ping frame every 3 minutes; if no pong is received
 *    within 10 minutes the connection is dropped. The 'ws' library answers
 *    pings with pongs automatically, so no manual keep-alive is required.
 *  - On any close or error the collector reconnects with capped exponential
 *    backoff. A liquidation stream is silent when no liquidations occur, so a
 *    long quiet period is normal and must not be treated as a failure.
 *  - The stream is a snapshot: for each symbol Binance pushes only the latest
 *    liquidation within every 1000 ms window. When several liquidations happen
 *    within one second, the earlier ones are never sent, so the stored live
 *    data is a sample of the flow, not a complete record.
 */

import WebSocket from 'ws';
import type {
    BinanceForceOrderEvent,
    Liquidation,
} from './types.js';
import { orderSideToPositionSide, Repository } from './db.js';

/**
 * BTCUSDT liquidation stream on the routed Market endpoint.
 * Per Binance's WebSocket base-URL split, @forceOrder belongs to the Market
 * category. Legacy unrouted /ws URLs were decommissioned on 2026-04-23 and only
 * serve /public streams, so the stream must be requested via /market/ws to
 * receive any data.
 */
const STREAM_URL = 'wss://fstream.binance.com/market/ws/btcusdt@forceOrder';

/**
 * Minimum and maximum reconnect delays in milliseconds for exponential backoff.
 */
const MIN_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;

/**
 * Callback invoked with each newly persisted liquidation.
 */
export type OnLiquidation = (liq: Liquidation) => void;

/**
 * Manages the lifecycle of the Binance liquidation websocket.
 */
export class LiquidationCollector {
    private readonly repo: Repository;
    private readonly onLiquidation: OnLiquidation;
    private ws: WebSocket | null = null;
    private reconnectDelay = MIN_RECONNECT_MS;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private stopped = false;

    constructor(repo: Repository, onLiquidation: OnLiquidation) {
        this.repo = repo;
        this.onLiquidation = onLiquidation;
    }

    /**
     * Opens the websocket and wires up event handlers. Safe to call once at
     * startup; reconnection is handled internally.
     */
    start(): void {
        this.stopped = false;
        this.connect();
    }

    /**
     * Permanently stops the collector and closes any open socket.
     */
    stop(): void {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
        }
    }

    /**
     * Establishes a new websocket connection and attaches handlers.
     */
    private connect(): void {
        const ws = new WebSocket(STREAM_URL);
        this.ws = ws;

        ws.on('open', () => {
            /**
             * Reset backoff once a connection is successfully established.
             */
            this.reconnectDelay = MIN_RECONNECT_MS;
        });

        ws.on('message', (data: WebSocket.RawData) => {
            this.handleMessage(data);
        });

        ws.on('error', () => {
            /**
             * Errors are followed by a close event; reconnection is scheduled there.
             * The socket is closed defensively to ensure the close path runs.
             */
            ws.close();
        });

        ws.on('close', () => {
            this.ws = null;
            this.scheduleReconnect();
        });
    }

    /**
     * Parses one raw websocket message and persists a valid liquidation event.
     * Malformed or unexpected payloads are ignored rather than throwing, so a
     * single bad frame cannot kill the collector.
     */
    private handleMessage(data: WebSocket.RawData): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(data.toString());
        } catch {
            return;
        }

        const liq = normalizeForceOrder(parsed);
        if (!liq) {
            return;
        }

        this.repo.insertLiquidation(liq);
        this.onLiquidation(liq);
    }

    /**
     * Schedules a reconnect using exponential backoff unless the collector has
     * been explicitly stopped.
     */
    private scheduleReconnect(): void {
        if (this.stopped) {
            return;
        }
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }
}

/**
 * Validates and normalizes a parsed websocket payload into a Liquidation.
 * Returns null when the payload is not a well-formed forceOrder event or when
 * derived numeric fields are not finite.
 */
export function normalizeForceOrder(payload: unknown): Liquidation | null {
    if (typeof payload !== 'object' || payload === null) {
        return null;
    }

    const event = payload as Partial<BinanceForceOrderEvent>;
    if (event.e !== 'forceOrder' || typeof event.o !== 'object' || event.o === null) {
        return null;
    }

    const order = event.o;
    if (order.S !== 'BUY' && order.S !== 'SELL') {
        return null;
    }

    const price = Number(order.ap);
    const qty = Number(order.z);
    const time = Number(order.T);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || !Number.isFinite(time)) {
        return null;
    }
    if (price <= 0 || qty <= 0) {
        return null;
    }

    return {
        time,
        side: orderSideToPositionSide(order.S),
        price,
        qty,
        usd: price * qty,
    };
}
