/**
 * Telegram history importer.
 *
 * Reads a Telegram Desktop JSON export (result.json) of the "Binance Liquidated
 * Trades" channel, extracts BTC liquidations, and writes them into the same
 * liquidations table used by the live collector. Insert is idempotent, so
 * re-running or overlapping with live data does not create duplicates.
 *
 * Time handling: each message carries date_unixtime, which is a UTC epoch in
 * seconds. Using it avoids any timezone ambiguity from the local "date" string.
 *
 * Run on the VPS with:
 *   npm run build
 *   node dist/import-telegram.js "C:\\path\\to\\result.json"
 */

import { readFileSync } from 'node:fs';
import { openDatabase, Repository } from './db.js';
import { DB_PATH } from './dbpath.js';
import { flattenText, parseLiquidationMessage } from './telegramParse.js';

/**
 * Minimal shape of a Telegram export message that this importer reads.
 */
interface TgMessage {
    type?: string;
    date?: string;
    date_unixtime?: string | number;
    text?: unknown;
}

/**
 * Minimal shape of the Telegram export root for a single chat.
 */
interface TgExport {
    messages?: TgMessage[];
}

/**
 * Resolves a message's time in milliseconds. Prefers date_unixtime (UTC epoch
 * seconds); falls back to parsing the ISO date string if needed.
 */
function messageTimeMs(msg: TgMessage): number {
    if (msg.date_unixtime !== undefined) {
        const sec = Number(msg.date_unixtime);
        if (Number.isFinite(sec)) {
            return sec * 1000;
        }
    }
    if (typeof msg.date === 'string') {
        const ms = Date.parse(msg.date);
        if (Number.isFinite(ms)) {
            return ms;
        }
    }
    return Number.NaN;
}

/**
 * Reads and imports the export file at the given path. Returns counts for a
 * summary.
 */
function importFile(path: string, repo: Repository): { scanned: number; imported: number } {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw) as TgExport;
    const messages = Array.isArray(data.messages) ? data.messages : [];

    let scanned = 0;
    let imported = 0;

    for (const msg of messages) {
        if (msg.type !== undefined && msg.type !== 'message') {
            continue;
        }
        scanned += 1;

        const text = flattenText(msg.text);
        if (text.length === 0) {
            continue;
        }

        const liq = parseLiquidationMessage(text, messageTimeMs(msg));
        if (liq === null) {
            continue;
        }

        repo.insertLiquidation(liq);
        imported += 1;
    }

    return { scanned, imported };
}

/**
 * Entry point: validates arguments, runs the import, prints a summary.
 */
function main(): void {
    const path = process.argv[2];
    if (path === undefined || path.length === 0) {
        process.stderr.write('Usage: node dist/import-telegram.js <path-to-result.json>\n');
        process.exit(1);
        return;
    }

    const db = openDatabase(DB_PATH);
    const repo = new Repository(db);

    process.stdout.write(`Importing BTC liquidations from ${path}\n`);
    const { scanned, imported } = importFile(path, repo);
    process.stdout.write(`Scanned ${scanned} messages, imported ${imported} BTC liquidations.\n`);
    process.stdout.write('Done. Refresh the chart to see imported history.\n');

    db.close();
}

main();
