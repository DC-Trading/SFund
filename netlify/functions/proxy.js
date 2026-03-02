const https = require("https");

const FH_KEY   = "d6i7bshr01ql9cif7kkgd6i7bshr01ql9cif7kl0";
const FRED_KEY = "7a6cf55858969b817e221d06da1ee3ce";

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpsGet(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeout);
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
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

async function fetchFinnhub(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FH_KEY}`;
  const d = await httpsGet(url);
  if (!d || (d.c === 0 && d.pc === 0)) return null;
  return { c: d.c, d: d.d, dp: d.dp, pc: d.pc };
}

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const data = await httpsGet(url);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const c = meta.regularMarketPrice || meta.previousClose;
  const pc = meta.chartPreviousClose || meta.previousClose;
  if (!c) return null;
  const diff = c - pc, dp = pc ? (diff / pc) * 100 : 0;
  return { c, d: diff, dp, pc };
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
    const dwcpf = await fetchYahoo("^DWCPF");

    const fhSymbols = [
      "RUT","IWM","MDY","KRE","IYJ","SPY",
      "VIX","US10Y","US02Y","US30Y","DXY","OANDA:XAUUSD"
    ];
    const fhResults = {};
    for (const sym of fhSymbols) {
      fhResults[sym] = await fetchFinnhub(sym);
      await sleep(80);
    }

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
        prices: {
          "^DWCPF": dwcpf,
          "RUT":    fhResults["RUT"],
          "IWM":    fhResults["IWM"],
          "MDY":    fhResults["MDY"],
          "KRE":    fhResults["KRE"],
          "IYJ":    fhResults["IYJ"],
          "SPY":    fhResults["SPY"],
          "VIX":    fhResults["VIX"],
          "US10Y":  fhResults["US10Y"],
          "US02Y":  fhResults["US02Y"],
          "US30Y":  fhResults["US30Y"],
          "DXY":    fhResults["DXY"],
          "OANDA:XAUUSD": fhResults["OANDA:XAUUSD"],
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
