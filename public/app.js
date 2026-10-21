/* ============================================================
   Apex Paper — Futures Paper Trading Simulator
   Live market data: Kraken Futures public market data, proxied
   through our own local server (server.js) — see that file for why.
   All trading is simulated locally. No real orders are ever sent.
   ============================================================ */

const INTERVALS = ["1m","5m","15m","1h","4h","1d"];
const STORAGE_KEY = "apexPaperTrader_v1";
const STARTING_BALANCE = 100000;
const CANDLE_POLL_MS = 4000;

/* ---------------- State ---------------- */
let state = loadState();
let chart, candleSeries;
let ws = null;
let wsReconnectTimer = null;
let symbolMeta = {};        // symbol -> { symbol, name, maintenanceMargin }
let activeSymbol = state.activeSymbol || null;
let activeInterval = state.activeInterval || "15m";
let latestPrices = {};      // symbol -> last mark price
let ticker24h = {};         // symbol -> {high24h, low24h, volumeQuote, change24h}
let orderSide = "LONG";
let orderType = "MARKET";
let candlePollTimer = null;

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return freshAccount();
}

function freshAccount(){
  return {
    balance: STARTING_BALANCE,
    positions: [],   // {id, symbol, side, qty, entryPrice, leverage, margin, liqPrice, openedAt}
    orders: [],      // {id, symbol, side, type, limitPrice, leverage, margin, createdAt}
    history: [],     // {time, symbol, side, qty, entry, exit, pnl, reason}
    realizedPnl: 0,
    activeSymbol: null,
    activeInterval: "15m"
  };
}

function saveState(){
  state.activeSymbol = activeSymbol;
  state.activeInterval = activeInterval;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/* ---------------- Utility ---------------- */
const fmtUsd = (n, dp=2) => "$" + Number(n).toLocaleString(undefined,{minimumFractionDigits:dp, maximumFractionDigits:dp});
const fmtNum = (n, dp=2) => Number(n).toLocaleString(undefined,{minimumFractionDigits:dp, maximumFractionDigits:dp});
const fmtPrice = (n) => {
  n = Number(n);
  if(n >= 1000) return fmtNum(n,2);
  if(n >= 1) return fmtNum(n,4);
  return fmtNum(n,6);
};
const baseAsset = (sym) => (symbolMeta[sym]?.name || sym).split("/")[0];
const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36);

function toast(title, msg, type="info"){
  const stack = document.getElementById("toastStack");
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.innerHTML = `<strong>${title}</strong>${msg}`;
  stack.appendChild(el);
  setTimeout(()=> el.remove(), 5000);
}

/* ---------------- Instruments ---------------- */
async function loadInstruments(){
  const res = await fetch("/api/instruments");
  const list = await res.json();
  list.forEach(s=> symbolMeta[s.symbol] = s);
  if(!activeSymbol || !symbolMeta[activeSymbol]) activeSymbol = list[0].symbol;
}

/* ---------------- UI: Symbol & Interval pickers ---------------- */
function buildSymbolPicker(){
  const el = document.getElementById("symbolPicker");
  el.innerHTML = "";
  Object.values(symbolMeta).forEach(s=>{
    const btn = document.createElement("button");
    btn.className = "symbol-chip" + (s.symbol===activeSymbol ? " active" : "");
    btn.textContent = s.name;
    btn.onclick = () => switchSymbol(s.symbol);
    el.appendChild(btn);
  });
}

function buildIntervalRow(){
  const el = document.getElementById("intervalRow");
  el.innerHTML = "";
  INTERVALS.forEach(iv=>{
    const btn = document.createElement("button");
    btn.className = "interval-btn" + (iv===activeInterval ? " active" : "");
    btn.textContent = iv.toUpperCase();
    btn.onclick = () => switchInterval(iv);
    el.appendChild(btn);
  });
}

function switchSymbol(sym){
  if(sym === activeSymbol) return;
  activeSymbol = sym;
  document.getElementById("activeSymbolLabel").textContent = symbolMeta[sym].name;
  buildSymbolPicker();
  loadChartHistory();
  fetch24hTicker();
  updateOrderSummary();
  saveState();
}

function switchInterval(iv){
  if(iv === activeInterval) return;
  activeInterval = iv;
  buildIntervalRow();
  loadChartHistory();
  saveState();
}

/* ---------------- Chart ---------------- */
function initChart(){
  chart = LightweightCharts.createChart(document.getElementById("chart"), {
    layout: { background: { color: "transparent" }, textColor: "#aab2c5", fontFamily: "Inter" },
    grid: { vertLines: { color: "#1d2330" }, horzLines: { color: "#1d2330" } },
    rightPriceScale: { borderColor: "#252b38" },
    timeScale: { borderColor: "#252b38", timeVisible: true, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: "#16c784", downColor: "#f6465d",
    borderUpColor: "#16c784", borderDownColor: "#f6465d",
    wickUpColor: "#16c784", wickDownColor: "#f6465d",
  });
  new ResizeObserver(()=> chart.applyOptions({ width: document.getElementById("chart").clientWidth }))
    .observe(document.getElementById("chart"));
}

async function loadChartHistory(){
  const loadingEl = document.getElementById("chartLoading");
  loadingEl.classList.remove("hidden");
  loadingEl.textContent = "Loading chart…";
  try{
    const res = await fetch(`/api/candles?symbol=${activeSymbol}&resolution=${activeInterval}`);
    if(!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if(data.length === 0) throw new Error("empty candle set");
    candleSeries.setData(data);
    loadingEl.classList.add("hidden");
    startCandlePolling();
  }catch(err){
    loadingEl.textContent = "Couldn't load chart data — retrying…";
    setTimeout(loadChartHistory, 4000);
  }
}

function startCandlePolling(){
  if(candlePollTimer) clearInterval(candlePollTimer);
  candlePollTimer = setInterval(async ()=>{
    try{
      const res = await fetch(`/api/candles?symbol=${activeSymbol}&resolution=${activeInterval}`);
      const data = await res.json();
      if(data.length) candleSeries.update(data[data.length-1]);
    }catch(e){}
  }, CANDLE_POLL_MS);
}

async function fetch24hTicker(){
  try{
    const res = await fetch(`/api/ticker24h?symbol=${activeSymbol}`);
    const d = await res.json();
    ticker24h[activeSymbol] = d;
    renderPriceStrip();
  }catch(e){}
}

/* ---------------- Local WebSocket relay ---------------- */
function connectWebSocket(){
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  if(ws) try{ ws.close(); }catch(e){}
  setConnStatus("connecting");

  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => setConnStatus("live");
  ws.onclose = () => {
    setConnStatus("down");
    wsReconnectTimer = setTimeout(connectWebSocket, 3000);
  };
  ws.onerror = () => { try{ ws.close(); }catch(e){} };

  ws.onmessage = (ev)=>{
    const msg = JSON.parse(ev.data);
    if(msg.type !== "ticker") return;
    const sym = msg.symbol;
    const price = +msg.markPrice || +msg.last;
    if(!price) return;
    latestPrices[sym] = price;

    if(sym === activeSymbol){
      document.getElementById("statMark").textContent = fmtPrice(price);
      document.getElementById("lastPrice").textContent = fmtPrice(price);
      ticker24h[sym] = { high24h: msg.high24h, low24h: msg.low24h, volumeQuote: msg.volumeQuote, change24h: msg.change24h };
      renderPriceStrip();
    }

    checkLimitOrders(sym, price);
    checkLiquidations(sym, price);
    renderPositions();
    renderAccountPanel();
    updateOrderSummary();
  };
}

function setConnStatus(status){
  const dot = document.getElementById("connDot");
  const label = document.getElementById("connLabel");
  dot.className = "dot" + (status==="live" ? " live" : status==="down" ? " down" : "");
  label.textContent = status==="live" ? "Live" : status==="down" ? "Reconnecting…" : "Connecting…";
}

/* ---------------- Price strip ---------------- */
function renderPriceStrip(){
  const t = ticker24h[activeSymbol];
  if(!t || t.change24h === undefined) return;
  const chg = +t.change24h;
  const chEl = document.getElementById("priceChange");
  chEl.textContent = (chg>=0?"+":"") + chg.toFixed(2) + "%";
  chEl.className = "price-change " + (chg>=0 ? "up" : "down");
  document.getElementById("stat24hHigh").textContent = fmtPrice(+t.high24h);
  document.getElementById("stat24hLow").textContent = fmtPrice(+t.low24h);
  document.getElementById("stat24hVol").textContent = fmtNum(+t.volumeQuote/1e6,1) + "M";
}

/* ---------------- Order ticket logic ---------------- */
function mmrFor(symbol){
  return symbolMeta[symbol]?.maintenanceMargin ?? 0.01;
}

function liqPrice(entry, leverage, side, symbol){
  const mmr = mmrFor(symbol);
  if(side === "LONG") return entry * (1 - 1/leverage + mmr);
  return entry * (1 + 1/leverage - mmr);
}

function updateOrderSummary(){
  const margin = parseFloat(document.getElementById("marginInput").value) || 0;
  const leverage = parseInt(document.getElementById("leverageSlider").value) || 1;
  const refPrice = orderType === "LIMIT"
    ? (parseFloat(document.getElementById("limitPriceInput").value) || latestPrices[activeSymbol] || 0)
    : (latestPrices[activeSymbol] || 0);

  if(!refPrice || !margin){
    document.getElementById("summarySize").textContent = "—";
    document.getElementById("summaryEntry").textContent = "—";
    document.getElementById("summaryLiq").textContent = "—";
    document.getElementById("summaryMargin").textContent = "—";
    return;
  }
  const notional = margin * leverage;
  const qty = notional / refPrice;
  const liq = liqPrice(refPrice, leverage, orderSide, activeSymbol);

  document.getElementById("summarySize").textContent = fmtNum(qty,5) + " " + baseAsset(activeSymbol);
  document.getElementById("summaryEntry").textContent = fmtPrice(refPrice);
  document.getElementById("summaryLiq").textContent = fmtPrice(liq);
  document.getElementById("summaryMargin").textContent = fmtUsd(margin);
}

function placeOrder(){
  const margin = parseFloat(document.getElementById("marginInput").value);
  const leverage = parseInt(document.getElementById("leverageSlider").value);
  if(!margin || margin <= 0){ toast("Invalid order","Enter a margin amount greater than 0.","error"); return; }
  if(margin > state.balance){ toast("Insufficient balance", `You only have ${fmtUsd(state.balance)} available.`, "error"); return; }

  if(orderType === "MARKET"){
    const price = latestPrices[activeSymbol];
    if(!price){ toast("No price yet","Wait for live data to connect.","error"); return; }
    fillPosition(activeSymbol, orderSide, margin, leverage, price);
  } else {
    const limitPrice = parseFloat(document.getElementById("limitPriceInput").value);
    if(!limitPrice || limitPrice <= 0){ toast("Invalid limit price","Enter a limit price.","error"); return; }
    state.balance -= margin; // reserve margin
    state.orders.push({
      id: uid(), symbol: activeSymbol, side: orderSide, type:"LIMIT",
      limitPrice, leverage, margin, createdAt: Date.now()
    });
    renderOrders();
    renderAccountPanel();
    saveState();
    toast("Limit order placed", `${orderSide} ${symbolMeta[activeSymbol].name} @ ${fmtPrice(limitPrice)}`, "success");
  }
}

function fillPosition(symbol, side, margin, leverage, price){
  state.balance -= margin;
  const qty = (margin*leverage)/price;
  const liq = liqPrice(price, leverage, side, symbol);
  state.positions.push({
    id: uid(), symbol, side, qty, entryPrice: price, leverage, margin, liqPrice: liq, openedAt: Date.now()
  });
  renderPositions();
  renderAccountPanel();
  saveState();
  toast("Position opened", `${side} ${fmtNum(qty,5)} ${baseAsset(symbol)} @ ${fmtPrice(price)}`, "success");
}

function checkLimitOrders(symbol, price){
  const remaining = [];
  let changed = false;
  state.orders.forEach(o=>{
    if(o.symbol !== symbol){ remaining.push(o); return; }
    const triggered = (o.side === "LONG" && price <= o.limitPrice) || (o.side === "SHORT" && price >= o.limitPrice);
    if(triggered){
      changed = true;
      const qty = (o.margin*o.leverage)/o.limitPrice;
      const liq = liqPrice(o.limitPrice, o.leverage, o.side, o.symbol);
      state.positions.push({
        id: uid(), symbol: o.symbol, side: o.side, qty, entryPrice: o.limitPrice,
        leverage: o.leverage, margin: o.margin, liqPrice: liq, openedAt: Date.now()
      });
      toast("Limit order filled", `${o.side} ${symbolMeta[o.symbol].name} @ ${fmtPrice(o.limitPrice)}`, "success");
    } else {
      remaining.push(o);
    }
  });
  if(changed){
    state.orders = remaining;
    renderOrders();
    renderPositions();
    saveState();
  }
}

function cancelOrder(id){
  const o = state.orders.find(x=>x.id===id);
  if(!o) return;
  state.balance += o.margin;
  state.orders = state.orders.filter(x=>x.id!==id);
  renderOrders();
  renderAccountPanel();
  saveState();
  toast("Order canceled", `${o.side} ${symbolMeta[o.symbol].name} @ ${fmtPrice(o.limitPrice)}`, "info");
}

function positionPnl(p){
  const mark = latestPrices[p.symbol] || p.entryPrice;
  return p.side === "LONG" ? (mark-p.entryPrice)*p.qty : (p.entryPrice-mark)*p.qty;
}

function closePosition(id, reason="Manual close"){
  const p = state.positions.find(x=>x.id===id);
  if(!p) return;
  const mark = latestPrices[p.symbol] || p.entryPrice;
  const pnl = positionPnl(p);
  state.balance += p.margin + pnl;
  state.realizedPnl += pnl;
  state.history.unshift({
    time: Date.now(), symbol: p.symbol, side: p.side, qty: p.qty,
    entry: p.entryPrice, exit: mark, pnl, reason
  });
  state.positions = state.positions.filter(x=>x.id!==id);
  renderPositions(); renderHistory(); renderAccountPanel();
  saveState();
  toast(reason==="Liquidated" ? "Position liquidated" : "Position closed",
    `${p.side} ${symbolMeta[p.symbol].name} · PnL ${pnl>=0?"+":""}${fmtUsd(pnl)}`,
    pnl>=0 ? "success" : "error");
}
window.closePosition = closePosition;
window.cancelOrder = cancelOrder;

function checkLiquidations(symbol, price){
  state.positions.filter(p=>p.symbol===symbol).forEach(p=>{
    const hit = p.side==="LONG" ? price <= p.liqPrice : price >= p.liqPrice;
    if(hit) closePosition(p.id, "Liquidated");
  });
}

/* ---------------- Rendering ---------------- */
function renderPositions(){
  const body = document.getElementById("positionsBody");
  document.getElementById("posCount").textContent = state.positions.length;
  if(state.positions.length === 0){
    body.innerHTML = `<tr class="empty-row"><td colspan="10">No open positions yet. Place an order to get started.</td></tr>`;
    return;
  }
  body.innerHTML = state.positions.map(p=>{
    const mark = latestPrices[p.symbol] || p.entryPrice;
    const pnl = positionPnl(p);
    return `<tr>
      <td>${symbolMeta[p.symbol]?.name || p.symbol}</td>
      <td><span class="side-tag ${p.side.toLowerCase()}">${p.side}</span></td>
      <td>${fmtNum(p.qty,5)}</td>
      <td>${fmtPrice(p.entryPrice)}</td>
      <td>${fmtPrice(mark)}</td>
      <td>${p.leverage}x</td>
      <td>${fmtPrice(p.liqPrice)}</td>
      <td>${fmtUsd(p.margin)}</td>
      <td class="${pnl>=0?'pnl-pos':'pnl-neg'}">${pnl>=0?'+':''}${fmtUsd(pnl)}</td>
      <td><button class="mini-btn" onclick="closePosition('${p.id}')">Close</button></td>
    </tr>`;
  }).join("");
}

function renderOrders(){
  const body = document.getElementById("ordersBody");
  document.getElementById("orderCount").textContent = state.orders.length;
  if(state.orders.length === 0){
    body.innerHTML = `<tr class="empty-row"><td colspan="7">No open orders.</td></tr>`;
    return;
  }
  body.innerHTML = state.orders.map(o=>`<tr>
    <td>${symbolMeta[o.symbol]?.name || o.symbol}</td>
    <td><span class="side-tag ${o.side.toLowerCase()}">${o.side}</span></td>
    <td>${o.type}</td>
    <td>${fmtUsd(o.margin)} margin</td>
    <td>${fmtPrice(o.limitPrice)}</td>
    <td>${o.leverage}x</td>
    <td><button class="mini-btn" onclick="cancelOrder('${o.id}')">Cancel</button></td>
  </tr>`).join("");
}

function renderHistory(){
  const body = document.getElementById("historyBody");
  if(state.history.length === 0){
    body.innerHTML = `<tr class="empty-row"><td colspan="8">No closed trades yet.</td></tr>`;
    return;
  }
  body.innerHTML = state.history.slice(0,100).map(h=>`<tr>
    <td>${new Date(h.time).toLocaleString()}</td>
    <td>${symbolMeta[h.symbol]?.name || h.symbol}</td>
    <td><span class="side-tag ${h.side.toLowerCase()}">${h.side}</span></td>
    <td>${fmtNum(h.qty,5)}</td>
    <td>${fmtPrice(h.entry)}</td>
    <td>${fmtPrice(h.exit)}</td>
    <td class="${h.pnl>=0?'pnl-pos':'pnl-neg'}">${h.pnl>=0?'+':''}${fmtUsd(h.pnl)}</td>
    <td>${h.reason}</td>
  </tr>`).join("");
}

function renderAccountPanel(){
  const unrealized = state.positions.reduce((sum,p)=> sum + positionPnl(p), 0);
  const marginUsed = state.positions.reduce((sum,p)=> sum + p.margin, 0) + state.orders.reduce((sum,o)=> sum + o.margin, 0);
  const equity = state.balance + marginUsed + unrealized;

  document.getElementById("acctEquity").textContent = fmtUsd(equity);
  document.getElementById("acctBalance").textContent = fmtUsd(state.balance);
  document.getElementById("acctMargin").textContent = fmtUsd(marginUsed);
  const upEl = document.getElementById("acctUPnl");
  upEl.textContent = (unrealized>=0?"+":"") + fmtUsd(unrealized);
  upEl.style.color = unrealized>=0 ? "var(--green)" : "var(--red)";
  const rpEl = document.getElementById("acctRPnl");
  rpEl.textContent = (state.realizedPnl>=0?"+":"") + fmtUsd(state.realizedPnl);
  rpEl.style.color = state.realizedPnl>=0 ? "var(--green)" : "var(--red)";
}

/* ---------------- Tabs ---------------- */
function initTabs(){
  document.querySelectorAll(".tab").forEach(tab=>{
    tab.onclick = ()=>{
      document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c=>c.classList.remove("active"));
      tab.classList.add("active");
      document.querySelector(`.tab-content[data-tab-content="${tab.dataset.tab}"]`).classList.add("active");
    };
  });
}

/* ---------------- Order ticket controls ---------------- */
function initOrderTicket(){
  document.getElementById("longBtn").onclick = ()=> setSide("LONG");
  document.getElementById("shortBtn").onclick = ()=> setSide("SHORT");

  document.querySelectorAll(".type-btn").forEach(btn=>{
    btn.onclick = ()=>{
      document.querySelectorAll(".type-btn").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      orderType = btn.dataset.type;
      document.getElementById("limitPriceField").style.display = orderType==="LIMIT" ? "block" : "none";
      setSide(orderSide);
      updateOrderSummary();
    };
  });

  document.getElementById("marginInput").oninput = updateOrderSummary;
  document.getElementById("limitPriceInput").oninput = updateOrderSummary;
  document.getElementById("leverageSlider").oninput = (e)=>{
    document.getElementById("leverageValue").textContent = e.target.value + "x";
    updateOrderSummary();
  };

  document.querySelectorAll(".quick-pct button").forEach(btn=>{
    btn.onclick = ()=>{
      const pct = parseFloat(btn.dataset.pct);
      document.getElementById("marginInput").value = Math.floor(state.balance * pct);
      updateOrderSummary();
    };
  });

  document.getElementById("submitOrderBtn").onclick = placeOrder;
  setSide("LONG");
}

function setSide(side){
  orderSide = side;
  document.getElementById("longBtn").classList.toggle("active", side==="LONG");
  document.getElementById("shortBtn").classList.toggle("active", side==="SHORT");
  const submitBtn = document.getElementById("submitOrderBtn");
  submitBtn.textContent = (orderType==="LIMIT" ? "Place " : "Open ") + (side==="LONG" ? "Long" : "Short") + " " + (orderType==="LIMIT" ? "Order" : "Position");
  submitBtn.classList.toggle("short-mode", side==="SHORT");
  updateOrderSummary();
}

/* ---------------- Reset ---------------- */
function initReset(){
  document.getElementById("resetBtn").onclick = ()=>{
    if(!confirm("Reset your paper account back to $100,000? This closes all positions and clears history.")) return;
    state = freshAccount();
    state.activeSymbol = activeSymbol;
    state.activeInterval = activeInterval;
    saveState();
    renderPositions(); renderOrders(); renderHistory(); renderAccountPanel();
    toast("Account reset", "Balance restored to $100,000.", "success");
  };
}

/* ---------------- Boot ---------------- */
async function boot(){
  await loadInstruments();
  document.getElementById("activeSymbolLabel").textContent = symbolMeta[activeSymbol].name;
  buildSymbolPicker();
  buildIntervalRow();
  initChart();
  initTabs();
  initOrderTicket();
  initReset();
  renderPositions();
  renderOrders();
  renderHistory();
  renderAccountPanel();
  loadChartHistory();
  fetch24hTicker();
  connectWebSocket();
  setInterval(fetch24hTicker, 15000);
}

document.addEventListener("DOMContentLoaded", boot);
