/**
 * Candle backfill and incremental update from the Binance USDⓈ-M futures
 * REST API (GET /fapi/v1/klines).
 *
 * Per the Binance documentation the klines endpoint returns at most 1500 bars
 * per request and each bar is an array:
 *   [ openTimeMs, open, high, low, close, volume, closeTimeMs, ... ]
 * Pagination walks forward by setting startTime to just after the last
 * received bar's open time until the present is reached.
 *
 * On first run for a timeframe the loader fetches the full configured history.
 * On subsequent runs it fetches only bars newer than the latest stored bar,
 * so restarts are cheap and the cache stays current.
 */

import type { Candle, Timeframe } from './types.js';
import type { Repository } from './db.js';
import { allTimeframes, type TimeframeConfig } from './timeframes.js';

/**
 * Base REST host for USDⓈ-M futures market data.
 */
const REST_BASE = 'https://fapi.binance.com';

/**
 * Trading symbol for all candle requests.
 */
const SYMBOL = 'BTCUSDT';

/**
 * Maximum bars returned by the klines endpoint in a single request.
 */
const MAX_LIMIT = 1500;

/**
 * Delay between paginated requests in milliseconds, a courtesy throttle to stay
 * well under Binance request-weight limits during a large backfill.
 */
const REQUEST_SPACING_MS = 300;

/**
 * Shape of a single raw kline row as returned by Binance. Only positional
 * access is used; the tuple documents the fields consumed.
 */
type RawKline = [
    number, // open time (ms)
    string, // open
    string, // high
    string, // low
    string, // close
    string, // volume
    number, // close time (ms)
    ...unknown[],
];

/**
 * Sleeps for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Converts a raw Binance kline row into a normalized Candle.
 * Open time is converted from milliseconds to seconds for the chart layer.
 * Returns null if any required numeric field is malformed.
 */
function rawToCandle(row: RawKline): Candle | null {
    const time = Math.floor(Number(row[0]) / 1000);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);

    const values = [time, open, high, low, close, volume];
    if (values.some((v) => !Number.isFinite(v))) {
        return null;
    }
    return { time, open, high, low, close, volume };
}

/**
 * Fetches a single page of klines starting at startTimeMs.
 * Throws on HTTP error or unexpected response shape so the caller can decide
 * whether to retry or abort.
 */
async function fetchKlinePage(interval: Timeframe, startTimeMs: number): Promise<RawKline[]> {
    const url = new URL(`${REST_BASE}/fapi/v1/klines`);
    url.searchParams.set('symbol', SYMBOL);
    url.searchParams.set('interval', interval);
    url.searchParams.set('startTime', String(startTimeMs));
    url.searchParams.set('limit', String(MAX_LIMIT));

    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
        throw new Error(`klines request failed: ${res.status} ${res.statusText}`);
    }

    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
        throw new Error('klines response was not an array');
    }
    return body as RawKline[];
}

/**
 * Backfills or updates a single timeframe.
 *
 * Determines the starting point: the bar after the latest stored bar if any
 * exist, otherwise historyDays before now. Then paginates forward to the
 * present, persisting each page. Returns the number of bars written.
 */
async function loadTimeframe(repo: Repository, cfg: TimeframeConfig): Promise<number> {
    const nowMs = Date.now();
    const latestStored = repo.getLatestCandleTime(cfg.interval);

    /**
     * Choose the first open time to request. When bars already exist, resume
     * one bar past the newest stored bar; the last stored bar may have been
     * incomplete, so re-requesting from there via REPLACE keeps it accurate.
     */
    let startMs: number;
    if (latestStored !== null) {
        startMs = latestStored * 1000;
    } else {
        startMs = nowMs - cfg.historyDays * 86400 * 1000;
    }

    let written = 0;
    let pages = 0;

    while (true) {
        const page = await fetchKlinePage(cfg.interval, startMs);
        if (page.length === 0) {
            break;
        }

        const candles: Candle[] = [];
        for (const row of page) {
            const candle = rawToCandle(row);
            if (candle !== null) {
                candles.push(candle);
            }
        }

        if (candles.length > 0) {
            repo.upsertCandles(cfg.interval, candles);
            written += candles.length;
        }

        pages += 1;

        /**
         * Advance to one millisecond past the last bar's open time to request
         * the next page without re-fetching the boundary bar repeatedly.
         */
        const lastOpenMs = Number(page[page.length - 1][0]);
        const nextStartMs = lastOpenMs + 1;

        /**
         * Termination: a short page means we have reached the most recent data,
         * or the next start would be in the future.
         */
        if (page.length < MAX_LIMIT || nextStartMs >= nowMs) {
            break;
        }

        startMs = nextStartMs;
        await sleep(REQUEST_SPACING_MS);
    }

    process.stdout.write(`  ${cfg.interval}: wrote ${written} bars over ${pages} page(s)\n`);
    return written;
}

/**
 * Runs backfill/update for every configured timeframe in sequence.
 * Sequential execution keeps total request weight low and predictable.
 */
export async function backfillAllCandles(repo: Repository): Promise<void> {
    process.stdout.write('Backfilling candles...\n');
    for (const cfg of allTimeframes()) {
        await loadTimeframe(repo, cfg);
    }
    process.stdout.write('Candle backfill complete.\n');
}

/**
 * Updates every timeframe once without the verbose per-timeframe logging used
 * by the initial backfill. Intended for the periodic refresh loop. Errors are
 * swallowed so a transient network hiccup does not stop the interval.
 */
async function refreshAllCandlesQuiet(repo: Repository): Promise<void> {
    for (const cfg of allTimeframes()) {
        try {
            await loadTimeframe(repo, cfg);
        } catch {
            /**
             * Ignore a single failed refresh; the next tick will retry.
             */
        }
    }
}

/**
 * Starts a periodic candle refresh on a fixed interval and returns a stop
 * function. Each tick re-fetches recent bars for all timeframes, which updates
 * the still-forming current bar (its high/low/close) and appends newly closed
 * bars. The first tick runs after the interval, since startup already backfills.
 */
export function startCandleRefresh(repo: Repository, intervalMs: number): () => void {
    const timer = setInterval(() => {
        void refreshAllCandlesQuiet(repo);
    }, intervalMs);

    return (): void => {
        clearInterval(timer);
    };
}
