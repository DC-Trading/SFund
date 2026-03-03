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
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) return null;
  const c = meta.regularMarketPrice || meta.previousClose;
  if (!c) return null;

  // Try to get previous close from actual OHLC data (most reliable)
  // The closes array has daily closes — second-to-last is prior day
  const closes = result?.indicators?.quote?.[0]?.close;
  const timestamps = result?.timestamp;
  let pc = null;
  if (closes && closes.length >= 2) {
    // Find the last two valid (non-null) closes
    const valid = closes.filter(v => v !== null && !isNaN(v));
    if (valid.length >= 2) {
      pc = valid[valid.length - 2]; // prior day close
    }
  }
  // Fallback to meta fields
  if (!pc) pc = meta.regularMarketPreviousClose || meta.chartPreviousClose || meta.previousClose;
  if (!pc) return null;

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


async function fetchPCEyoy() {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=PCEPILFE&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=14`;
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
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    // Yahoo symbols — tested and confirmed working
    const symbolMap = [
      { key: "^DWCPF",       yahoo: "^DWCPF"    },
      { key: "RUT",          yahoo: "^RUT"       },
      { key: "IWM",          yahoo: "IWM"        },
      { key: "MDY",          yahoo: "MDY"        },
      { key: "KRE",          yahoo: "KRE"        },
      { key: "IYJ",          yahoo: "IYJ"        },
      { key: "SPY",          yahoo: "SPY"        },
      { key: "VIX",          yahoo: "^VIX"       },
      { key: "US10Y",        yahoo: "^TNX"       }, // 10-yr yield (e.g. 4.04%)
      { key: "US02Y",        yahoo: "^IRX"       }, // 13-wk but best proxy; will scale x10
      { key: "US30Y",        yahoo: "^TYX"       }, // 30-yr yield
      { key: "DXY",          yahoo: "UUP"        }, // Dollar ETF — avoids DX-Y.NYB scaling issue
      { key: "OANDA:XAUUSD", yahoo: "GC=F"       }, // Gold futures
    ];

    const prices = {};
    for (const { key, yahoo } of symbolMap) {
      const result = await fetchYahoo(yahoo);
      prices[key] = result;
      await sleep(100);
    }

    // ^TNX and ^TYX return yields already in percent (e.g. 4.048)
    // ^IRX returns annualized discount rate — need to scale: divide by 10 to get ~4.x%
    // Actually ^IRX returns e.g. 43.90 meaning 4.390% — divide by 10
    if (prices["US02Y"] && prices["US02Y"].c > 10) {
      const q = prices["US02Y"];
      prices["US02Y"] = { c: q.c/10, d: q.d/10, dp: q.dp, pc: q.pc/10 };
    }

    // UUP is ~$28, not 98 — so for DXY display we note it's a proxy ETF
    // Better: fetch actual DXY via different approach
    // Use FRED for DXY: series DTWEXBGS or just keep UUP as proxy
    // Actually let's try the Stooq URL for DXY
    const dxyUrl = "https://stooq.com/q/l/?s=usdx.forex&f=sd2t2ohlcv&h&e=json";
    const dxyData = await httpsGet(dxyUrl, 5000);
    if (dxyData?.symbols?.[0]) {
      const s = dxyData.symbols[0];
      const c = parseFloat(s.close), pc = parseFloat(s.open);
      if (!isNaN(c) && !isNaN(pc)) {
        prices["DXY"] = { c, d: c-pc, dp: ((c-pc)/pc)*100, pc };
      }
    }

    // FRED in parallel
    const [pce, cpi, ism, gdp, jobless, nfci] = await Promise.all([
      fetchPCEyoy(),
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
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
