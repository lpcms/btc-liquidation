# BTC Liquidation Service — Step 1: Collector

Backend liquidation collector. Connects to Binance USDⓈ-M futures, stores BTCUSDT
liquidations in SQLite, prints each live event.

## Run on VPS (Windows, Node.js 18+)

```
cd server
npm install
npm run build
node dist/collector-runner.js
```

The liquidation stream is silent when no liquidations occur — a quiet period is
normal, not an error. During volatile moves you will see lines appear. Stop with
Ctrl+C. Data is written to `btc-liq.db` in the working directory.

## What to verify
- The process prints "Collector started..." on launch.
- Within a few minutes of any BTC volatility, `[#N] ... LONG/SHORT ... usd=$...`
  lines appear.
- `btc-liq.db` is created and grows. You can inspect it with any SQLite tool:
  `SELECT COUNT(*), MIN(time), MAX(time) FROM liquidations;`

Report back whether live liquidations are landing, then we move to Step 2
(one-year candle backfill).
