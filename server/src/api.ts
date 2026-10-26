/**
 * REST API routes.
 *
 * Exposes cached candles and stored liquidations to the frontend. All query
 * parameters are validated and clamped; invalid input yields a 400 with a short
 * message rather than an unhandled throw. Times are in seconds for candles and
 * milliseconds for liquidations, matching their storage units.
 */

import express, { type Request, type Response, type Router } from 'express';
import type { Repository } from './db.js';
import { TIMEFRAMES } from './timeframes.js';
import type { Timeframe } from './types.js';

/**
 * Parses a query value into a finite number, returning a fallback when the
 * value is absent or malformed.
 */
function parseNumber(value: unknown, fallback: number): number {
    if (typeof value !== 'string') {
        return fallback;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Type guard for the supported timeframe strings.
 */
function isTimeframe(value: unknown): value is Timeframe {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TIMEFRAMES, value);
}

/**
 * Builds the API router bound to the given repository.
 */
export function createApiRouter(repo: Repository): Router {
    const router = express.Router();

    /**
     * Lists supported timeframes and their bar duration, so the client can
     * render the timeframe switcher without hardcoding the set.
     */
    router.get('/timeframes', (_req: Request, res: Response) => {
        const list = Object.values(TIMEFRAMES).map((c) => ({
            interval: c.interval,
            barSeconds: c.barSeconds,
        }));
        res.json(list);
    });

    /**
     * Returns OHLCV candles for a timeframe within an optional [from, to]
     * range (seconds). Defaults span all stored data up to now.
     */
    router.get('/candles', (req: Request, res: Response) => {
        const tf = req.query.tf;
        if (!isTimeframe(tf)) {
            res.status(400).json({ error: 'invalid or missing tf' });
            return;
        }

        const nowSec = Math.floor(Date.now() / 1000);
        const from = parseNumber(req.query.from, 0);
        const to = parseNumber(req.query.to, nowSec);

        const candles = repo.getCandles(tf, from, to);
        res.json(candles);
    });

    /**
     * Returns liquidations within an optional [from, to] range (milliseconds),
     * filtered to those whose USD notional meets minUsd. Defaults span all
     * stored data up to now with no minimum.
     */
    router.get('/liquidations', (req: Request, res: Response) => {
        const nowMs = Date.now();
        const from = parseNumber(req.query.from, 0);
        const to = parseNumber(req.query.to, nowMs);
        const minUsd = Math.max(0, parseNumber(req.query.minUsd, 0));

        const liquidations = repo.getLiquidations(from, to, minUsd);
        res.json(liquidations);
    });

    return router;
}
