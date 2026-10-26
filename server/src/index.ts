/**
 * Unified production entrypoint.
 *
 * Startup sequence:
 *   1. Open the database.
 *   2. Incrementally update candles (fast delta fetch on each boot).
 *   3. Start the liquidation collector, pushing each new liquidation to both
 *      the database (via the collector) and connected clients (via the hub).
 *   4. Serve the REST API, the client websocket, and the built frontend on a
 *      single port bound to localhost.
 *
 * Run on the VPS with: npm run build && node dist/index.js
 * Intended to run under pm2 for restart-on-crash and boot persistence.
 */

import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase, Repository } from './db.js';
import { backfillAllCandles, startCandleRefresh } from './candles.js';
import { LiquidationCollector } from './collector.js';
import { ClientHub } from './hub.js';
import { createApiRouter } from './api.js';
import { DB_PATH } from './dbpath.js';

/**
 * Port and host. Binding to 127.0.0.1 keeps the service local-only.
 */
const PORT = 3000;
const HOST = '127.0.0.1';

/**
 * Absolute path to this file's directory, used to resolve the static frontend
 * build relative to the compiled output rather than the current working
 * directory.
 */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Location of the built frontend. The Vite build is copied to ../public
 * relative to the compiled dist directory during packaging.
 */
const STATIC_DIR = join(here, '..', 'public');

/**
 * Boots the full service.
 */
async function main(): Promise<void> {
    const db = openDatabase(DB_PATH);
    const repo = new Repository(db);

    /**
     * Update candles before serving so the chart opens with current data.
     * Failure here should not prevent the server from starting with whatever
     * history is already cached.
     */
    try {
        await backfillAllCandles(repo);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Candle update failed, serving cached data: ${message}\n`);
    }

    const app = express();
    app.use('/api', createApiRouter(repo));

    /**
     * Serve the built frontend if present. The service still runs as an API
     * if the frontend has not been built yet.
     */
    app.use(express.static(STATIC_DIR));

    const server = createServer(app);
    const hub = new ClientHub(server);

    /**
     * The collector writes to the DB and forwards each liquidation to the hub
     * for live broadcast to browsers.
     */
    const collector = new LiquidationCollector(repo, (liq) => {
        hub.broadcast(liq);
    });
    collector.start();

    /**
     * Refresh candles once a minute so the current (still-forming) bar updates
     * and newly closed bars are appended while the server runs.
     */
    const stopRefresh = startCandleRefresh(repo, 60_000);

    server.listen(PORT, HOST, () => {
        process.stdout.write(`Server listening on http://${HOST}:${PORT}\n`);
        process.stdout.write('Collector running; candles refresh every 60s.\n');
    });

    /**
     * Graceful shutdown: stop accepting connections, stop the collector and the
     * candle refresh, close the database.
     */
    const shutdown = (): void => {
        process.stdout.write('\nShutting down...\n');
        collector.stop();
        stopRefresh();
        hub.close();
        server.close(() => {
            db.close();
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal startup error: ${message}\n`);
    process.exit(1);
});
