/**
 * Persistence of UI settings and per-timeframe chart scale in localStorage.
 *
 * Settings (timeframe, USD filter, refresh interval) are stored as a single
 * JSON object. The chart's visible logical range is stored per timeframe so
 * each timeframe restores its own zoom and scroll position. All reads are
 * defensive: malformed or missing values fall back to provided defaults, so a
 * corrupted entry never breaks startup.
 */

import type { Timeframe } from './types.js';

/**
 * Shape of the persisted settings bundle.
 */
export interface PersistedSettings {
    timeframe: Timeframe;
    minUsd: number;
    refreshMs: number;
}

/**
 * A saved visible logical range for a chart (bar-index based).
 */
export interface SavedRange {
    from: number;
    to: number;
}

/**
 * localStorage keys. Namespaced to avoid collisions with anything else.
 */
const SETTINGS_KEY = 'btcliq.settings';
const RANGE_PREFIX = 'btcliq.range.';

/**
 * Reads a JSON value from localStorage, returning null on any failure
 * (missing, unparsable, or storage unavailable).
 */
function readJson<T>(key: string): T | null {
    try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) {
            return null;
        }
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/**
 * Writes a JSON value to localStorage, ignoring failures (e.g. storage full or
 * disabled) so persistence never interrupts the app.
 */
function writeJson(key: string, value: unknown): void {
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        /**
         * Ignore write failures; persistence is best-effort.
         */
    }
}

/**
 * The set of valid timeframes, used to validate persisted values.
 */
const VALID_TIMEFRAMES: readonly Timeframe[] = ['5m', '15m', '1h', '4h', '1d'];

/**
 * Loads persisted settings, validating each field and falling back to the
 * provided defaults for anything missing or invalid.
 */
export function loadSettings(defaults: PersistedSettings): PersistedSettings {
    const saved = readJson<Partial<PersistedSettings>>(SETTINGS_KEY);
    if (saved === null) {
        return defaults;
    }

    const timeframe =
        typeof saved.timeframe === 'string' && VALID_TIMEFRAMES.includes(saved.timeframe as Timeframe)
            ? (saved.timeframe as Timeframe)
            : defaults.timeframe;
    const minUsd =
        typeof saved.minUsd === 'number' && Number.isFinite(saved.minUsd) && saved.minUsd >= 0
            ? saved.minUsd
            : defaults.minUsd;
    const refreshMs =
        typeof saved.refreshMs === 'number' && Number.isFinite(saved.refreshMs) && saved.refreshMs > 0
            ? saved.refreshMs
            : defaults.refreshMs;

    return { timeframe, minUsd, refreshMs };
}

/**
 * Persists the settings bundle.
 */
export function saveSettings(settings: PersistedSettings): void {
    writeJson(SETTINGS_KEY, settings);
}

/**
 * Loads the saved visible range for a timeframe, or null if none/invalid.
 */
export function loadRange(timeframe: Timeframe): SavedRange | null {
    const saved = readJson<Partial<SavedRange>>(RANGE_PREFIX + timeframe);
    if (
        saved === null ||
        typeof saved.from !== 'number' ||
        typeof saved.to !== 'number' ||
        !Number.isFinite(saved.from) ||
        !Number.isFinite(saved.to) ||
        saved.to <= saved.from
    ) {
        return null;
    }
    return { from: saved.from, to: saved.to };
}

/**
 * Persists the visible range for a timeframe.
 */
export function saveRange(timeframe: Timeframe, range: SavedRange): void {
    writeJson(RANGE_PREFIX + timeframe, range);
}
