/**
 * API client for the liquidation backend.
 *
 * REST helpers fetch historical candles, liquidations, and the timeframe list.
 * subscribeLiquidations opens the websocket and invokes a callback for each
 * live liquidation, reconnecting automatically if the socket drops.
 */

import type { Candle, Liquidation, LiquidationMessage, TimeframeInfo } from './types.js';

/**
 * Fetches OHLCV candles for a timeframe. Optional from/to are in seconds.
 */
export async function fetchCandles(
    tf: string,
    from?: number,
    to?: number,
): Promise<Candle[]> {
    const params = new URLSearchParams({ tf });
    if (from !== undefined) {
        params.set('from', String(from));
    }
    if (to !== undefined) {
        params.set('to', String(to));
    }
    const res = await fetch(`/api/candles?${params.toString()}`);
    if (!res.ok) {
        throw new Error(`candles request failed: ${res.status}`);
    }
    return (await res.json()) as Candle[];
}

/**
 * Fetches stored liquidations. Optional from/to are in milliseconds; minUsd
 * filters by notional value.
 */
export async function fetchLiquidations(
    from?: number,
    to?: number,
    minUsd = 0,
): Promise<Liquidation[]> {
    const params = new URLSearchParams({ minUsd: String(minUsd) });
    if (from !== undefined) {
        params.set('from', String(from));
    }
    if (to !== undefined) {
        params.set('to', String(to));
    }
    const res = await fetch(`/api/liquidations?${params.toString()}`);
    if (!res.ok) {
        throw new Error(`liquidations request failed: ${res.status}`);
    }
    return (await res.json()) as Liquidation[];
}

/**
 * Fetches the list of supported timeframes.
 */
export async function fetchTimeframes(): Promise<TimeframeInfo[]> {
    const res = await fetch('/api/timeframes');
    if (!res.ok) {
        throw new Error(`timeframes request failed: ${res.status}`);
    }
    return (await res.json()) as TimeframeInfo[];
}

/**
 * Opens the liquidation websocket and calls onLiquidation for each live event.
 * Returns a disposer that permanently closes the socket and stops reconnecting.
 */
export function subscribeLiquidations(onLiquidation: (liq: Liquidation) => void): () => void {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let closed = false;

    /**
     * Builds the websocket URL from the current page origin, preserving the
     * ws/wss scheme to match http/https.
     */
    const wsUrl = (): string => {
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        return `${proto}://${window.location.host}/ws`;
    };

    /**
     * Opens a socket and wires handlers. On close, schedules a reconnect after
     * a fixed delay unless the subscription has been disposed.
     */
    const connect = (): void => {
        const ws = new WebSocket(wsUrl());
        socket = ws;

        ws.onmessage = (event: MessageEvent): void => {
            try {
                const parsed = JSON.parse(String(event.data)) as LiquidationMessage;
                if (parsed.type === 'liquidation') {
                    onLiquidation(parsed.data);
                }
            } catch {
                /**
                 * Ignore malformed frames rather than breaking the stream.
                 */
            }
        };

        ws.onclose = (): void => {
            socket = null;
            if (!closed) {
                reconnectTimer = window.setTimeout(connect, 2000);
            }
        };

        ws.onerror = (): void => {
            ws.close();
        };
    };

    connect();

    return (): void => {
        closed = true;
        if (reconnectTimer !== null) {
            window.clearTimeout(reconnectTimer);
        }
        if (socket !== null) {
            socket.close();
        }
    };
}
