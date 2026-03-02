const https = require("https");

const FH_KEY   = "d6i7bshr01ql9cif7kkgd6i7bshr01ql9cif7kl0";
const FRED_KEY = "7a6cf55858969b817e221d06da1ee3ce";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "TSPWatchlist/1.0" } }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("JSON parse error: " + data.slice(0, 200))); }
      });
    }).on("error", reject);
  });
}

async function fetchFinnhub(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FH_KEY}`;
  try {
    const d = await httpsGet(url);
    if (!d || (d.c === 0 && d.pc === 0)) return null;
    return { c: d.c, d: d.d, dp: d.dp, pc: d.pc };
  } catch { return null; }
}

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  try {
    const data = await httpsGet(url);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const c = meta.regularMarketPrice;
    const pc = meta.chartPreviousClose || meta.previousClose;
    if (!c) return null;
    const diff = c - pc, dp = pc ? (diff / pc) * 100 : 0;
    return { c, d: diff, dp, pc };
  } catch { return null; }
}

async function fetchFRED(seriesId, limit = 2) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=${limit}`;
  try {
    const data = await httpsGet(url);
    if (!data?.observations) return null;
    const obs = data.observations.filter(o => o.value !== "." && !isNaN(parseFloat(o.value)));
    if (!obs.length) return null;
    return { value: parseFloat(obs[0].value), date: obs[0].date };
  } catch { return null; }
}

async function fetchCPIyoy() {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCSL&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=14`;
  try {
    const data = await httpsGet(url);
    if (!data?.observations) return null;
    const obs = data.observations.filter(o => o.value !== "." && !isNaN(parseFloat(o.value)));
    if (obs.length < 13) return null;
    const latest   = parseFloat(obs[0].value);
    const yearAgo  = parseFloat(obs[12].value);
    const yoy      = ((latest - yearAgo) / yearAgo) * 100;
    return { value: yoy, date: obs[0].date };
  } catch { return null; }
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
    // Fetch all data in parallel
    const [
      dwcpf, rut, iwm, mdy, kre, iyj, spy,
      vix, us10y, us02y, us30y, dxy, gold,
      pce, cpi, ism, gdp, jobless, nfci
    ] = await Promise.all([
      fetchYahoo("^DWCPF"),
      fetchFinnhub("RUT"),
      fetchFinnhub("IWM"),
      fetchFinnhub("MDY"),
      fetchFinnhub("KRE"),
      fetchFinnhub("IYJ"),
      fetchFinnhub("SPY"),
      fetchFinnhub("VIX"),
      fetchFinnhub("US10Y"),
      fetchFinnhub("US02Y"),
      fetchFinnhub("US30Y"),
      fetchFinnhub("DXY"),
      fetchFinnhub("OANDA:XAUUSD"),
      fetchFRED("PCEPILFE"),
      fetchCPIyoy(),
      fetchFRED("NAPM"),
      fetchFRED("A191RL1Q225SBEA"),
      fetchFRED("ICSA"),
      fetchFRED("NFCI"),
    ]);

    const result = {
      prices: {
        "^DWCPF": dwcpf,
        "RUT":    rut,
        "IWM":    iwm,
        "MDY":    mdy,
        "KRE":    kre,
        "IYJ":    iyj,
        "SPY":    spy,
        "VIX":    vix,
        "US10Y":  us10y,
        "US02Y":  us02y,
        "US30Y":  us30y,
        "DXY":    dxy,
        "OANDA:XAUUSD": gold,
      },
      fred: {
        "PCEPILFE":        pce,
        "CPIAUCSL_YOY":    cpi,
        "NAPM":            ism,
        "A191RL1Q225SBEA": gdp,
        "ICSA":            jobless,
        "NFCI":            nfci,
      },
      timestamp: new Date().toISOString(),
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
