/* ============================================================
   Apex Paper — backend
   Why this exists: Kraken Futures' REST API does not send an
   Access-Control-Allow-Origin header, so a browser can't call it
   directly (CORS blocks it). This tiny server proxies the REST
   calls and relays Kraken's live WebSocket ticker feed to the
   browser over a local WebSocket, so the frontend never needs to
   talk to Kraken directly. No API key is needed anywhere — all
   of this is Kraken's public market data.
   ============================================================ */

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const PORT = process.env.PORT || 8000;
const KRAKEN_REST = "https://futures.kraken.com";
const KRAKEN_WS = "wss://futures.kraken.com/ws/v1";

const SYMBOLS = [
  { symbol: "PF_XBTUSD", name: "BTC/USD" },
  { symbol: "PF_ETHUSD", name: "ETH/USD" },
  { symbol: "PF_SOLUSD", name: "SOL/USD" },
  { symbol: "PF_XRPUSD", name: "XRP/USD" },
  { symbol: "PF_LINKUSD", name: "LINK/USD" },
  { symbol: "PF_DOGEUSD", name: "DOGE/USD" },
];

const RESOLUTION_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

const app = express();
app.use(express.static(path.join(__dirname, "public")));

/* ---------------- REST proxy ---------------- */

// cached maintenance margin rates, loaded once at boot from Kraken instrument metadata
let marginRates = {};

async function loadMarginRates() {
  try {
    const res = await fetch(`${KRAKEN_REST}/derivatives/api/v3/instruments`);
    const data = await res.json();
    data.instruments.forEach((i) => {
      if (SYMBOLS.find((s) => s.symbol === i.symbol) && i.marginLevels && i.marginLevels[0]) {
        marginRates[i.symbol] = i.marginLevels[0].maintenanceMargin;
      }
    });
    console.log("Loaded maintenance margin rates:", marginRates);
  } catch (e) {
    console.warn("Could not load margin rates from Kraken, using 0.01 default for all symbols.", e.message);
  }
}

app.get("/api/instruments", (req, res) => {
  res.json(SYMBOLS.map((s) => ({ ...s, maintenanceMargin: marginRates[s.symbol] || 0.01 })));
});

app.get("/api/ticker24h", async (req, res) => {
  const symbol = req.query.symbol;
  if (!SYMBOLS.find((s) => s.symbol === symbol)) return res.status(400).json({ error: "unknown symbol" });
  try {
    const r = await fetch(`${KRAKEN_REST}/derivatives/api/v3/tickers`);
    const data = await r.json();
    const t = data.tickers.find((x) => x.symbol === symbol);
    if (!t) return res.status(404).json({ error: "symbol not found" });
    res.json({
      symbol,
      last: t.last,
      markPrice: t.markPrice,
      high24h: t.high24h,
      low24h: t.low24h,
      volumeQuote: t.volumeQuote,
      change24h: t.change24h,
    });
  } catch (e) {
    res.status(502).json({ error: "upstream error", detail: e.message });
  }
});

app.get("/api/candles", async (req, res) => {
  const { symbol, resolution } = req.query;
  if (!SYMBOLS.find((s) => s.symbol === symbol)) return res.status(400).json({ error: "unknown symbol" });
  const secPerCandle = RESOLUTION_SECONDS[resolution] || 900;
  const to = Math.floor(Date.now() / 1000);
  const from = to - secPerCandle * 500;
  try {
    const r = await fetch(`${KRAKEN_REST}/api/charts/v1/trade/${symbol}/${resolution}?from=${from}&to=${to}`);
    const data = await r.json();
    const candles = (data.candles || []).map((c) => ({
      time: Math.floor(c.time / 1000),
      open: +c.open,
      high: +c.high,
      low: +c.low,
      close: +c.close,
    }));
    res.json(candles);
  } catch (e) {
    res.status(502).json({ error: "upstream error", detail: e.message });
  }
});

/* ---------------- Live ticker relay ---------------- */

const latestTickers = {}; // symbol -> {markPrice, last, high24h, low24h, volumeQuote, change24h}
let upstream = null;
let localClients = new Set();

function connectUpstream() {
  upstream = new WebSocket(KRAKEN_WS);

  upstream.on("open", () => {
    console.log("Connected to Kraken Futures WebSocket");
    upstream.send(JSON.stringify({ event: "subscribe", feed: "ticker", product_ids: SYMBOLS.map((s) => s.symbol) }));
  });

  upstream.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.feed === "ticker" && msg.product_id) {
      const t = {
        symbol: msg.product_id,
        markPrice: msg.markPrice,
        last: msg.last,
        high24h: msg.high24h,
        low24h: msg.low24h,
        volumeQuote: msg.volumeQuote,
        change24h: msg.change24h,
      };
      latestTickers[msg.product_id] = t;
      broadcastToClients({ type: "ticker", ...t });
    }
  });

  upstream.on("close", () => {
    console.warn("Kraken WebSocket closed, reconnecting in 3s…");
    setTimeout(connectUpstream, 3000);
  });

  upstream.on("error", (err) => {
    console.warn("Kraken WebSocket error:", err.message);
  });
}

function broadcastToClients(payload) {
  const data = JSON.stringify(payload);
  localClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

/* ---------------- Boot ---------------- */

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", (client) => {
  localClients.add(client);
  // send current snapshot immediately so the UI isn't blank until the next tick
  Object.values(latestTickers).forEach((t) => client.send(JSON.stringify({ type: "ticker", ...t })));
  client.on("close", () => localClients.delete(client));
});

loadMarginRates().then(connectUpstream);

server.listen(PORT, () => {
  console.log(`Apex Paper running at http://localhost:${PORT}`);
});
