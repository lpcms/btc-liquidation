# BTC Liquidation Service — Step 3: Unified Server (API + WebSocket)

Single entrypoint that updates candles, runs the liquidation collector, and
serves the REST API + client websocket on one local port.

## Run on VPS

```
npm run build
npm start          # = node dist/index.js
```

Server listens on http://127.0.0.1:3000 (localhost only).
On boot it delta-updates candles, then starts collecting and serving.

Diagnostic runners are still available:
```
npm run collector  # collector only, prints live liquidations
npm run backfill   # candle backfill only, prints coverage
```

## Endpoints
- `GET /api/timeframes` -> list of { interval, barSeconds }
- `GET /api/candles?tf=1h&from=<sec>&to=<sec>` -> OHLCV array
- `GET /api/liquidations?from=<ms>&to=<ms>&minUsd=<n>` -> liquidation array
- `WS  /ws` -> pushes { type:"liquidation", data:{...} } on each new event

## Quick check (with server running)
Open in a browser or use curl:
```
curl "http://127.0.0.1:3000/api/timeframes"
curl "http://127.0.0.1:3000/api/candles?tf=1d"
curl "http://127.0.0.1:3000/api/liquidations?minUsd=100000"
```
`/api/candles?tf=1d` should return ~365 objects. `/api/liquidations` returns
whatever the collector has stored so far (may be small or empty if it has not
run long). The frontend (Step 4) is served from ../public once built; until then
the API runs standalone.

Report back that the endpoints return data, then we build Step 4 (the chart).
