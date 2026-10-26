# BTC Liquidation Service — Step 2: Candle Backfill

Downloads BTCUSDT futures candles from Binance REST and caches them in SQLite.

## Retention policy
```
5m  -> 2 months
15m -> 2 months
1h  -> 1 year
4h  -> 1 year
1d  -> 1 year
```
(1m removed from the timeframe switcher.)

## Run on VPS

```
npm run build
node dist/candles-runner.js
```

First run downloads the full history (a few minutes, paginated 1500 bars/request,
throttled). Re-runs only fetch bars newer than what is stored, so they are fast.
Safe to run while the collector is also running — same DB file, different tables.

## What to verify
The summary at the end should show, roughly:
```
  5m   bars=~17000  from=<~2 months ago>  to=<now>
  15m  bars=~5800   from=<~2 months ago>  to=<now>
  1h   bars=~8760   from=<~1 year ago>    to=<now>
  4h   bars=~2190   from=<~1 year ago>    to=<now>
  1d   bars=~365    from=<~1 year ago>    to=<now>
```
Bar counts will vary slightly. If any timeframe shows bars=0, report the error
text and we debug before moving to Step 3 (API).
