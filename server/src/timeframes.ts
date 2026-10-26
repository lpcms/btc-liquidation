/**
 * Timeframe configuration.
 *
 * For each supported timeframe this defines:
 *  - barSeconds: the duration of one candle in seconds, used to compute how
 *    many bars a backfill window spans and to align timestamps.
 *  - historyDays: how far back the initial backfill reaches, per the agreed
 *    retention policy (shorter history for finer timeframes).
 */

import type { Timeframe } from './types.js';

/**
 * Static description of a timeframe.
 */
export interface TimeframeConfig {
    /**
     * Binance kline interval string. Identical to the Timeframe key but kept
     * explicit for clarity at call sites.
     */
    interval: Timeframe;
    /**
     * Duration of one candle in seconds.
     */
    barSeconds: number;
    /**
     * Number of days of history to backfill on first run.
     */
    historyDays: number;
}

/**
 * Number of seconds in one day.
 */
const DAY_SECONDS = 86400;

/**
 * The complete set of supported timeframes and their retention policy.
 * 5m and 15m keep two months; hourly and above keep one year.
 */
export const TIMEFRAMES: Record<Timeframe, TimeframeConfig> = {
    '5m': { interval: '5m', barSeconds: 5 * 60, historyDays: 60 },
    '15m': { interval: '15m', barSeconds: 15 * 60, historyDays: 60 },
    '1h': { interval: '1h', barSeconds: 60 * 60, historyDays: 365 },
    '4h': { interval: '4h', barSeconds: 4 * 60 * 60, historyDays: 365 },
    '1d': { interval: '1d', barSeconds: DAY_SECONDS, historyDays: 365 },
};

/**
 * Returns all configured timeframes as an array, useful for iterating during
 * backfill.
 */
export function allTimeframes(): TimeframeConfig[] {
    return Object.values(TIMEFRAMES);
}
