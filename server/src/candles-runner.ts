/**
 * Step 2 entrypoint: candle backfill.
 *
 * Opens the database, backfills (or incrementally updates) candles for every
 * configured timeframe from the Binance REST API, then prints a per-timeframe
 * summary so the operator can confirm coverage. Safe to re-run: subsequent runs
 * only fetch bars newer than what is already stored.
 *
 * Run on the VPS with: npm run build && node dist/candles-runner.js
 */

import { openDatabase, Repository } from './db.js';
import { backfillAllCandles } from './candles.js';
import { allTimeframes } from './timeframes.js';
import { DB_PATH } from './dbpath.js';

/**
 * Backfills candles and reports stored coverage per timeframe.
 */
async function main(): Promise<void> {
    const db = openDatabase(DB_PATH);
    const repo = new Repository(db);

    await backfillAllCandles(repo);

    process.stdout.write('\nStored coverage:\n');
    for (const cfg of allTimeframes()) {
        const latest = repo.getLatestCandleTime(cfg.interval);
        const rows = repo.getCandles(cfg.interval, 0, Math.floor(Date.now() / 1000));
        const first = rows.length > 0 ? new Date(rows[0].time * 1000).toISOString() : 'n/a';
        const last = latest !== null ? new Date(latest * 1000).toISOString() : 'n/a';
        process.stdout.write(`  ${cfg.interval.padEnd(3)}  bars=${rows.length}  from=${first}  to=${last}\n`);
    }

    db.close();
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Backfill failed: ${message}\n`);
    process.exit(1);
});
