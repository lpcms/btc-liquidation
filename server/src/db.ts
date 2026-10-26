/**
 * SQLite persistence layer using better-sqlite3.
 *
 * Two tables:
 *  - liquidations: one row per raw liquidation event. Raw storage lets the
 *    client switch timeframes without losing granularity; aggregation happens
 *    at query time on the frontend or in the API layer.
 *  - candles: cached OHLCV bars per timeframe, keyed by (timeframe, time).
 *
 * All writes go through prepared statements. Inserts are idempotent via
 * INSERT OR IGNORE / INSERT OR REPLACE so re-running backfills is safe.
 */

import Database from 'better-sqlite3';
import type { Candle, Liquidation, LiquidationSide, Timeframe } from './types.js';

/**
 * Opens (or creates) the SQLite database at the given path and ensures the
 * schema and pragmas are applied. WAL mode is enabled for concurrent read
 * performance while the collector writes continuously.
 */
export function openDatabase(path: string): Database.Database {
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    createSchema(db);
    return db;
}

/**
 * Creates tables and indexes if they do not already exist.
 */
function createSchema(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS liquidations (
            time  INTEGER NOT NULL,
            side  TEXT    NOT NULL,
            price REAL    NOT NULL,
            qty   REAL    NOT NULL,
            usd   REAL    NOT NULL,
            PRIMARY KEY (time, side, price, qty)
        );

        CREATE INDEX IF NOT EXISTS idx_liquidations_time ON liquidations (time);

        CREATE TABLE IF NOT EXISTS candles (
            timeframe TEXT    NOT NULL,
            time      INTEGER NOT NULL,
            open      REAL    NOT NULL,
            high      REAL    NOT NULL,
            low       REAL    NOT NULL,
            close     REAL    NOT NULL,
            volume    REAL    NOT NULL,
            PRIMARY KEY (timeframe, time)
        );
    `);
}

/**
 * Repository wrapping all prepared statements for the application.
 * Constructed once at startup and shared across the collector and API.
 */
export class Repository {
    private readonly db: Database.Database;
    private readonly insertLiquidationStmt: Database.Statement;
    private readonly selectLiquidationsStmt: Database.Statement;
    private readonly upsertCandleStmt: Database.Statement;
    private readonly selectCandlesStmt: Database.Statement;
    private readonly latestCandleTimeStmt: Database.Statement;

    constructor(db: Database.Database) {
        this.db = db;

        this.insertLiquidationStmt = db.prepare(`
            INSERT OR IGNORE INTO liquidations (time, side, price, qty, usd)
            VALUES (@time, @side, @price, @qty, @usd)
        `);

        this.selectLiquidationsStmt = db.prepare(`
            SELECT time, side, price, qty, usd
            FROM liquidations
            WHERE time >= @from AND time <= @to AND usd >= @minUsd
            ORDER BY time ASC
        `);

        this.upsertCandleStmt = db.prepare(`
            INSERT OR REPLACE INTO candles (timeframe, time, open, high, low, close, volume)
            VALUES (@timeframe, @time, @open, @high, @low, @close, @volume)
        `);

        this.selectCandlesStmt = db.prepare(`
            SELECT time, open, high, low, close, volume
            FROM candles
            WHERE timeframe = @timeframe AND time >= @from AND time <= @to
            ORDER BY time ASC
        `);

        this.latestCandleTimeStmt = db.prepare(`
            SELECT MAX(time) AS maxTime
            FROM candles
            WHERE timeframe = @timeframe
        `);
    }

    /**
     * Inserts a single liquidation. Duplicate events (same time/side/price/qty)
     * are silently ignored to keep the store idempotent.
     */
    insertLiquidation(liq: Liquidation): void {
        this.insertLiquidationStmt.run(liq);
    }

    /**
     * Inserts a batch of liquidations inside a single transaction, ignoring
     * duplicates like insertLiquidation. Returns the number of new rows.
     */
    insertLiquidations(liquidations: Liquidation[]): number {
        const run = this.db.transaction((rows: Liquidation[]) => {
            let added = 0;
            for (const liq of rows) {
                added += this.insertLiquidationStmt.run(liq).changes;
            }
            return added;
        });
        return run(liquidations);
    }

    /**
     * Returns liquidations within a time range whose USD notional meets or
     * exceeds the given minimum. Times are in milliseconds.
     */
    getLiquidations(from: number, to: number, minUsd: number): Liquidation[] {
        return this.selectLiquidationsStmt.all({ from, to, minUsd }) as Liquidation[];
    }

    /**
     * Inserts or replaces a batch of candles for one timeframe inside a single
     * transaction for throughput during backfills.
     */
    upsertCandles(timeframe: Timeframe, candles: Candle[]): void {
        const run = this.db.transaction((rows: Candle[]) => {
            for (const c of rows) {
                this.upsertCandleStmt.run({ timeframe, ...c });
            }
        });
        run(candles);
    }

    /**
     * Returns cached candles for a timeframe within a time range.
     * Times are in seconds.
     */
    getCandles(timeframe: Timeframe, from: number, to: number): Candle[] {
        return this.selectCandlesStmt.all({ timeframe, from, to }) as Candle[];
    }

    /**
     * Returns the open time (seconds) of the most recent cached candle for a
     * timeframe, or null if none are stored yet.
     */
    getLatestCandleTime(timeframe: Timeframe): number | null {
        const row = this.latestCandleTimeStmt.get({ timeframe }) as { maxTime: number | null };
        return row.maxTime ?? null;
    }
}

/**
 * Maps a Binance order side to the liquidated position side.
 * A SELL liquidation order closes a LONG; a BUY liquidation order closes a SHORT.
 */
export function orderSideToPositionSide(orderSide: 'BUY' | 'SELL'): LiquidationSide {
    return orderSide === 'SELL' ? 'LONG' : 'SHORT';
}
