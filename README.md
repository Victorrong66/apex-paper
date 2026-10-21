# Apex Paper — Futures Paper Trading Simulator

A free, local, browser-based futures paper trading simulator with **live real-time market data**. No account, no API key, no cost.

## What this is (and isn't)

- Streams **live price data** from **Kraken Futures** public market data (REST + WebSocket) — no authentication required, it's public market data.
- Lets you long/short, set leverage, use market or limit orders, and tracks liquidation, PnL, and trade history — all simulated locally via a small local server. **No real orders are ever placed anywhere.**
- Trades **crypto perpetual futures** (BTC, ETH, SOL, XRP, LINK, DOGE — all vs USD), not CME contracts (ES/NQ/CL). Free, real-time CME futures data does not exist anywhere, from any provider — it's licensed exchange data. If you specifically want to paper trade real CME contracts, use **TradingView Paper Trading** or **NinjaTrader's free SIM101** account instead; this app is the build-your-own alternative for crypto futures mechanics (leverage, margin, liquidation), which work the same way CME futures do.
- **Why Kraken and not Binance:** Binance Futures (and even Binance's spot API) returns an HTTP 451 — blocked for legal/regulatory reasons — from US IP addresses. Kraken is a US-compliant exchange and its futures market data is openly accessible. If you're outside the US, both would technically work, but Kraken's API is used here either way for consistency.
- Liquidation price uses **each symbol's actual maintenance-margin rate**, pulled live from Kraken's instrument metadata (e.g. 0.5% for BTC/ETH/SOL, 1% for XRP/DOGE/LINK at the lowest position-size tier). Real exchanges increase that rate in tiers as position size grows — this app always uses the lowest tier, so it will be slightly optimistic for very large simulated positions.

## Why there's a small backend

Kraken Futures' REST API doesn't send an `Access-Control-Allow-Origin` header, so a browser can't call it directly — that's a CORS block, not a bug. `server.js` is a ~100-line Express + `ws` server that:

1. Proxies REST calls (candles, 24h ticker, instrument metadata) so the browser only ever talks to `localhost`.
2. Opens one WebSocket connection to Kraken's live ticker feed, and relays it to the browser over a local WebSocket at `/ws`.

No API key is required anywhere — everything it touches is Kraken's public market data.

## Running it

```bash
cd futures-paper-trader
npm install
npm start
```

Then open **http://localhost:8000** in your browser.

## How it works

- **Chart**: candlestick chart (TradingView's open-source `lightweight-charts` library, via CDN), seeded from Kraken's historical candles and refreshed every few seconds for the current bar.
- **Price feed**: Kraken's live ticker/mark-price WebSocket feed drives PnL, liquidation checks, and limit order fills in real time.
- **Order ticket**: you set a margin amount (USD) and leverage; position size = margin × leverage ÷ price.
- **Liquidation**: `Long liq price = entry × (1 − 1/leverage + MMR)`, `Short liq price = entry × (1 + 1/leverage − MMR)`, where MMR is that symbol's real Kraken maintenance margin rate. When the mark price crosses it, the position auto-closes and the margin is lost.
- **Persistence**: account balance, open positions/orders, and trade history are saved to the browser's `localStorage` — they survive a refresh, but are specific to that browser (no cloud sync, no database).

## Validation checklist

After `npm start`, confirm:

1. Terminal shows `Connected to Kraken Futures WebSocket` and `Apex Paper running at http://localhost:8000` with no errors.
2. **Connection dot** in the top bar turns green ("Live") within a few seconds of loading the page.
3. **Chart renders** candles and the price in the header updates every few seconds without refreshing the page.
4. Place a small **market order** (e.g. $100 margin, 10x on BTC/USD) → it appears instantly in the **Positions** tab with the entry price matching the current mark price.
5. Change leverage and confirm the **estimated liquidation price** in the order ticket moves closer to entry price as leverage increases.
6. Place a **limit order** away from the current price, confirm it sits in **Open Orders**, then confirm it moves to **Positions** once the live price crosses your limit.
7. Close a position and confirm **Account → Realized PnL** updates and the trade appears in **History**.
8. Click **Reset Account** and confirm balance returns to $100,000 with positions/history cleared.

## If something breaks

- **Terminal shows "Kraken WebSocket error" repeatedly**: check `curl https://futures.kraken.com/derivatives/api/v3/tickers` directly — if that also fails, it's a network/firewall issue on your end, not this app.
- **Chart stuck on "Loading chart…"**: same check, but against `https://futures.kraken.com/api/charts/v1/trade/PF_XBTUSD/1h`.
- **Port 8000 already in use**: run with `PORT=8001 npm start` instead.

## Files

```
futures-paper-trader/
├── server.js       — Express + ws backend: REST proxy + live ticker relay
├── package.json    — dependencies (express, ws)
├── public/
│   ├── index.html  — layout/structure
│   ├── style.css   — dark trading-terminal theme
│   └── app.js       — frontend logic: order engine, chart, rendering
└── README.md       — this file
```
