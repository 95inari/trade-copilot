/* Trade Co-Pilot PWA エンジン
 *
 * FastAPI版（backend/app/）のロジックをクライアントサイドに移植したもの。
 * GitHub Pagesは静的ホスティングのため、スコアリング・ペーパー売買・日誌・
 * J-Quantsクライアントをすべてブラウザ内で実行し、localStorageに保存する。
 *
 * データソース:
 *  - J-Quants / Yahoo Finance: ブラウザ制約を回避するため、自分専用の
 *    Cloudflare Workerプロキシ経由。
 *    未設定時や取得失敗時は、誤認防止のため銘柄・価格データを表示しない。
 */
(() => {
"use strict";
// IIFEで全体を包み、UI層（app.js）との関数名衝突を防ぐ。
// 公開するのは window.TradeCoPilot のみ。

// ---------------------------------------------------------------------------
// 時刻（JST固定・DSTなし）
// ---------------------------------------------------------------------------

function jstDate(offsetMs = 0) {
  return new Date(Date.now() + 9 * 3600 * 1000 + offsetMs);
}

function nowJstIso() {
  return jstDate().toISOString().replace("Z", "+09:00");
}

function todayJst() {
  return jstDate().toISOString().slice(0, 10);
}

function nowHhmm() {
  const j = jstDate();
  return `${String(j.getUTCHours()).padStart(2, "0")}:${String(j.getUTCMinutes()).padStart(2, "0")}`;
}

function jstDayOfTs(tsSeconds) {
  return new Date((tsSeconds + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

function jstWeekday() {
  return (jstDate().getUTCDay() + 6) % 7; // 月=0 ... 日=6
}

// ---------------------------------------------------------------------------
// 数値ユーティリティ（PythonのDecimal相当の丸め制御）
// ---------------------------------------------------------------------------

function roundTo(value, dp = 2) {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
}

function roundHalfEven(value) {
  // Pythonの round()（銀行家丸め）と一致させる。スコアが境界で±1ずれると
  // 自動売買ゲート（>=65）やランク判定が FastAPI版と食い違うため
  const floor = Math.floor(value);
  if (Math.abs(value - floor - 0.5) < 1e-9) {
    return floor % 2 === 0 ? floor : floor + 1;
  }
  return Math.round(value);
}

function floorSteps(value, step) {
  // 浮動小数点誤差で1ステップ過小にならないようにする
  return Math.floor(value / step + 1e-9);
}

function ceilTo(value, dp = 2) {
  const f = 10 ** dp;
  return Math.ceil(value * f - 1e-9) / f;
}

// ---------------------------------------------------------------------------
// 永続化（localStorage）
// ---------------------------------------------------------------------------

const store = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(`tc_${key}`);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    localStorage.setItem(`tc_${key}`, JSON.stringify(value));
  },
  remove(key) {
    localStorage.removeItem(`tc_${key}`);
  },
};

const DEFAULT_RISK_SETTINGS = {
  capital_amount: 30000,
  max_loss_per_trade: 300,
  max_loss_per_day: 600,
  max_positions: 2,
  max_consecutive_losses: 3,
  broker_mode: "sbi_s_stock",
  order_amount_per_trade: 15000,
  enforce_time_window: true,
};

function readRiskSettings() {
  return { ...DEFAULT_RISK_SETTINGS, ...(store.read("settings", {}) || {}) };
}

function readJournals() {
  const data = store.read("journals", []);
  return Array.isArray(data) ? data : [];
}

function writeJournals(journals) {
  store.write("journals", journals);
}

function readPaperTrades() {
  const data = store.read("paper_trades", []);
  return Array.isArray(data) ? data : [];
}

function writePaperTrades(trades) {
  store.write("paper_trades", trades);
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

// ---------------------------------------------------------------------------
// マスタデータ（FastAPI版 main.py と同一）
// ---------------------------------------------------------------------------

const BROKER_PRESETS = {
  sbi_s_stock: { label: "SBI証券 S株", quantity_step: 1, allow_fractional: false, min_order_amount: 0, description: "単元未満株を1株単位で仮想購入します。" },
  paypay_amount: { label: "PayPay証券", quantity_step: 0.0001, allow_fractional: true, min_order_amount: 100, description: "金額指定を想定し、1株未満の端数株も仮想購入します。" },
  rakuten_kabumini: { label: "楽天証券 かぶミニ", quantity_step: 1, allow_fractional: false, min_order_amount: 0, description: "単元未満株を1株単位で仮想購入します（リアルタイム取引想定）。" },
  rakuten_amount: { label: "楽天証券 金額指定", quantity_step: 0.0001, allow_fractional: true, min_order_amount: 1000, description: "金額指定の単元未満株注文を想定し、端数株も仮想購入します。" },
};
const BROKER_KEYS = Object.keys(BROKER_PRESETS);

const DEFAULT_WATCHLIST = ["3914", "6526", "2160", "5253", "7203", "6758", "9984", "8306", "6920", "8035", "7974", "9432"];

const NAME_HINTS = {
  "3914": "JIG-SAW", "6526": "ソシオネクスト", "2160": "ジーエヌアイグループ", "5253": "カバー",
  "7203": "トヨタ自動車", "6758": "ソニーグループ", "9984": "ソフトバンクグループ", "8306": "三菱UFJ FG",
  "6920": "レーザーテック", "8035": "東京エレクトロン", "7974": "任天堂", "9432": "NTT",
};

const FORBIDDEN_EXPRESSIONS = [
  "買いです", "売りです", "買うべき", "売るべき", "買ってください", "売ってください",
  "必ず儲かる", "必ず上がる", "必ず下がる", "絶対に儲かる", "勝率保証", "元本保証",
  "利益保証", "利益確定できます", "売買シグナル",
];

function sanitizeExpression(text) {
  let result = text;
  for (const phrase of FORBIDDEN_EXPRESSIONS) {
    result = result.split(phrase).join("（断定表現のため省略）");
  }
  return result;
}

// ---------------------------------------------------------------------------
// 監視リスト
// ---------------------------------------------------------------------------

function readWatchlist() {
  const data = store.read("watchlist", null);
  if (!Array.isArray(data) || !data.length) return [...DEFAULT_WATCHLIST];
  return data.map(String).slice(0, 30);
}

function saveWatchlist(codes) {
  store.write("watchlist", codes);
}

// ---------------------------------------------------------------------------
// データ設定（プロキシ / 未接続）
// ---------------------------------------------------------------------------

const DEFAULT_PROXY_URL = "https://trade-copilot-data-proxy.95inari.workers.dev";

function readProxyUrl() {
  const saved = store.read("proxy_url", null);
  return String(saved === null ? DEFAULT_PROXY_URL : saved || "").trim();
}

function useRealData() {
  return readProxyUrl() !== "";
}

function proxyUrlFor(target) {
  return `${readProxyUrl().replace(/\/$/, "")}/?url=${encodeURIComponent(target)}`;
}

// ---------------------------------------------------------------------------
// Yahoo（プロキシ経由）実データ取得
// ---------------------------------------------------------------------------

const YAHOO_TTL_MS = 90_000;
const MARKET_SCAN_TTL_MS = 90_000;
const FAILURE_RETRY_MS = 30_000;
const RATE_LIMIT_COOLDOWN_MS = 180_000;
const FETCH_SPACING_MS = 500;
const STALE_CARRY_MAX_MS = 600_000;

const yahooCache = { fetchedAt: 0, attemptedAt: 0, codes: null, stocks: [], errors: [] };
const marketScanCache = { fetchedAt: 0, value: null };
let yahooRateLimitedUntil = 0;
let yahooInflight = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchChartViaProxy(code) {
  const target = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?range=6d&interval=5m`;
  const url = proxyUrlFor(target);
  let response;
  const fetchOnce = async () => {
    try {
      return await fetch(url);
    } catch {
      throw new Error(`${code}.T: プロキシに接続できません`);
    }
  };
  response = await fetchOnce();
  if (response.status === 429) {
    // Python版と同じく、瞬間的な429は2.5秒待って1回だけ再試行する
    await sleep(2500);
    response = await fetchOnce();
  }
  if (response.status === 429) throw new Error(`${code}.T: 取得失敗 (HTTP 429)`);
  if (!response.ok) throw new Error(`${code}.T: 取得失敗 (HTTP ${response.status})`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(`${code}.T: ${payload?.chart?.error?.description || "no result"}`);
  return result;
}

async function getMarketScan() {
  if (Date.now() - marketScanCache.fetchedAt < MARKET_SCAN_TTL_MS && marketScanCache.value) {
    return marketScanCache.value;
  }
  const url = `${readProxyUrl().replace(/\/$/, "")}/?ranking=scan`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`市場全体スキャン: HTTP ${response.status}`);
    const payload = await response.json();
    const value = {
      candidates: Array.isArray(payload.candidates) ? payload.candidates : [],
      ranked_count: Number(payload.ranked_count || 0),
      sources: Array.isArray(payload.sources) ? payload.sources : [],
      errors: Array.isArray(payload.errors) ? payload.errors : [],
      updated_at: payload.updated_at || null,
    };
    Object.assign(marketScanCache, { fetchedAt: Date.now(), value });
    return value;
  } catch (error) {
    return { candidates: [], ranked_count: 0, sources: [], errors: [error.message], updated_at: null };
  }
}

function cleanCandles(chart) {
  const ts = chart.timestamp || [];
  const q = chart.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i += 1) {
    const [o, h, l, c, v] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i], q.volume?.[i]];
    if (o == null || h == null || l == null || c == null || v == null) continue;
    out.push([ts[i], o, h, l, c, v]);
  }
  return out;
}

function aggregateCandles(fiveMin, groupSize) {
  const out = [];
  for (let start = 0; start < fiveMin.length; start += groupSize) {
    const chunk = fiveMin.slice(start, start + groupSize);
    if (!chunk.length) continue;
    out.push([
      chunk[0][1],
      Math.max(...chunk.map((c) => c[2])),
      Math.min(...chunk.map((c) => c[3])),
      chunk[chunk.length - 1][4],
      chunk.reduce((sum, c) => sum + c[5], 0),
    ]);
  }
  return out;
}

function countUpperWicks(fiveMin, lookback = 6) {
  let count = 0;
  for (const [, o, h, , c] of fiveMin.slice(-lookback)) {
    const body = Math.abs(c - o);
    const wick = h - Math.max(o, c);
    if (wick > Math.max(body * 1.2, c * 0.0005)) count += 1;
  }
  return count;
}

async function fetchYahooStock(code) {
  const chart = await fetchChartViaProxy(code);
  const meta = chart.meta || {};
  const all = cleanCandles(chart);
  if (!all.length) throw new Error(`${code}.T: 分足データなし`);

  const sessions = {};
  for (const candle of all) {
    const day = jstDayOfTs(candle[0]);
    (sessions[day] = sessions[day] || []).push(candle);
  }
  const days = Object.keys(sessions).sort();
  const sessionDate = days[days.length - 1];
  const fiveMin = sessions[sessionDate];
  const prevDays = days.slice(0, -1);
  const isPreviousSession = sessionDate !== todayJst();

  const price = Number(meta.regularMarketPrice) || fiveMin[fiveMin.length - 1][4];
  const prevClose = prevDays.length
    ? sessions[prevDays[prevDays.length - 1]].slice(-1)[0][4]
    : Number(meta.previousClose) || Number(meta.chartPreviousClose) || 0;
  if (!price || !prevClose) throw new Error(`${code}.T: 価格データなし`);

  const volume = Number(meta.regularMarketVolume) || fiveMin.reduce((sum, c) => sum + c[5], 0);
  const tradedValue = fiveMin.reduce((sum, c) => sum + ((c[2] + c[3] + c[4]) / 3) * c[5], 0);
  const tradedVolume = fiveMin.reduce((sum, c) => sum + c[5], 0);
  const vwap = tradedVolume > 0 ? roundTo(tradedValue / tradedVolume, 1) : price;

  const prevVolumes = prevDays.map((d) => sessions[d].reduce((sum, c) => sum + c[5], 0)).slice(-5);
  const prevAvg = prevVolumes.length ? prevVolumes.reduce((a, b) => a + b, 0) / prevVolumes.length : 0;
  const volumeChangeRate = prevAvg > 0 ? Math.round((volume / prevAvg) * 100) : 100;

  const changeRate = roundTo((price / prevClose - 1) * 100, 1);
  const dayHigh = Number(meta.regularMarketDayHigh) || Math.max(...fiveMin.map((c) => c[2]));
  const aboveVwap = price > vwap;
  const breakout = changeRate > 0 && price >= dayHigh * 0.997;
  const pullback = aboveVwap && price <= vwap * 1.012 && !breakout;
  const recent = fiveMin.slice(-3);
  const peak = Math.max(...fiveMin.map((c) => c[5]));
  const volumeFading = fiveMin.length > 6 && recent.reduce((s, c) => s + c[5], 0) / recent.length < peak * 0.4;

  let chartPattern = "VWAP上推移型";
  if (breakout) chartPattern = "高値ブレイク型";
  else if (pullback) chartPattern = "VWAP押し目待ち型";
  else if (!aboveVwap) chartPattern = "VWAP割れ警戒型";
  else if (changeRate >= 10) chartPattern = "急騰後の過熱型";

  return {
    symbol: code,
    name: NAME_HINTS[code] || meta.shortName || code,
    market: "東証",
    sector: "-",
    price: roundTo(price, 1),
    change_rate: changeRate,
    volume: Math.round(volume),
    volume_change_rate: volumeChangeRate,
    session_date: sessionDate,
    is_previous_session: isPreviousSession,
    supported_brokers: [...BROKER_KEYS],
    bbs_rank: null,
    ranking_hits: [],
    news_count: null,
    vwap,
    above_vwap: aboveVwap,
    breakout,
    pullback,
    upper_wick_count: countUpperWicks(fiveMin),
    volume_fading: volumeFading,
    thin_order_book: price * volume < 300_000_000,
    event_risk: false,
    chart_pattern: chartPattern,
    candles: aggregateCandles(fiveMin, 6),
  };
}

function applyRankingHits(stocks) {
  if (!stocks.length) return;
  for (const stock of stocks) stock.ranking_hits = [...(stock.market_scan_hits || [])];
  const top = Math.max(3, Math.floor(stocks.length / 4));
  for (const [key, label] of [
    ["change_rate", "値上がり率上位（リスト内）"],
    ["volume", "出来高上位（リスト内）"],
    ["volume_change_rate", "出来高増加率上位（リスト内）"],
  ]) {
    [...stocks].sort((a, b) => b[key] - a[key]).slice(0, top).forEach((s) => s.ranking_hits.push(label));
  }
}

async function fetchYahooUniverse(codes) {
  if (Date.now() < yahooRateLimitedUntil) {
    const remain = Math.ceil((yahooRateLimitedUntil - Date.now()) / 1000);
    return { stocks: [], errors: [`レート制限により取得を一時停止中（あと約${remain}秒）`] };
  }
  const stocks = [];
  const errors = [];
  let consecutive429 = 0;
  for (let i = 0; i < codes.length; i += 1) {
    if (i) await sleep(FETCH_SPACING_MS);
    try {
      stocks.push(await fetchYahooStock(codes[i]));
      consecutive429 = 0;
    } catch (error) {
      errors.push(error.message);
      if (String(error.message).includes("HTTP 429")) {
        consecutive429 += 1;
        if (consecutive429 >= 3) {
          yahooRateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
          errors.push(`429が連続したため残り${codes.length - i - 1}銘柄をスキップし、180秒間は再取得しません`);
          break;
        }
      } else {
        consecutive429 = 0;
      }
    }
  }
  stocks.sort((a, b) => b.change_rate - a.change_rate);
  applyRankingHits(stocks);
  return { stocks, errors };
}

async function getYahooUniverse(codes) {
  const key = codes.join(",");
  const cacheValid = yahooCache.codes === key && Date.now() - yahooCache.fetchedAt < YAHOO_TTL_MS;
  if (cacheValid) {
    return { stocks: [...yahooCache.stocks], errors: [...yahooCache.errors], fetchedAt: yahooCache.fetchedAt };
  }
  if (yahooInflight) {
    // single-flight: 同じ監視リストなら進行中の取得を共有。
    // 監視リストが変わっていたら完了を待ってから自分のリストで再評価する
    if (yahooInflight.key === key) return yahooInflight.promise;
    await yahooInflight.promise.catch(() => {});
    return getYahooUniverse(codes);
  }

  const promise = (async () => {
    if (yahooCache.codes === key && Date.now() - yahooCache.attemptedAt < FAILURE_RETRY_MS) {
      return { stocks: [...yahooCache.stocks], errors: [...yahooCache.errors], fetchedAt: yahooCache.fetchedAt };
    }
    const { stocks, errors } = await fetchYahooUniverse(codes);
    const now = Date.now();
    yahooCache.attemptedAt = now;
    if (stocks.length) {
      if (errors.length && yahooCache.codes === key) {
        const fetched = new Set(stocks.map((s) => s.symbol));
        for (const old of yahooCache.stocks) {
          if (!codes.includes(old.symbol) || fetched.has(old.symbol)) continue;
          const carried = { ...old, stale_since: old.stale_since ?? yahooCache.fetchedAt };
          if (now - carried.stale_since > STALE_CARRY_MAX_MS) continue;
          carried.is_stale = true;
          stocks.push(carried);
        }
        stocks.sort((a, b) => b.change_rate - a.change_rate);
        applyRankingHits(stocks);
      }
      Object.assign(yahooCache, { fetchedAt: now, codes: key, stocks, errors });
      return { stocks: [...stocks], errors: [...errors], fetchedAt: now };
    }
    if (yahooCache.stocks.length && yahooCache.codes === key) {
      return { stocks: [...yahooCache.stocks], errors: [...yahooCache.errors, ...errors], fetchedAt: yahooCache.fetchedAt };
    }
    return { stocks: [], errors, fetchedAt: 0 };
  })();
  yahooInflight = { key, promise };
  promise.finally(() => {
    if (yahooInflight && yahooInflight.promise === promise) yahooInflight = null;
  }).catch(() => {});
  return promise;
}

function clearYahooCache() {
  Object.assign(yahooCache, { fetchedAt: 0, attemptedAt: 0, codes: null, stocks: [], errors: [] });
  Object.assign(marketScanCache, { fetchedAt: 0, value: null });
}

// ---------------------------------------------------------------------------
// J-Quants V2クライアント（ブラウザから公式APIへ直接接続）
// ---------------------------------------------------------------------------

const JQ_BASE = "https://api.jquants.com/v2";
const JQ_ALLOWED = new Set(["/equities/master", "/markets/calendar", "/equities/bars/daily"]);
const JQ_DAILY_BUDGET = 150;
const JQ_REQUEST_INTERVAL_MS = 12_000;
const JQ_MASTER_TTL_MS = 7 * 86400_000;
const JQ_CALENDAR_TTL_MS = 7 * 86400_000;
const JQ_QUOTES_TTL_MS = 86400_000;

// V1のメール・パスワード認証は廃止済み。旧トークンは利用せず端末から削除する。
(() => {
  store.remove("jq_credentials");
  store.remove("jq_account");
  store.remove("jq_token");
})();

const jq = {
  lastError: null,
  lastRequestAt: 0,
  _queue: null,

  // V2はダッシュボードで発行したAPIキーを使用する。キーはこの端末内だけに保存する。
  hasApiKey() {
    return Boolean(store.read("jq_api_key", ""));
  },

  isPaused() {
    return Boolean(store.read("jq_paused", false));
  },

  isConfigured() {
    return this.hasApiKey() && !this.isPaused();
  },

  setPaused(paused) {
    store.write("jq_paused", Boolean(paused));
    this.lastError = null;
  },

  needsRelogin() {
    return false;
  },

  configuredKeyLabel() {
    const key = String(store.read("jq_api_key", ""));
    return key ? `••••${key.slice(-4)}` : null;
  },

  budgetStatus() {
    const usage = store.read("jq_usage", { date: "", requests: 0 });
    const used = usage.date === todayJst() ? usage.requests : 0;
    return { used, budget: JQ_DAILY_BUDGET };
  },

  consumeBudget() {
    const usage = store.read("jq_usage", { date: "", requests: 0 });
    const today = todayJst();
    const current = usage.date === today ? usage.requests : 0;
    if (current >= JQ_DAILY_BUDGET) {
      this.lastError = `本日のリクエスト予算(${JQ_DAILY_BUDGET})を使い切りました`;
      return false;
    }
    store.write("jq_usage", { date: today, requests: current + 1 });
    return true;
  },

  async request(path, { params, apiKey } = {}) {
    if (!JQ_ALLOWED.has(path)) {
      throw new Error(`J-Quants: ${path} はアプリの許可リストにありません`);
    }
    if (!readProxyUrl()) {
      this.lastError = "データ中継プロキシが未設定です。先に下の「データ設定」でURLを保存してください";
      return null;
    }
    if (!this.consumeBudget()) return null;

    // 直列化: 並行リクエストでも無料プランの上限（5件/分）を超えない
    const task = async () => {
      const wait = JQ_REQUEST_INTERVAL_MS - (Date.now() - this.lastRequestAt);
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();

      let upstreamUrl = `${JQ_BASE}${path}`;
      if (params) upstreamUrl += `?${new URLSearchParams(params)}`;
      const url = proxyUrlFor(upstreamUrl);
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { "X-J-Quants-API-Key": apiKey || store.read("jq_api_key", "") },
        });
        if (!response.ok) {
          let detail = "";
          try {
            const body = await response.json();
            detail = String(body?.error || body?.message || "");
          } catch {
            // エラー本文がJSONでない場合はHTTPステータスだけ表示する
          }
          this.lastError = `${path}: HTTP ${response.status}${detail ? `（${detail}）` : ""}`;
          return null;
        }
        this.lastError = null;
        return await response.json();
      } catch {
        this.lastError = `${path}: データ中継プロキシへの接続エラー`;
        return null;
      }
    };
    this._queue = (this._queue ?? Promise.resolve()).then(task, task);
    return this._queue;
  },

  readCache(name, ttlMs) {
    const cached = store.read(`jq_cache_${name}`, null);
    if (!cached || Date.now() - cached.cached_at > ttlMs) return null;
    return cached.value;
  },

  writeCache(name, value) {
    store.write(`jq_cache_${name}`, { cached_at: Date.now(), value });
  },

  async getPaginated(path, params, maxPages = 3) {
    if (!this.isConfigured()) return null;
    const rows = [];
    let paginationKey = null;
    for (let page = 0; page < maxPages; page += 1) {
      const pageParams = { ...params, ...(paginationKey ? { pagination_key: paginationKey } : {}) };
      const payload = await this.request(path, { params: pageParams });
      if (!payload) return rows.length ? rows : null;
      rows.push(...(payload.data || []));
      paginationKey = payload.pagination_key;
      if (!paginationKey) break;
    }
    return rows;
  },

  async getListedMaster() {
    if (!this.isConfigured()) return {};
    const cached = this.readCache("listed", JQ_MASTER_TTL_MS);
    if (cached) return cached;
    const rows = await this.getPaginated("/equities/master", {}, 3);
    if (!rows?.length) return {};
    const master = {};
    for (const row of rows) {
      const code = String(row.Code || "");
      const code4 = code.length === 5 && code.endsWith("0") ? code.slice(0, 4) : code;
      let market = String(row.MktNm || "");
      if (market && !market.startsWith("東証") && !market.includes("PRO")) market = `東証${market}`;
      master[code4] = { name: String(row.CoName || ""), market, sector: String(row.S33Nm || "") };
    }
    this.writeCache("listed", master);
    return master;
  },

  async getTradingCalendar() {
    if (!this.isConfigured()) return {};
    const cached = this.readCache("calendar", JQ_CALENDAR_TTL_MS);
    if (cached) return cached;
    const from = jstDate(-7 * 86400_000).toISOString().slice(0, 10).replaceAll("-", "");
    const to = jstDate(45 * 86400_000).toISOString().slice(0, 10).replaceAll("-", "");
    const rows = await this.getPaginated("/markets/calendar", { from, to }, 2);
    if (!rows?.length) return {};
    const calendar = {};
    for (const row of rows) calendar[String(row.Date || "")] = String(row.HolDiv || "");
    this.writeCache("calendar", calendar);
    return calendar;
  },

  async isTradingDay(dateStr) {
    const calendar = await this.getTradingCalendar();
    const division = calendar[dateStr];
    if (division === undefined) return null;
    return division === "1" || division === "2";
  },

  async getReferenceStats(code) {
    if (!this.isConfigured()) return null;
    const cached = this.readCache(`quotes_${code}`, JQ_QUOTES_TTL_MS);
    if (cached !== null) return cached && Object.keys(cached).length ? cached : null;
    const to = jstDate(-(12 * 7 + 1) * 86400_000).toISOString().slice(0, 10);
    const from = jstDate(-(16 * 7 + 1) * 86400_000).toISOString().slice(0, 10);
    const rows = await this.getPaginated(
      "/equities/bars/daily",
      { code, from: from.replaceAll("-", ""), to: to.replaceAll("-", "") },
      2,
    );
    if (rows === null) return null;
    const ranges = [];
    const volumes = [];
    for (const row of rows) {
      if (row.H && row.L && row.C) ranges.push(((row.H - row.L) / row.C) * 100);
      if (row.Vo) volumes.push(Number(row.Vo));
    }
    let stats = {};
    if (ranges.length) {
      stats = {
        avg_range_pct: roundTo(ranges.reduce((a, b) => a + b, 0) / ranges.length, 2),
        avg_volume: volumes.length ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length) : null,
        period: `${from}〜${to}`,
        note: "12週遅延データの参考値",
      };
    }
    this.writeCache(`quotes_${code}`, stats);
    return Object.keys(stats).length ? stats : null;
  },

  async saveApiKey(apiKey) {
    const key = String(apiKey || "").trim();
    const payload = await this.request("/equities/master", { params: { code: "86970" }, apiKey: key });
    if (!payload?.data?.length) {
      const error = this.lastError || "";
      if (error.includes("未設定")) return { ok: false, message: error };
      if (/Yahoo chart API|HTTP 400/.test(error)) {
        return { ok: false, message: "データ中継プロキシが旧バージョンです。最新のcloudflare-worker.jsへ更新してください" };
      }
      if (/HTTP 401|HTTP 403/.test(error)) {
        return { ok: false, message: "APIキーを確認できませんでした。J-Quantsダッシュボードで発行したV2 APIキーを確認してください" };
      }
      if (error.includes("予算")) return { ok: false, message: error };
      return { ok: false, message: `J-Quantsに接続できませんでした（${error || "ネットワークを確認してください"}）` };
    }
    store.write("jq_api_key", key);
    store.remove("jq_paused");
    return { ok: true, message: "J-Quants V2 APIに接続しました" };
  },

  clearCredentials() {
    store.remove("jq_api_key");
    store.remove("jq_paused");
    store.remove("jq_account");
    store.remove("jq_credentials");
    store.remove("jq_token");
  },

  statusSummary() {
    return {
      configured: this.hasApiKey(),
      active: this.isConfigured(),
      paused: this.isPaused(),
      source: this.hasApiKey() ? "browser" : null,
      key_label: this.configuredKeyLabel(),
      needs_relogin: this.needsRelogin(),
      ...this.budgetStatus(),
      master_cached: this.readCache("listed", JQ_MASTER_TTL_MS) !== null,
      calendar_cached: this.readCache("calendar", JQ_CALENDAR_TTL_MS) !== null,
      last_error: this.lastError,
    };
  },
};

// ---------------------------------------------------------------------------
// 市場データ統合
// ---------------------------------------------------------------------------

async function enrichWithJquants(stocks) {
  const master = await jq.getListedMaster();
  if (!master || !Object.keys(master).length) return;
  for (const stock of stocks) {
    const info = master[stock.symbol];
    if (info) {
      stock.name = info.name || stock.name;
      stock.market = info.market || stock.market;
      stock.sector = info.sector || stock.sector;
    }
  }
}

async function getMarketStocks() {
  if (useRealData()) {
    const pinned = readWatchlist();
    const scan = await getMarketScan();
    const scannedCodes = scan.candidates.map((candidate) => String(candidate.symbol || ""));
    const codes = [...pinned, ...scannedCodes.filter((code) => !pinned.includes(code))].slice(0, 30);
    const { stocks, errors, fetchedAt } = await getYahooUniverse(codes);
    const scanByCode = new Map(scan.candidates.map((candidate) => [String(candidate.symbol), candidate]));
    for (const stock of stocks) {
      const discovered = scanByCode.get(stock.symbol);
      stock.auto_discovered = Boolean(discovered && !pinned.includes(stock.symbol));
      stock.market_scan_hits = discovered?.market_scan_hits || [];
      if (discovered?.name) stock.name = String(discovered.name).replace(/^\(株\)|\(株\)$/g, "").trim();
      if (discovered?.market) stock.market = String(discovered.market);
    }
    applyRankingHits(stocks);
    if (stocks.length) {
      await enrichWithJquants(stocks);
      return {
        stocks,
        meta: {
          data_source: "yahoo",
          data_errors: [...scan.errors, ...errors],
          fetched_at: fetchedAt ? new Date(fetchedAt + 9 * 3600_000).toISOString().replace("Z", "+09:00") : null,
          market_scan: {
            enabled: scan.candidates.length > 0,
            ranked_count: scan.ranked_count,
            added_count: stocks.filter((stock) => stock.auto_discovered).length,
            sources: scan.sources,
            errors: scan.errors,
          },
        },
      };
    }
    return {
      stocks: [],
      meta: {
        data_source: "unavailable",
        data_errors: [...scan.errors, ...errors],
        fetched_at: null,
        market_scan: {
          enabled: false,
          ranked_count: scan.ranked_count,
          added_count: 0,
          sources: scan.sources,
          errors: scan.errors,
        },
      },
    };
  }
  return { stocks: [], meta: { data_source: "unconfigured", data_errors: [], fetched_at: null } };
}

async function currentStockPrice(symbol) {
  if (useRealData()) {
    const { stocks } = await getYahooUniverse(readWatchlist());
    const stock = stocks.find((s) => s.symbol === symbol);
    return stock ? stock.price : null;
  }
  return null;
}

async function isTradingDayToday() {
  const result = await jq.isTradingDay(todayJst());
  if (result !== null) return result;
  return jstWeekday() < 5;
}

async function marketPhase() {
  if (!(await isTradingDayToday())) {
    return { market_phase: "closed", market_phase_label: "休場日" };
  }
  const hhmm = nowHhmm();
  if (hhmm < "09:00") return { market_phase: "pre", market_phase_label: "寄り前" };
  if (hhmm < "09:05") return { market_phase: "pre", market_phase_label: "寄り付き観察（9:05開始）" };
  if (hhmm < "11:30") return { market_phase: "morning", market_phase_label: "朝トレ時間（新規OK）" };
  if (hhmm < "12:30") return { market_phase: "lunch", market_phase_label: "朝トレ終了（新規なし）" };
  if (hhmm <= "15:30") return { market_phase: "afternoon", market_phase_label: "保有分のみ監視" };
  return { market_phase: "closed", market_phase_label: "場外" };
}

// ---------------------------------------------------------------------------
// スコアリング・チェックリスト（main.py の移植）
// ---------------------------------------------------------------------------

function scoreStock(stock) {
  const valueScore = Math.min(20, Math.max(0, (stock.change_rate / 15) * 20));
  const volumeChangeScore = Math.min(20, Math.max(0, (stock.volume_change_rate / 400) * 20));
  const volumeScore = Math.min(15, Math.max(0, (stock.volume / 5_000_000) * 15));
  const bbsRank = stock.bbs_rank;
  const bbsScore = bbsRank == null ? 4 : bbsRank <= 10 ? 10 : bbsRank <= 30 ? 7 : 4;
  const newsScore = Math.min(15, (stock.news_count || 0) * 6);
  let chartScore = 0;
  if (stock.above_vwap) chartScore += 4;
  if (stock.breakout) chartScore += 3;
  if (stock.pullback) chartScore += 3;

  let riskPenalty = 0;
  const warnings = [];
  if (stock.change_rate >= 15) { riskPenalty += 6; warnings.push("前日比が大きく、直近高値での飛び乗りに注意"); }
  if (stock.upper_wick_count >= 3) { riskPenalty += 6; warnings.push("上ヒゲが連続しており、短期の売り圧力に注意"); }
  if (stock.volume_fading) { riskPenalty += 5; warnings.push("出来高がピークアウト気味"); }
  if (stock.thin_order_book) { riskPenalty += 4; warnings.push("板が薄く、約定価格がぶれやすい可能性"); }
  if (stock.event_risk) { riskPenalty += 3; warnings.push("決算・材料イベント前後の不確実性に注意"); }
  if (!stock.above_vwap) { riskPenalty += 5; warnings.push("VWAPを下回っており、ロングの優位性は弱い"); }

  const breakdown = {
    "値上がり率": roundHalfEven(valueScore),
    "出来高増加率": roundHalfEven(volumeChangeScore),
    "出来高": roundHalfEven(volumeScore),
    "掲示板投稿数": bbsScore,
    "ニュース材料": newsScore,
    "チャート形状": chartScore,
    "リスク": Math.max(0, 10 - riskPenalty),
  };
  const totalScore = Math.min(100, Object.values(breakdown).reduce((a, b) => a + b, 0));

  let rankLabel, actionLabel;
  if (totalScore >= 85) { rankLabel = "S"; actionLabel = "要監視"; }
  else if (totalScore >= 70) { rankLabel = "A"; actionLabel = "押し目待ち"; }
  else if (totalScore >= 55) { rankLabel = "B"; actionLabel = "条件確認"; }
  else if (totalScore >= 40) { rankLabel = "C"; actionLabel = "危険"; }
  else { rankLabel = "D"; actionLabel = "見送り"; }

  const reasons = [];
  if (stock.change_rate >= 5) reasons.push("値上がり率ランキング上位");
  if (stock.volume_change_rate >= 200) reasons.push("出来高増加率が高い");
  if ((stock.news_count || 0) > 0) reasons.push("関連ニュースあり");
  if (stock.above_vwap) reasons.push("VWAP上で推移");
  if (stock.pullback) reasons.push("一度押し目を作っている");
  if (stock.breakout) reasons.push("直近高値ブレイクを確認");

  return { total_score: totalScore, rank_label: rankLabel, action_label: actionLabel, score_breakdown: breakdown, reasons, warnings };
}

function buildAssistComment(stock, score) {
  if (["S", "A"].includes(score.rank_label) && stock.pullback) {
    return "条件は良好。今すぐ成行ではなく、VWAP付近の押し目継続と反発確認を優先する監視候補。";
  }
  if (["S", "A"].includes(score.rank_label)) {
    return "短期資金は集まっている。高値付近での飛び乗りを避け、損切り位置を明確にできる場面だけ監視。";
  }
  if (score.rank_label === "B") return "動きはあるが条件確認が必要。VWAP、出来高、損切り幅が整わない場合は見送り。";
  return "過熱または条件不足。無理に入らず、材料確認と出来高の再増加を待つ。";
}

function stockPayload(stock) {
  const score = scoreStock(stock);
  return {
    ...stock,
    score,
    supported_broker_labels: (stock.supported_brokers || []).filter((b) => BROKER_PRESETS[b]).map((b) => BROKER_PRESETS[b].label),
    assist_comment: sanitizeExpression(buildAssistComment(stock, score)),
  };
}

function fmtYen(value, dp = 1) {
  return value.toLocaleString("ja-JP", { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

function buildStopPriceCheck(stock, stopPrice) {
  const price = stock.price;
  if (stopPrice == null) {
    return { label: "損切り価格を決めている", status: "ng", detail: "損切り価格が未入力。エントリー前に必ず設定する" };
  }
  if (stopPrice >= price) {
    return { label: "損切り価格を決めている", status: "ng", detail: `損切り ${fmtYen(stopPrice)}円 が現在値 ${fmtYen(price)}円 以上` };
  }
  const width = price - stopPrice;
  const widthPct = (width / price) * 100;
  return {
    label: "損切り価格を決めている",
    status: widthPct <= 2 ? "ok" : "warn",
    detail: `損切り幅 ${fmtYen(roundTo(width, 1))}円（${widthPct.toFixed(1)}%）` + (widthPct <= 2 ? "" : " / 幅が広め。ロットを絞る"),
  };
}

function buildEntryChecklist(stock, stopPrice = null) {
  return [
    buildStopPriceCheck(stock, stopPrice),
    { label: "出来高が急増している", status: stock.volume_change_rate >= 200 ? "ok" : "warn", detail: `出来高増加率 ${stock.volume_change_rate}%` },
    { label: "VWAP上で推移している", status: stock.above_vwap ? "ok" : "ng", detail: `現在値 ${fmtYen(stock.price)}円 / VWAP ${fmtYen(stock.vwap)}円` },
    { label: "押し目またはブレイクの形がある", status: stock.pullback || stock.breakout ? "ok" : "warn", detail: stock.chart_pattern },
    { label: "急騰しすぎではない", status: stock.change_rate >= 15 ? "ng" : stock.change_rate >= 10 ? "warn" : "ok", detail: `前日比 ${stock.change_rate}%` },
    { label: "上ヒゲが連続していない", status: stock.upper_wick_count >= 3 ? "ng" : "ok", detail: `直近上ヒゲ回数 ${stock.upper_wick_count}回` },
    { label: "出来高がピークアウトしていない", status: stock.volume_fading ? "warn" : "ok", detail: stock.volume_fading ? "減少傾向" : "維持" },
    { label: "板が薄すぎない", status: stock.thin_order_book ? "warn" : "ok", detail: stock.thin_order_book ? "薄い可能性" : "通常" },
    { label: "重要イベント直前ではない", status: stock.event_risk ? "warn" : "ok", detail: stock.event_risk ? "イベントリスクあり" : "通常" },
  ];
}

// ---------------------------------------------------------------------------
// ペーパートレード（集計・決済・自動売買）
// ---------------------------------------------------------------------------

function planStopAndTarget(entryPrice, vwap) {
  const rawStop = Math.min(vwap, entryPrice * 0.985);
  const stopPrice = ceilTo(rawStop, 2); // エントリー側に丸めて想定損失の超過を防ぐ
  const stopWidth = roundTo(entryPrice - stopPrice, 2);
  const targetPrice = roundTo(entryPrice + stopWidth * 1.5, 2);
  return { stopPrice, stopWidth, targetPrice };
}

function normalizeQuantity(quantity, preset) {
  const step = preset.quantity_step;
  return roundTo(floorSteps(quantity, step) * step, 4);
}

function countConsecutiveLosses(trades) {
  const closed = trades
    .filter((t) => t.status === "closed")
    .sort((a, b) => (b.closed_at || "").localeCompare(a.closed_at || ""));
  let streak = 0;
  for (const trade of closed) {
    const pnl = Number(trade.realized_pnl || 0);
    if (pnl < 0) streak += 1;
    else if (pnl > 0) break;
  }
  return streak;
}

async function summarizePaperTrades(trades, settings) {
  const merged = { ...DEFAULT_RISK_SETTINGS, ...(settings || {}) };
  const capital = Number(merged.capital_amount);
  const maxLossPerDay = Number(merged.max_loss_per_day);
  const maxStreak = Number(merged.max_consecutive_losses);
  const today = todayJst();

  const open = trades.filter((t) => t.status === "open");
  const closed = trades.filter((t) => t.status === "closed");
  const realizedPnl = closed.reduce((sum, t) => sum + Number(t.realized_pnl || 0), 0);
  const todayClosed = closed.filter((t) => (t.closed_at || "").slice(0, 10) === today);
  const todayRealizedPnl = todayClosed.reduce((sum, t) => sum + Number(t.realized_pnl || 0), 0);
  const todayRealizedLoss = Math.max(0, -todayRealizedPnl);

  let unrealized = 0;
  let positionValue = 0;
  let openRisk = 0;
  const unknown = [];
  for (const trade of open) {
    let price = await currentStockPrice(trade.symbol);
    if (price == null) {
      unknown.push(trade.symbol);
      price = Number(trade.entry_price);
    }
    unrealized += (price - Number(trade.entry_price)) * Number(trade.quantity);
    positionValue += Number(trade.position_value || 0);
    openRisk += Number(trade.estimated_loss || 0);
  }

  const winning = closed.filter((t) => Number(t.realized_pnl || 0) > 0);
  const losing = closed.filter((t) => Number(t.realized_pnl || 0) < 0);
  const winRate = closed.length ? (winning.length / closed.length) * 100 : 0;
  const avgWin = winning.length ? winning.reduce((s, t) => s + Number(t.realized_pnl), 0) / winning.length : 0;
  const avgLoss = losing.length ? losing.reduce((s, t) => s + Number(t.realized_pnl), 0) / losing.length : 0;

  let cumulative = 0, peak = 0, maxDrawdown = 0;
  for (const trade of [...closed].sort((a, b) => (a.closed_at || "").localeCompare(b.closed_at || ""))) {
    cumulative += Number(trade.realized_pnl || 0);
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.min(maxDrawdown, cumulative - peak);
  }

  const byStrategy = {};
  for (const trade of closed) {
    const key = trade.strategy_type || "UNKNOWN";
    const bucket = (byStrategy[key] = byStrategy[key] || { trades: 0, wins: 0, losses: 0, total_pnl: 0 });
    const pnl = Number(trade.realized_pnl || 0);
    bucket.trades += 1;
    bucket.total_pnl = roundTo(bucket.total_pnl + pnl, 2);
    if (pnl > 0) bucket.wins += 1;
    else if (pnl < 0) bucket.losses += 1;
  }
  for (const bucket of Object.values(byStrategy)) {
    bucket.win_rate = roundTo(bucket.trades ? (bucket.wins / bucket.trades) * 100 : 0, 1);
  }

  const availableDailyRisk = Math.max(0, maxLossPerDay - openRisk - todayRealizedLoss);
  const consecutiveLosses = countConsecutiveLosses(trades);
  const haltReasons = [];
  if (maxLossPerDay - todayRealizedLoss - openRisk <= 0) haltReasons.push("本日の損失上限に到達");
  if (consecutiveLosses >= maxStreak) haltReasons.push(`${consecutiveLosses}連敗中（上限${maxStreak}連敗）`);

  return {
    capital_amount: roundTo(capital, 2),
    open_positions: open.length,
    closed_trades: closed.length,
    position_value: roundTo(positionValue, 2),
    available_capital: roundTo(Math.max(0, capital + realizedPnl - positionValue), 2),
    open_risk: roundTo(openRisk, 2),
    today_realized_pnl: roundTo(todayRealizedPnl, 2),
    today_realized_loss: roundTo(todayRealizedLoss, 2),
    available_daily_risk: roundTo(availableDailyRisk, 2),
    max_loss_per_day: roundTo(maxLossPerDay, 2),
    realized_pnl: roundTo(realizedPnl, 2),
    unrealized_pnl: roundTo(unrealized, 2),
    total_pnl: roundTo(realizedPnl + unrealized, 2),
    wins: winning.length,
    losses: losing.length,
    win_rate: roundTo(winRate, 1),
    avg_win: roundTo(avgWin, 2),
    avg_loss: roundTo(avgLoss, 2),
    max_drawdown: roundTo(maxDrawdown, 2),
    by_strategy: byStrategy,
    consecutive_losses: consecutiveLosses,
    max_consecutive_losses: maxStreak,
    halted: haltReasons.length > 0,
    halt_reasons: haltReasons,
    unknown_symbols: unknown,
  };
}

async function settlePaperTrades(trades, { forceClose = false, priceOverrides = {} } = {}) {
  const closed = [];
  for (const trade of trades) {
    if (trade.status !== "open") continue;
    const override = priceOverrides[trade.symbol];
    const currentPrice = override != null && override > 0 ? override : await currentStockPrice(trade.symbol);
    let exitReason = null;
    let exitPrice = null;

    if (currentPrice == null) {
      if (forceClose) { exitReason = "manual_close"; exitPrice = Number(trade.entry_price); }
      else continue;
    } else if (forceClose) { exitReason = "manual_close"; exitPrice = currentPrice; }
    else if (currentPrice <= Number(trade.stop_price)) { exitReason = "stop_loss"; exitPrice = Number(trade.stop_price); }
    else if (currentPrice >= Number(trade.target_price)) { exitReason = "take_profit"; exitPrice = Number(trade.target_price); }

    if (exitReason == null) continue;
    trade.status = "closed";
    trade.exit_price = roundTo(exitPrice, 2);
    trade.exit_reason = exitReason;
    trade.realized_pnl = roundTo((exitPrice - Number(trade.entry_price)) * Number(trade.quantity), 2);
    trade.closed_at = nowJstIso();
    closed.push(trade);
  }
  return closed;
}

function isSupportedByBroker(stock, brokerMode) {
  if (!brokerMode || brokerMode === "all") return true;
  return (stock.supported_brokers || []).includes(brokerMode);
}

function isPaperAutoCandidate(stock, brokerMode) {
  const score = scoreStock(stock);
  const hasShape = stock.pullback || stock.breakout;
  const blockingRisk = stock.volume_fading || stock.thin_order_book || stock.event_risk || stock.upper_wick_count >= 3;
  return isSupportedByBroker(stock, brokerMode) && score.total_score >= 65 && stock.above_vwap && hasShape && !blockingRisk;
}

function buildPaperTrade(stock, quantity, preset) {
  const entryPrice = stock.price;
  const { stopPrice, stopWidth, targetPrice } = planStopAndTarget(entryPrice, stock.vwap);
  return {
    id: uuid(),
    symbol: stock.symbol,
    stock_name: stock.name,
    strategy_type: stock.pullback ? "VWAP_PULLBACK" : "BREAKOUT_MONITOR",
    status: "open",
    mode: "paper_only",
    broker_mode: preset.label,
    entry_price: entryPrice,
    stop_price: stopPrice,
    target_price: targetPrice,
    quantity,
    position_value: roundTo(entryPrice * quantity, 2),
    estimated_loss: roundTo(stopWidth * quantity, 2),
    risk_reward: 1.5,
    opened_at: nowJstIso(),
    notes: "実注文ではありません。条件一致時の仮想購入ログです。",
  };
}

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function runPaperAutoTrading(req) {
  const defaults = {
    capital_amount: 30000, max_loss_per_trade: 300, max_loss_per_day: 600, max_positions: 2,
    max_consecutive_losses: 3, broker_mode: "sbi_s_stock", order_amount_per_trade: null,
    enforce_time_window: true, trade_start_time: "09:05", new_entry_end_time: "11:30",
  };
  const p = { ...defaults, ...req };
  if (!BROKER_PRESETS[p.broker_mode]) throw { status: 400, detail: "Unsupported broker mode" };
  for (const key of ["trade_start_time", "new_entry_end_time"]) {
    if (!HHMM_RE.test(p[key])) throw { status: 422, detail: `${key} はHH:MM形式で指定してください` };
  }
  const preset = BROKER_PRESETS[p.broker_mode];
  const settings = {
    capital_amount: p.capital_amount, max_loss_per_trade: p.max_loss_per_trade, max_loss_per_day: p.max_loss_per_day,
    max_positions: p.max_positions, max_consecutive_losses: p.max_consecutive_losses, broker_mode: p.broker_mode,
    order_amount_per_trade: p.order_amount_per_trade, enforce_time_window: p.enforce_time_window,
  };
  store.write("settings", settings);
  const trades = readPaperTrades();
  const closed = await settlePaperTrades(trades);
  if (closed.length) writePaperTrades(trades);

  const { stocks: marketStocks, meta: marketMeta } = await getMarketStocks();

  const respond = async (message, created = [], skipped = []) => ({
    mode: "paper_only",
    real_order_enabled: false,
    message,
    data_source: marketMeta.data_source,
    created,
    closed,
    skipped,
    summary: {
      ...(await summarizePaperTrades(trades, settings)),
      broker_mode: preset.label,
      allow_fractional: preset.allow_fractional,
      min_order_amount: preset.min_order_amount,
    },
  });

  if (p.enforce_time_window && !(await isTradingDayToday())) {
    return respond("本日は休場日のため、新規の仮想購入は行いません。");
  }
  if (p.enforce_time_window && (nowHhmm() < p.trade_start_time || nowHhmm() >= p.new_entry_end_time)) {
    return respond(`朝トレ時間（${p.trade_start_time}〜${p.new_entry_end_time}）の外のため、新規の仮想購入は行いません。保有分の利確・損切りチェックは継続します。`);
  }
  if (useRealData() && marketMeta.data_source !== "yahoo") {
    return respond("実データを取得できないため、新規の仮想購入を停止中です。接続とプロキシ設定を確認してください。");
  }
  if (marketStocks.length && marketStocks.every((s) => s.is_previous_session)) {
    return respond("当日の市場データがまだありません（前営業日データを表示中）。寄り付き後に再実行してください。");
  }

  const summary = await summarizePaperTrades(trades, settings);
  if (summary.available_daily_risk <= 0) {
    return respond("本日の損失上限に到達したため、新規の仮想購入を停止中です。明日まで待つか、リセットしてルールを見直してください。");
  }
  const streak = summary.consecutive_losses;
  if (streak >= p.max_consecutive_losses) {
    return respond(`${streak}連敗中のため、新規の仮想購入を停止中です。ロット・条件を見直してから再開してください。`);
  }

  const openTrades = trades.filter((t) => t.status === "open");
  const usedCapital = openTrades.reduce((sum, t) => sum + Number(t.position_value || 0), 0);
  const realizedPnl = trades.filter((t) => t.status === "closed").reduce((sum, t) => sum + Number(t.realized_pnl || 0), 0);
  let availableCapital = p.capital_amount + realizedPnl - usedCapital;
  let availableDailyRisk = summary.available_daily_risk;
  const created = [];
  const skipped = [];

  if (availableCapital <= 0) {
    return respond("仮想資金の上限に達しているため、新規の仮想購入は行いません。");
  }

  const today = todayJst();
  const lossClosedToday = new Set(
    trades
      .filter((t) => t.status === "closed" && Number(t.realized_pnl || 0) < 0 && (t.closed_at || "").slice(0, 10) === today)
      .map((t) => t.symbol),
  );

  const candidates = marketStocks
    .filter((s) => isPaperAutoCandidate(s, p.broker_mode) && !s.is_previous_session)
    .sort((a, b) => scoreStock(b).total_score - scoreStock(a).total_score);

  let warningMessage = "";
  if (streak > 0 && streak === p.max_consecutive_losses - 1) {
    warningMessage = `警告: ${streak}連敗中です。あと1敗で新規購入を停止します。`;
  }

  for (const stock of candidates) {
    if ([...openTrades, ...created].some((t) => t.symbol === stock.symbol)) {
      skipped.push({ symbol: stock.symbol, reason: "同一銘柄を保有中" });
      continue;
    }
    if (lossClosedToday.has(stock.symbol)) {
      skipped.push({ symbol: stock.symbol, reason: "本日損失決済済みのため再エントリー回避" });
      continue;
    }
    if (openTrades.length + created.length >= p.max_positions) {
      skipped.push({ symbol: stock.symbol, reason: "最大同時保有数に到達" });
      continue;
    }
    const entryPrice = stock.price;
    const { stopWidth } = planStopAndTarget(entryPrice, stock.vwap);
    if (stopWidth <= 0) {
      skipped.push({ symbol: stock.symbol, reason: "損切り幅を計算できない" });
      continue;
    }
    const perTradeCapital = Math.min(availableCapital, p.order_amount_per_trade || availableCapital);
    const riskLimitedQty = p.max_loss_per_trade / stopWidth;
    const capitalLimitedQty = perTradeCapital / entryPrice;
    const quantity = normalizeQuantity(Math.min(riskLimitedQty, capitalLimitedQty), preset);
    const positionValue = entryPrice * quantity;

    if (quantity <= 0) {
      skipped.push({ symbol: stock.symbol, reason: "元本または許容損失に対して株数が不足" });
      continue;
    }
    if (positionValue < preset.min_order_amount) {
      skipped.push({ symbol: stock.symbol, reason: "証券会社プリセットの最低注文金額未満" });
      continue;
    }
    const estimatedLoss = stopWidth * quantity;
    if (estimatedLoss > availableDailyRisk) {
      skipped.push({ symbol: stock.symbol, reason: "1日最大損失の残枠を超過" });
      continue;
    }
    const trade = buildPaperTrade(stock, quantity, preset);
    created.push(trade);
    availableCapital -= trade.position_value;
    availableDailyRisk -= trade.estimated_loss;
  }

  if (created.length) {
    trades.push(...created);
    writePaperTrades(trades);
  }
  let message = "実注文は行っていません。条件に合った銘柄をペーパー取引として記録しました。";
  if (warningMessage) message = `${message} ${warningMessage}`;
  return respond(message, created, skipped);
}

// ---------------------------------------------------------------------------
// 日誌
// ---------------------------------------------------------------------------

function detectRuleViolations(payload, settings) {
  const violations = [];
  if (payload.planned_stop_price == null) {
    violations.push("損切り価格が未設定");
  } else if (payload.planned_stop_price >= payload.entry_price) {
    violations.push("損切り価格がエントリー価格以上");
  } else {
    const estimatedLoss = (payload.entry_price - payload.planned_stop_price) * payload.quantity;
    if (estimatedLoss > settings.max_loss_per_trade) {
      violations.push(`想定損失 ${Math.round(estimatedLoss).toLocaleString("ja-JP")}円 が1回許容損失 ${Math.round(settings.max_loss_per_trade).toLocaleString("ja-JP")}円 を超過（ロット過大）`);
    }
  }
  const positionValue = payload.entry_price * payload.quantity;
  if (positionValue > settings.capital_amount) {
    violations.push(`建玉金額 ${Math.round(positionValue).toLocaleString("ja-JP")}円 が資金額 ${Math.round(settings.capital_amount).toLocaleString("ja-JP")}円 を超過`);
  }
  return violations;
}

function isoWeekKey(dateStr) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "不明";
  const day = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((thursday - firstThursday) / (7 * 86400_000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function aggregateJournals(journals, keyFn) {
  const buckets = {};
  for (const item of journals) {
    const key = keyFn(item.trade_date || "");
    const bucket = (buckets[key] = buckets[key] || { period: key, trades: 0, total_pnl: 0, wins: 0, losses: 0, rule_followed: 0 });
    bucket.trades += 1;
    const pnl = item.realized_pnl;
    if (pnl != null) {
      bucket.total_pnl = roundTo(bucket.total_pnl + Number(pnl), 2);
      if (pnl > 0) bucket.wins += 1;
      else if (pnl < 0) bucket.losses += 1;
    }
    if (item.rule_followed) bucket.rule_followed += 1;
  }
  return Object.values(buckets)
    .map((b) => ({
      ...b,
      win_rate: roundTo(b.wins + b.losses ? (b.wins / (b.wins + b.losses)) * 100 : 0, 1),
      rule_follow_rate: roundTo(b.trades ? (b.rule_followed / b.trades) * 100 : 0, 1),
    }))
    .sort((a, b) => b.period.localeCompare(a.period));
}

function createDailyReview(targetDate) {
  const journals = readJournals().filter((item) => item.trade_date === targetDate);
  if (!journals.length) {
    return {
      trade_date: targetDate,
      review: "対象日の取引日誌がありません。まずはエントリー理由、損切り予定、ルール遵守を記録してください。",
      problems: [],
      improvements: ["取引前に損切り価格と許容損失を必ず入力する"],
    };
  }
  const totalPnl = journals.reduce((sum, item) => sum + Number(item.realized_pnl || 0), 0);
  const ruleBreaks = journals.filter((item) => !item.rule_followed);
  const violationItems = journals.filter((item) => (item.rule_violations || []).length);
  const lossTrades = journals.filter((item) => Number(item.realized_pnl || 0) < 0);
  const emotions = journals.flatMap((item) => item.emotion_tags || []);

  const problems = [];
  const improvements = [];
  if (ruleBreaks.length) {
    problems.push(`ルール違反の取引が${ruleBreaks.length}件あります`);
    improvements.push("翌日はルール違反が出た時点で新規取引を停止する");
  }
  if (violationItems.length) {
    const detail = [...new Set(violationItems.flatMap((item) => item.rule_violations))].sort().join("、");
    problems.push(`記録時の自動チェックで${violationItems.length}件の警告（${detail}）`);
    improvements.push("損切り価格とロットを決めてからエントリーを記録する");
  }
  if (lossTrades.length >= 2) {
    problems.push("損失取引が複数回発生しています");
    improvements.push("連敗後はロットを下げるか、取引を一時停止する");
  }
  if (emotions.includes("焦り")) {
    problems.push("焦りによるエントリーが記録されています");
    improvements.push("成行で飛び乗る前に、VWAPと損切り位置を再確認する");
  }
  if (totalPnl < 0) improvements.push("明日は1回の許容損失を小さくし、取引回数を制限する");
  if (!problems.length) {
    problems.push("大きなルール違反は記録されていません");
    improvements.push("同じ条件だけを再現できるよう、エントリー理由をさらに具体化する");
  }
  const review = `${targetDate} の取引は ${journals.length} 件、合計損益は ${Math.round(totalPnl).toLocaleString("ja-JP")} 円です。売買判断を断定せず、次回は条件一致度と損失上限を先に確認してください。`;
  return {
    trade_date: targetDate,
    review: sanitizeExpression(review),
    problems: problems.map(sanitizeExpression),
    improvements: improvements.map(sanitizeExpression),
  };
}

// ---------------------------------------------------------------------------
// ローカルAPIルーター（fetch('/api/...') の置き換え）
// ---------------------------------------------------------------------------

const SYMBOL_RE = /^[0-9][0-9A-Z]{3,7}$/;
const WATCH_SYMBOL_RE = /^[0-9][0-9A-Z]{3}$/;

async function localApi(path, options = {}) {
  const [rawPath, rawQuery] = path.split("?");
  const query = new URLSearchParams(rawQuery || "");
  const method = (options.method || "GET").toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};

  // --- ヘルス・設定 ---
  if (rawPath === "/api/health") return { status: "ok", time: nowJstIso() };
  if (rawPath === "/api/brokers") return { brokers: BROKER_PRESETS };
  if (rawPath === "/api/settings") return { settings: readRiskSettings() };

  // --- データ設定（PWA固有）---
  if (rawPath === "/api/data-config" && method === "GET") {
    return { proxy_url: readProxyUrl(), mode: useRealData() ? "yahoo" : "unconfigured" };
  }
  if (rawPath === "/api/data-config" && method === "POST") {
    const url = String(body.proxy_url || "").trim();
    if (url && !/^https:\/\/.+/.test(url)) throw { status: 400, detail: "プロキシURLは https:// で始まる必要があります" };
    store.write("proxy_url", url);
    clearYahooCache();
    return { proxy_url: url, mode: url ? "yahoo" : "unconfigured" };
  }

  // --- J-Quants ---
  if (rawPath === "/api/jquants/status") return { status: jq.statusSummary() };
  if (rawPath === "/api/jquants/credentials" && method === "POST") {
    if (!String(body.api_key || "").trim()) {
      throw { status: 422, detail: "J-Quants V2のAPIキーを入力してください" };
    }
    const result = await jq.saveApiKey(body.api_key);
    if (!result.ok) throw { status: 400, detail: result.message };
    clearYahooCache();
    return { message: result.message, status: jq.statusSummary() };
  }
  if (rawPath === "/api/jquants/credentials" && method === "DELETE") {
    jq.clearCredentials();
    return { message: "J-Quants連携を解除しました", status: jq.statusSummary() };
  }
  if (rawPath === "/api/jquants/pause" && method === "POST") {
    if (!jq.hasApiKey()) throw { status: 400, detail: "J-QuantsのAPIキーが設定されていません" };
    const paused = Boolean(body.paused);
    jq.setPaused(paused);
    clearYahooCache();
    return {
      message: paused ? "J-Quants連携を一時停止しました" : "J-Quants連携を再開しました",
      status: jq.statusSummary(),
    };
  }

  // --- 監視リスト ---
  if (rawPath === "/api/watchlist" && method === "GET") {
    return { symbols: readWatchlist(), data_source: useRealData() ? "yahoo" : "unconfigured" };
  }
  if (rawPath === "/api/watchlist" && method === "POST") {
    if (!WATCH_SYMBOL_RE.test(body.symbol || "")) throw { status: 422, detail: "銘柄コードの形式が不正です" };
    let symbols = readWatchlist();
    if (body.action === "add") {
      if (symbols.includes(body.symbol)) throw { status: 400, detail: "すでに監視リストにあります" };
      if (symbols.length >= 30) throw { status: 400, detail: "監視リストは30銘柄までです" };
      symbols.push(body.symbol);
    } else if (body.action === "remove") {
      if (!symbols.includes(body.symbol)) throw { status: 404, detail: "監視リストにない銘柄です" };
      if (symbols.length <= 1) throw { status: 400, detail: "監視リストを空にはできません" };
      if (readPaperTrades().some((t) => t.symbol === body.symbol && t.status === "open")) {
        throw { status: 400, detail: "保有中のペーパー建玉があるため削除できません。先に決済してください" };
      }
      symbols = symbols.filter((s) => s !== body.symbol);
    } else {
      throw { status: 422, detail: "action は add / remove を指定してください" };
    }
    saveWatchlist(symbols);
    clearYahooCache();
    return { symbols };
  }

  // --- 銘柄 ---
  if (rawPath === "/api/stocks/candidates") {
    const brokerMode = query.get("broker_mode");
    if (brokerMode && brokerMode !== "all" && !BROKER_PRESETS[brokerMode]) {
      throw { status: 400, detail: "Unsupported broker mode" };
    }
    if (query.get("refresh") === "1") clearYahooCache();
    const { stocks, meta } = await getMarketStocks();
    const payloads = stocks
      .filter((s) => isSupportedByBroker(s, brokerMode))
      .map(stockPayload)
      .sort((a, b) => b.score.total_score - a.score.total_score);
    return {
      updated_at: nowJstIso(),
      ...meta,
      ...(await marketPhase()),
      jquants: jq.statusSummary(),
      broker_mode: brokerMode || "all",
      stocks: payloads,
    };
  }
  const stockMatch = rawPath.match(/^\/api\/stocks\/([0-9A-Za-z]+)(\/entry-checklist)?$/);
  if (stockMatch) {
    const symbol = stockMatch[1];
    const { stocks, meta } = await getMarketStocks();
    const stock = stocks.find((s) => s.symbol === symbol);
    if (!stock) throw { status: 404, detail: "Stock not found" };
    if (stockMatch[2]) {
      const stopPrice = query.get("stop_price") ? Number(query.get("stop_price")) : null;
      return { symbol, checks: buildEntryChecklist(stock, stopPrice && stopPrice > 0 ? stopPrice : null), ...meta };
    }
    const payload = { ...stockPayload(stock), ...meta };
    if (useRealData()) {
      const reference = await jq.getReferenceStats(symbol);
      if (reference) payload.reference = reference;
    }
    return payload;
  }

  // --- ロット計算 ---
  if (rawPath === "/api/risk/calculate-position-size") {
    const { capital_amount, max_loss_per_trade, entry_price, stop_price, take_profit_price } = body;
    for (const value of [capital_amount, max_loss_per_trade, entry_price, stop_price]) {
      if (!(Number(value) > 0)) throw { status: 422, detail: "入力値は0より大きい数値が必要です" };
    }
    const stopWidth = roundTo(entry_price - stop_price, 4);
    if (stopWidth <= 0) throw { status: 400, detail: "Stop price must be lower than entry price" };
    const warnings = [];
    let maxQuantity = floorSteps(max_loss_per_trade, stopWidth);
    let estimatedLoss = maxQuantity * stopWidth;
    let positionValue = maxQuantity * entry_price;
    if (maxQuantity <= 0) warnings.push("許容損失に対して損切り幅が広すぎます");
    if (positionValue > capital_amount) {
      maxQuantity = floorSteps(capital_amount, entry_price);
      warnings.push("資金額を超えるため、購入可能株数に制限しました");
      estimatedLoss = maxQuantity * stopWidth;
      positionValue = maxQuantity * entry_price;
    }
    if (estimatedLoss > max_loss_per_trade) warnings.push("想定損失が許容損失を超えています");
    let riskReward = null;
    if (take_profit_price != null && take_profit_price > 0) {
      if (take_profit_price <= entry_price) {
        warnings.push("利確価格がエントリー価格以下のため、リスクリワードを計算できません");
      } else {
        riskReward = Math.floor(((take_profit_price - entry_price) / stopWidth) * 100 + 1e-9) / 100;
        if (riskReward < 1) warnings.push("リスクリワードが1未満です。損切り幅に対して利幅が小さすぎます");
      }
    }
    return {
      stop_width: stopWidth,
      max_quantity: maxQuantity,
      estimated_loss: roundTo(estimatedLoss, 2),
      position_value: roundTo(positionValue, 2),
      risk_ratio: roundTo((estimatedLoss / capital_amount) * 100, 2),
      risk_reward: riskReward,
      warnings,
    };
  }

  // --- 日誌 ---
  if (rawPath === "/api/journals" && method === "GET") {
    return { journals: [...readJournals()].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")) };
  }
  if (rawPath === "/api/journals" && method === "POST") {
    if (!SYMBOL_RE.test(body.symbol || "")) throw { status: 422, detail: "銘柄コードの形式が不正です" };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.trade_date || "")) throw { status: 422, detail: "trade_date は YYYY-MM-DD 形式が必要です" };
    if (!(Number(body.entry_price) > 0) || !(Number(body.quantity) > 0)) throw { status: 422, detail: "価格と株数は0より大きい必要があります" };
    const settings = readRiskSettings();
    const violations = detectRuleViolations(body, settings);
    const entry = {
      id: uuid(),
      ...body,
      rule_violations: violations,
      realized_pnl: body.exit_price != null && body.exit_price > 0
        ? roundTo((body.exit_price - body.entry_price) * body.quantity, 2)
        : null,
      created_at: nowJstIso(),
    };
    const journals = readJournals();
    journals.push(entry);
    writeJournals(journals);
    return { journal: entry, warnings: violations };
  }
  if (rawPath === "/api/journals/summary") {
    const journals = readJournals();
    return {
      daily: aggregateJournals(journals, (d) => d || "不明").slice(0, 14),
      weekly: aggregateJournals(journals, isoWeekKey).slice(0, 8),
    };
  }
  if (rawPath === "/api/ai/review-daily") {
    return createDailyReview(body.trade_date || todayJst());
  }

  // --- ペーパートレード ---
  if (rawPath === "/api/paper-trades" && method === "GET") {
    const trades = [...readPaperTrades()].sort((a, b) => (b.opened_at || "").localeCompare(a.opened_at || ""));
    return {
      real_order_enabled: false,
      updated_at: nowJstIso(),
      trades,
      summary: await summarizePaperTrades(trades, readRiskSettings()),
    };
  }
  if (rawPath === "/api/paper-trades/reset") {
    writePaperTrades([]);
    return {
      real_order_enabled: false,
      message: "ペーパー自動売買の履歴をリセットしました。",
      trades: [],
      summary: await summarizePaperTrades([], readRiskSettings()),
    };
  }
  if (rawPath === "/api/paper-trades/settle") {
    const trades = readPaperTrades();
    const closed = await settlePaperTrades(trades, {
      forceClose: Boolean(body.force_close),
      priceOverrides: body.price_overrides || {},
    });
    if (closed.length) writePaperTrades(trades);
    return {
      real_order_enabled: false,
      updated_at: nowJstIso(),
      closed,
      trades: [...trades].sort((a, b) => (b.opened_at || "").localeCompare(a.opened_at || "")),
      summary: await summarizePaperTrades(trades, readRiskSettings()),
    };
  }
  if (rawPath === "/api/paper-trading/auto-run") {
    return runPaperAutoTrading(body);
  }

  throw { status: 404, detail: `Not found: ${rawPath}` };
}

window.TradeCoPilot = { localApi, todayJst };
})();
