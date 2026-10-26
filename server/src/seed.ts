/**
 * Liquidation seed.
 *
 * A gzip-compressed CSV archive of liquidations, committed to the repository as
 * server/data/liquidations.csv.gz, so the collected and imported history is
 * kept and can be loaded into any installation on demand. It is not loaded
 * automatically, since years of events make the chart heavy. Candles are not
 * part of the seed: they are re-downloaded from Binance.
 *
 * Numbers are written in JavaScript's shortest round-trip form, so an imported
 * row is bit-identical to the exported one. Because the liquidations primary
 * key is (time, side, price, qty), importing the seed into a database that
 * already holds those rows adds nothing.
 *
 * The seed is an archive that only grows: export merges the database into the
 * existing seed rather than replacing it, so history that was cleared from a
 * local database to keep the chart light is never lost from the seed.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Repository } from './db.js';
import type { Liquidation } from './types.js';

/**
 * CSV header line; also used to validate a seed file on import.
 */
const HEADER = 'time,side,price,qty,usd';

/**
 * Converts one CSV line into a Liquidation, or null if the line is malformed.
 */
function parseRow(line: string): Liquidation | null {
    const cols = line.split(',');
    if (cols.length !== 5) {
        return null;
    }
    const [timeRaw, side, priceRaw, qtyRaw, usdRaw] = cols;
    if (side !== 'LONG' && side !== 'SHORT') {
        return null;
    }
    const time = Number(timeRaw);
    const price = Number(priceRaw);
    const qty = Number(qtyRaw);
    const usd = Number(usdRaw);
    if (![time, price, qty, usd].every(Number.isFinite)) {
        return null;
    }
    return { time, side, price, qty, usd };
}

/**
 * Identity of a liquidation, matching the table's primary key.
 */
function keyOf(liq: Liquidation): string {
    return `${liq.time}|${liq.side}|${liq.price}|${liq.qty}`;
}

/**
 * Reads and parses a seed file. Malformed lines are skipped.
 */
function readSeed(path: string): Liquidation[] {
    const csv = gunzipSync(readFileSync(path)).toString('utf8');
    const lines = csv.split('\n');
    if (lines[0] !== HEADER) {
        throw new Error(`unexpected seed header in ${path}`);
    }

    const rows: Liquidation[] = [];
    for (const line of lines.slice(1)) {
        const liq = parseRow(line);
        if (liq !== null) {
            rows.push(liq);
        }
    }
    return rows;
}

/**
 * Merges every stored liquidation into the seed at the given path (created if
 * missing), oldest first and without duplicates. Returns the total number of
 * rows in the seed and how many of them the database contributed.
 */
export function exportSeed(repo: Repository, path: string): { total: number; added: number } {
    const merged = new Map<string, Liquidation>();
    if (existsSync(path)) {
        for (const liq of readSeed(path)) {
            merged.set(keyOf(liq), liq);
        }
    }

    const before = merged.size;
    for (const liq of repo.getLiquidations(0, Number.MAX_SAFE_INTEGER, 0)) {
        merged.set(keyOf(liq), liq);
    }

    const rows = [...merged.values()].sort((a, b) => a.time - b.time);
    const lines = rows.map((l) => `${l.time},${l.side},${l.price},${l.qty},${l.usd}`);
    const csv = `${HEADER}\n${lines.join('\n')}\n`;

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, gzipSync(csv, { level: 9 }));
    return { total: rows.length, added: rows.length - before };
}

/**
 * Imports a seed file into the liquidations table in one transaction.
 * Returns the number of rows read and the number actually added.
 */
export function importSeed(repo: Repository, path: string): { read: number; added: number } {
    const rows = readSeed(path);
    const added = repo.insertLiquidations(rows);
    return { read: rows.length, added };
}
