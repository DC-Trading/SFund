const https = require("https");

const FRED_KEY = "7a6cf55858969b817e221d06da1ee3ce";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpsGet(url, timeout = 6000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    }).on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const data = await httpsGet(url);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const c = meta.regularMarketPrice || meta.previousClose;
  const pc = meta.chartPreviousClose || meta.previousClose;
  if (!c || !pc) return null;
  const d = c - pc, dp = pc ? (d / pc) * 100 : 0;
  return { c, d, dp, pc };
}

async function fetchFRED(seriesId, limit = 2) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=${limit}`;
  const data = await httpsGet(url, 8000);
  if (!data?.observations) return null;
  const obs = data.observations.filter(o => o.value !== "." && !isNaN(parseFloat(o.value)));
  if (!obs.length) return null;
  return { value: parseFloat(obs[0].value), date: obs[0].date };
}

async function fetchCPIyoy() {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCSL&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=14`;
  const data = await httpsGet(url, 8000);
  if (!data?.observations) return null;
  const obs = data.observations.filter(o => o.value !== "." && !isNaN(parseFloat(o.value)));
  if (obs.length < 13) return null;
  const latest = parseFloat(obs[0].value);
  const yearAgo = parseFloat(obs[12].value);
  return { value: ((latest - yearAgo) / yearAgo) * 100, date: obs[0].date };
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    // All price data via Yahoo Finance — works reliably from server-side
    const yahooSymbols = [
      "^DWCPF", "^RUT", "IWM", "MDY", "KRE", "IYJ", "SPY",
      "^VIX", "^TNX", "^IRX", "^TYX", "DX-Y.NYB", "^FVX", "GC=F"
    ];

    const priceResults = {};
    for (const sym of yahooSymbols) {
      priceResults[sym] = await fetchYahoo(sym);
      await sleep(100);
    }

    // Map Yahoo symbols to dashboard keys
    const prices = {
      "^DWCPF":       priceResults["^DWCPF"],
      "RUT":          priceResults["^RUT"],
      "IWM":          priceResults["IWM"],
      "MDY":          priceResults["MDY"],
      "KRE":          priceResults["KRE"],
      "IYJ":          priceResults["IYJ"],
      "SPY":          priceResults["SPY"],
      "VIX":          priceResults["^VIX"],
      "US10Y":        priceResults["^TNX"],
      "US02Y":        priceResults["2YY=F"],
      "US30Y":        priceResults["^TYX"],
      "DXY":          priceResults["DX-Y.NYB", "^FVX"],
      "OANDA:XAUUSD": priceResults["GC=F"],
    };

    // FRED in parallel
    const [pce, cpi, ism, gdp, jobless, nfci] = await Promise.all([
      fetchFRED("PCEPILFE"),
      fetchCPIyoy(),
      fetchFRED("NAPM"),
      fetchFRED("A191RL1Q225SBEA"),
      fetchFRED("ICSA"),
      fetchFRED("NFCI"),
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        prices,
        fred: {
          "PCEPILFE":        pce,
          "CPIAUCSL_YOY":    cpi,
          "NAPM":            ism,
          "A191RL1Q225SBEA": gdp,
          "ICSA":            jobless,
          "NFCI":            nfci,
        },
        timestamp: new Date().toISOString(),
      }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
