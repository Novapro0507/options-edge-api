const express = require("express");
const cors = require("cors");
require("dotenv").config();
 
const app = express();
const PORT = process.env.PORT || 3001;
 
app.use(express.json());
app.use(cors());
 
const Anthropic = require("@anthropic-ai/sdk");
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
 
// ─── Real-time stock data from Yahoo Finance (free, no key needed) ────────────
async function getStockData(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=200d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(`No data for ${ticker}`);
 
    const closes = result.indicators.quote[0].close.filter(Boolean);
    const volumes = result.indicators.quote[0].volume.filter(Boolean);
    const meta = result.meta;
    const price = meta.regularMarketPrice;
    const prevClose = meta.previousClose || meta.chartPreviousClose;
    const changeP = (((price - prevClose) / prevClose) * 100).toFixed(2);
 
    const sma = (n) => closes.length >= n
      ? (closes.slice(-n).reduce((a, b) => a + b, 0) / n).toFixed(2)
      : null;
    const sma20 = sma(20), sma50 = sma(50), sma200 = sma(200);
    const pct = (ma) => ma ? `${(((price - ma) / ma) * 100) >= 0 ? "+" : ""}${(((price - ma) / ma) * 100).toFixed(1)}%` : null;
 
    const rsi = (() => {
      if (closes.length < 15) return null;
      const diffs = closes.slice(-15).map((c, i, a) => i === 0 ? 0 : c - a[i - 1]).slice(1);
      const gains = diffs.filter(d => d > 0).reduce((a, b) => a + b, 0) / 14;
      const losses = Math.abs(diffs.filter(d => d < 0).reduce((a, b) => a + b, 0)) / 14;
      return losses === 0 ? 100 : Math.round(100 - 100 / (1 + gains / losses));
    })();
 
    const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const relVol = ((volumes[volumes.length - 1] || avgVol) / avgVol).toFixed(2);
 
    const high52 = Math.max(...closes.slice(-252)).toFixed(2);
    const low52 = Math.min(...closes.slice(-252)).toFixed(2);
 
    const ema = (n) => {
      if (closes.length < n) return null;
      const k = 2 / (n + 1);
      let v = closes.slice(0, n).reduce((a, b) => a + b) / n;
      for (let i = n; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
      return v;
    };
    const ema12 = ema(12), ema26 = ema(26);
    const macdVal = ema12 && ema26 ? (ema12 - ema26).toFixed(2) : null;
    const macdSignal = macdVal ? (parseFloat(macdVal) > 0 ? "bullish" : "bearish") : "neutral";
 
    return {
      ticker: ticker.toUpperCase(),
      name: meta.longName || meta.shortName || ticker,
      price: price.toFixed(2),
      changeP: `${changeP >= 0 ? "+" : ""}${changeP}%`,
      sma20, sma50, sma200,
      vs20ma: pct(sma20), vs50ma: pct(sma50), vs200ma: pct(sma200),
      rsi, macdSignal, macdVal,
      relVol: `${relVol}x`,
      high52, low52,
      fromHigh: `${(((price - high52) / high52) * 100).toFixed(1)}%`,
      volume: volumes[volumes.length - 1]?.toLocaleString(),
    };
  } catch (err) {
    throw new Error(`Data fetch failed for ${ticker}: ${err.message}`);
  }
}
 
async function getEarningsDate(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=calendarEvents`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const json = await res.json();
    const raw = json?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate?.[0]?.raw;
    if (!raw) return { date: "Not scheduled", daysAway: null };
    const date = new Date(raw * 1000);
    const daysAway = Math.round((date - Date.now()) / 86400000);
    return { date: date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }), daysAway };
  } catch {
    return { date: "Unknown", daysAway: null };
  }
}
 
function extractJSON(text, type = "object") {
  const open = type === "object" ? "{" : "[";
  const close = type === "object" ? "}" : "]";
  const starts = [];
  for (let i = 0; i < text.length; i++) if (text[i] === open) starts.push(i);
  for (let i = starts.length - 1; i >= 0; i--) {
    let depth = 0, inStr = false, esc = false;
    for (let j = starts[i]; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === open) depth++;
      if (c === close) { depth--; if (depth === 0) { try { return JSON.parse(text.slice(starts[i], j + 1)); } catch { break; } } }
    }
  }
  return null;
}
 
async function analyzeWithAI(s, earnings, style) {
  const styleLabel = { aggressive: "aggressive (1-3 week plays)", moderate: "moderate (2-5 week plays)", conservative: "conservative (high probability, longer dated)" }[style] || "moderate";
 
  const prompt = `You are a professional options trader. Analyze ${s.ticker} using this LIVE market data:
 
${s.name} (${s.ticker}) — $${s.price} (${s.changeP} today)
RSI(14): ${s.rsi} ${s.rsi <= 30 ? "— OVERSOLD" : s.rsi >= 70 ? "— OVERBOUGHT" : "— neutral"}
MACD: ${s.macdSignal}
vs 20MA: ${s.vs20ma} | vs 50MA: ${s.vs50ma} | vs 200MA: ${s.vs200ma}
Relative Volume: ${s.relVol}
52w High: $${s.high52} (${s.fromHigh} away) | 52w Low: $${s.low52}
Next Earnings: ${earnings.date}${earnings.daysAway !== null ? ` — ${earnings.daysAway} days away` : ""}
Style: ${styleLabel}
 
Based on this real data, give a complete options trade recommendation.
Verdict must be: BUY CALLS, BUY PUTS, or SKIP.
 
Respond ONLY with valid JSON, no markdown, start { end }:
{"verdict":"BUY CALLS","verdictReason":"One sentence why.","confidence":75,"tradeGrade":"B","setup":{"type":"Setup name","bias":"bullish","strength":"moderate"},"recommendedTrade":{"type":"Call","strike":"$XXX","expiry":"Apr 18, 2025","dte":28,"targetPremium":"$X.XX-X.XX","maxProfit":"$XXX per contract","maxLoss":"$XXX per contract","breakevenAtExpiry":"$XXX","pop":62},"alternativeTrade":{"type":"Call","strike":"$XXX","expiry":"May 16, 2025","dte":56,"note":"More time if move is slow"},"keyLevels":{"support1":"$XXX","support2":"$XXX","resistance1":"$XXX","resistance2":"$XXX","invalidationLevel":"$XXX"},"volatility":{"ivRank":35,"ivPercentile":40,"ivLevel":"normal","ivEdge":"One sentence on IV.","earningsEffect":"How earnings timing affects this trade"},"riskFactors":["Risk 1","Risk 2"],"entryTiming":"Specific entry instruction","exitPlan":{"profitTarget":"Sell at X% gain on premium","stopLoss":"Close if stock breaks $XXX or option loses 40%","timeStop":"Close 7-10 days before expiry"},"skipReason":null}`;
 
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1200,
    messages: [{ role: "user", content: prompt }],
  });
 
  const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
  const parsed = extractJSON(text, "object");
  if (!parsed) throw new Error("AI response could not be parsed");
  return parsed;
}
 
function buildResult(analysis, stockData, earnings, account, risk) {
  const result = {
    ...analysis,
    ticker: stockData.ticker,
    price: `$${stockData.price}`,
    change: stockData.changeP,
    technicals: {
      rsi: stockData.rsi,
      macdSignal: stockData.macdSignal,
      vs20ma: stockData.vs20ma,
      vs50ma: stockData.vs50ma,
      vs200ma: stockData.vs200ma,
      relVol: stockData.relVol,
      trend: parseFloat(stockData.vs200ma) > 0 ? "uptrend" : "downtrend",
    },
    catalyst: {
      nextEarnings: earnings.date,
      daysToEarnings: earnings.daysAway,
      earningsStrategy: earnings.daysAway !== null && earnings.daysAway < 21
        ? "Earnings approaching — pick expiry carefully"
        : "No near-term earnings risk",
      upcomingEvents: "None",
    },
    marketData: { high52: `$${stockData.high52}`, low52: `$${stockData.low52}`, fromHigh: stockData.fromHigh, volume: stockData.volume },
    analyzedAt: new Date().toISOString(),
  };
 
  if (account > 0 && analysis.recommendedTrade) {
    const premium = parseFloat((analysis.recommendedTrade.targetPremium || "2").replace(/[^0-9.]/g, "")) || 2;
    const maxRisk = account * (risk / 100);
    const contracts = Math.max(1, Math.floor(maxRisk / (premium * 100)));
    result.sizing = {
      contracts,
      totalRisk: `$${(contracts * premium * 100).toFixed(0)}`,
      portfolioRisk: `${((contracts * premium * 100) / account * 100).toFixed(1)}%`,
      positionNote: `${contracts} contract${contracts > 1 ? "s" : ""} at ${risk}% max risk`,
    };
  }
  return result;
}
 
// ─── Screener ─────────────────────────────────────────────────────────────────
const SCREEN_TICKERS = {
  calls:    ["AAPL", "MSFT", "NVDA", "META", "GOOGL", "AMZN", "AMD", "JPM", "SPY", "QQQ"],
  puts:     ["TSLA", "COIN", "MSTR", "ARKK", "SQ", "SNAP", "UBER", "LYFT", "RIVN", "LCID"],
  premium:  ["SPY", "QQQ", "AAPL", "TSLA", "AMZN", "NVDA", "META", "MSFT", "GS", "BAC"],
  earnings: ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA", "JPM", "V", "MA"],
  oversold: ["AMZN", "GOOGL", "META", "NFLX", "AAPL", "MSFT", "JPM", "V", "MA", "HD"],
};
 
async function runScreener(type) {
  const tickers = SCREEN_TICKERS[type] || SCREEN_TICKERS.calls;
  const fetched = await Promise.allSettled(tickers.map(t => getStockData(t)));
  const stocks = fetched.filter(r => r.status === "fulfilled").map(r => r.value);
 
  let candidates = [];
  if (type === "calls")    candidates = stocks.filter(s => s.rsi && s.rsi < 65).sort((a, b) => a.rsi - b.rsi).slice(0, 5);
  else if (type === "puts")     candidates = stocks.filter(s => s.rsi && s.rsi > 55).sort((a, b) => b.rsi - a.rsi).slice(0, 5);
  else if (type === "oversold") candidates = stocks.filter(s => s.rsi && s.rsi < 40).sort((a, b) => a.rsi - b.rsi).slice(0, 5);
  else if (type === "earnings") {
    const withE = await Promise.allSettled(stocks.map(async s => ({ ...s, earnings: await getEarningsDate(s.ticker) })));
    candidates = withE.filter(r => r.status === "fulfilled" && r.value.earnings.daysAway > 0 && r.value.earnings.daysAway < 30).map(r => r.value).sort((a, b) => a.earnings.daysAway - b.earnings.daysAway).slice(0, 5);
  } else candidates = stocks.slice(0, 5);
 
  if (!candidates.length) candidates = stocks.slice(0, 5);
 
  return candidates.map(s => ({
    ticker: s.ticker,
    company: s.name,
    price: `$${s.price}`,
    change: s.changeP,
    verdict: type === "puts" ? "BUY PUTS" : type === "premium" ? "SELL PREMIUM" : "BUY CALLS",
    confidence: s.rsi < 30 || s.rsi > 70 ? 74 : 65,
    reason: `RSI ${s.rsi}, ${s.vs50ma} from 50MA, rel vol ${s.relVol}${s.earnings ? `, earnings ${s.earnings.date}` : ""}`,
    keyMetric: `RSI: ${s.rsi} | ${s.vs50ma} vs 50MA`,
  }));
}
 
// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "2.0.0", dataSource: "Yahoo Finance (live)", timestamp: new Date().toISOString() });
});
 
app.get("/api/quote/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase().replace(/[^A-Z]/g, "");
  try {
    const [data, earnings] = await Promise.all([getStockData(ticker), getEarningsDate(ticker)]);
    res.json({ success: true, data: { ...data, earnings } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.get("/api/analyze/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase().replace(/[^A-Z]/g, "");
  if (!ticker || ticker.length > 5) return res.status(400).json({ error: "Invalid ticker" });
  const style = req.query.style || "moderate";
  const account = parseFloat(req.query.account) || 0;
  const risk = parseFloat(req.query.risk) || 2;
  try {
    const [stockData, earnings] = await Promise.all([getStockData(ticker), getEarningsDate(ticker)]);
    const analysis = await analyzeWithAI(stockData, earnings, style);
    res.json({ success: true, data: buildResult(analysis, stockData, earnings, account, risk) });
  } catch (err) {
    console.error(`[analyze] ${ticker}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});
 
app.post("/api/analyze", async (req, res) => {
  const { tickers = [], style = "moderate", account = 0, risk = 2 } = req.body;
  const clean = [...new Set(tickers.map(t => t.toUpperCase().replace(/[^A-Z]/g, "")).filter(t => t.length >= 1 && t.length <= 5))].slice(0, 4);
  if (!clean.length) return res.status(400).json({ error: "No valid tickers" });
  const results = [];
  for (const ticker of clean) {
    try {
      const [stockData, earnings] = await Promise.all([getStockData(ticker), getEarningsDate(ticker)]);
      const analysis = await analyzeWithAI(stockData, earnings, style);
      results.push({ ticker, success: true, data: buildResult(analysis, stockData, earnings, account, risk) });
    } catch (err) {
      results.push({ ticker, success: false, error: err.message });
    }
    if (clean.indexOf(ticker) < clean.length - 1) await new Promise(r => setTimeout(r, 300));
  }
  res.json({ success: true, results });
});
 
app.get("/api/screen/:type", async (req, res) => {
  const type = req.params.type;
  if (!["calls","puts","premium","earnings","oversold"].includes(type)) return res.status(400).json({ error: "Invalid type" });
  try {
    const results = await runScreener(type);
    res.json({ success: true, type, results, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error(`[screen] ${type}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});
 
app.use((req, res) => res.status(404).json({ error: "Not found" }));
 
app.listen(PORT, () => {
  console.log(`\nOptions Edge API v2 running on port ${PORT}`);
  console.log(`Data: Yahoo Finance (live, free) + Claude AI (your key)\n`);
});
