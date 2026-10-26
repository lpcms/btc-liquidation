/**
 * Time formatting in the Europe/Kyiv timezone.
 *
 * All formatting uses the built-in Intl.DateTimeFormat with an explicit
 * timeZone, so daylight saving (EEST, UTC+3 in summer; EET, UTC+2 in winter)
 * is handled automatically without external libraries. Chart data keeps its
 * original UTC-based timestamps; only the displayed labels are converted.
 */

/**
 * Target timezone for all displayed times.
 */
const TZ = 'Europe/Kyiv';

/**
 * Formatter for axis tick labels showing hours and minutes (e.g. "18:00").
 */
const hourMinute = new Intl.DateTimeFormat('uk-UA', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});

/**
 * Formatter for axis tick labels on daily and higher timeframes, showing day
 * and short month (e.g. "26 чер").
 */
const dayMonth = new Intl.DateTimeFormat('uk-UA', {
    timeZone: TZ,
    day: '2-digit',
    month: 'short',
});

/**
 * Extracts the numeric value of a given part from an Intl formatToParts result.
 */
function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
    const found = parts.find((p) => p.type === type);
    return found ? found.value : '';
}

/**
 * Full date-time formatter producing parts for DD.MM.YYYY HH:MM:SS in Kyiv time.
 * Built from parts so the exact "DD.MM.YYYY, HH:MM:SS" layout is guaranteed
 * regardless of locale punctuation.
 */
const fullParts = new Intl.DateTimeFormat('uk-UA', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
});

/**
 * Formats a millisecond timestamp as "DD.MM.YYYY, HH:MM:SS" in Kyiv time.
 */
export function formatKyivFull(ms: number): string {
    const parts = fullParts.formatToParts(new Date(ms));
    const day = part(parts, 'day');
    const month = part(parts, 'month');
    const year = part(parts, 'year');
    const hour = part(parts, 'hour');
    const minute = part(parts, 'minute');
    const second = part(parts, 'second');
    return `${day}.${month}.${year}, ${hour}:${minute}:${second}`;
}

/**
 * Formats a seconds timestamp as an hour:minute axis label in Kyiv time.
 */
export function formatKyivHourMinute(seconds: number): string {
    return hourMinute.format(new Date(seconds * 1000));
}

/**
 * Formats a seconds timestamp as a day + short-month axis label in Kyiv time.
 */
export function formatKyivDayMonth(seconds: number): string {
    return dayMonth.format(new Date(seconds * 1000));
}
