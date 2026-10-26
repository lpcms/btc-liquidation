/**
 * Resolves the SQLite database path relative to the server folder rather than
 * the current working directory, so the database is always server/btc-liq.db
 * regardless of where the process is started from (server folder or repo root).
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Absolute path to the compiled dist directory of this module.
 */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the SQLite database file, one level up from dist.
 */
export const DB_PATH = join(here, '..', 'btc-liq.db');
