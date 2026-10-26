/**
 * Step 1 entrypoint: liquidation collector smoke test.
 *
 * Opens the database, starts the Binance liquidation collector, and reports
 * each persisted liquidation to stdout so the operator can confirm that live
 * data is being received and written. This file is the standalone collector
 * runner; once the API layer is added it will be superseded by the full server
 * entrypoint.
 *
 * Run on the VPS with: npm run build && node dist/collector-runner.js
 */

import { LiquidationCollector } from './collector.js';
import { openDatabase, Repository } from './db.js';
import type { Liquidation } from './types.js';
import { DB_PATH } from './dbpath.js';

/**
 * Formats a liquidation as a single human-readable status line.
 */
function formatLiquidation(liq: Liquidation): string {
    const ts = new Date(liq.time).toISOString();
    const usd = Math.round(liq.usd).toLocaleString('en-US');
    return `${ts}  ${liq.side.padEnd(5)}  price=${liq.price}  qty=${liq.qty}  usd=$${usd}`;
}

/**
 * Wires up the collector and keeps the process alive until interrupted.
 */
function main(): void {
    const db = openDatabase(DB_PATH);
    const repo = new Repository(db);

    let count = 0;
    const collector = new LiquidationCollector(repo, (liq) => {
        count += 1;
        process.stdout.write(`[#${count}] ${formatLiquidation(liq)}\n`);
    });

    collector.start();
    process.stdout.write('Collector started. Waiting for BTCUSDT liquidations (stream is silent when none occur)...\n');

    /**
     * Graceful shutdown on Ctrl+C so the database is closed cleanly.
     */
    process.on('SIGINT', () => {
        process.stdout.write('\nShutting down...\n');
        collector.stop();
        db.close();
        process.exit(0);
    });
}

main();
