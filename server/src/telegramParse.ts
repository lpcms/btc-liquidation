/**
 * Parser for liquidation messages exported from the Telegram channel
 * "Binance Liquidated Trades".
 *
 * Message text looks like:
 *   🟢 #BTC Liquidated Short: $138K at $60331.96
 *   🔴 #BTC Liquidated Long: $1.2M at $60850.5
 *
 * Only BTC messages are kept. The side word ("Short"/"Long") refers to the
 * liquidated position directly, matching our internal LiquidationSide. The USD
 * amount uses K/M/B suffixes. Price is the level the bubble is drawn at.
 */

import type { Liquidation, LiquidationSide } from './types.js';

/**
 * Telegram export represents a message's text either as a plain string or as an
 * array of fragments, where each fragment is a string or an object with a
 * "text" field (used for entities such as hashtags). This flattens either form
 * into a single string.
 */
export function flattenText(text: unknown): string {
    if (typeof text === 'string') {
        return text;
    }
    if (Array.isArray(text)) {
        return text
            .map((part) => {
                if (typeof part === 'string') {
                    return part;
                }
                if (part !== null && typeof part === 'object' && 'text' in part) {
                    const value = (part as { text: unknown }).text;
                    return typeof value === 'string' ? value : '';
                }
                return '';
            })
            .join('');
    }
    return '';
}

/**
 * Converts a USD amount with an optional K/M/B suffix into a number.
 * Examples: "138K" -> 138000, "1.2M" -> 1200000, "866K" -> 866000.
 * Returns NaN if the input is not a recognizable amount.
 */
export function parseUsdAmount(raw: string): number {
    const match = raw.trim().match(/^([0-9]*\.?[0-9]+)\s*([KMB])?$/i);
    if (match === null) {
        return Number.NaN;
    }
    const value = Number(match[1]);
    const suffix = (match[2] ?? '').toUpperCase();
    const multiplier = suffix === 'B' ? 1e9 : suffix === 'M' ? 1e6 : suffix === 'K' ? 1e3 : 1;
    return value * multiplier;
}

/**
 * Pattern capturing side, USD amount, and price from a BTC liquidation message.
 * Tolerant of surrounding emoji and whitespace. The hashtag must be exactly BTC
 * (word boundary) so ETH/ZEC and others are excluded.
 */
const BTC_PATTERN = /#BTC\b[^]*?Liquidated\s+(Short|Long)\s*:\s*\$?\s*([0-9]*\.?[0-9]+\s*[KMB]?)\s+at\s+\$?\s*([0-9]*\.?[0-9]+)/i;

/**
 * Parses one message's flattened text into a Liquidation, given the message
 * time in milliseconds. Returns null if the text is not a BTC liquidation or
 * any field is malformed.
 */
export function parseLiquidationMessage(text: string, timeMs: number): Liquidation | null {
    if (!Number.isFinite(timeMs)) {
        return null;
    }

    const match = text.match(BTC_PATTERN);
    if (match === null) {
        return null;
    }

    const side: LiquidationSide = match[1].toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
    const usd = parseUsdAmount(match[2]);
    const price = Number(match[3]);

    if (!Number.isFinite(usd) || !Number.isFinite(price) || usd <= 0 || price <= 0) {
        return null;
    }

    /**
     * Quantity is derived from notional and price. The channel does not provide
     * quantity directly, but usd is the primary value used for sizing and
     * filtering, so a derived qty keeps the record shape consistent.
     */
    const qty = usd / price;

    return { time: timeMs, side, price, qty, usd };
}
