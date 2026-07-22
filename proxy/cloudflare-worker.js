/**
 * Yahoo Finance / J-Quants V2 API 中継用 Cloudflare Worker（無料枠で動作）
 *
 * GitHub Pages版PWAはブラウザからYahooを直接呼べず、J-Quants V2もAPIキーを
 * 送る事前確認が拒否されるため、このWorkerを自分のCloudflareアカウントに
 * デプロイし、そのURLをPWAの「データ設定」に貼り付ける。
 *
 * デプロイ手順（約5分）:
 *   1. https://dash.cloudflare.com/ で無料アカウント作成
 *   2. Workers & Pages → Create Worker
 *   3. このファイルの内容を貼り付けて Deploy
 *   4. 表示されたURL（https://xxx.workers.dev）をPWAのデータ設定に入力
 *
 * 中継先はYahooのチャートAPIと、アプリで使うJ-Quants V2の3 APIだけに制限する。
 * J-QuantsのAPIキーはリクエストヘッダーで受け渡し、保存・ログ出力しない。
 */
const RANKING_SOURCES = [
  { slug: "up", label: "値上がり率上位（市場全体）" },
  { slug: "volumeIncrease", label: "出来高増加率上位（市場全体）" },
  { slug: "tradingValueHigh", label: "売買代金上位（市場全体）" },
];
const MARKET_SCAN_LIMIT = 18;

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function parseRankingState(html) {
  const marker = "window.__PRELOADED_STATE__ = ";
  const start = html.indexOf(marker);
  if (start === -1) throw new Error("ランキングデータが見つかりません");
  const jsonStart = start + marker.length;
  const end = html.indexOf("</script>", jsonStart);
  if (end === -1) throw new Error("ランキングデータが不完全です");
  const state = JSON.parse(html.slice(jsonStart, end).trim());
  return Array.isArray(state?.mainRankingList?.results) ? state.mainRankingList.results : [];
}

async function fetchRanking(source) {
  const response = await fetch(`https://finance.yahoo.co.jp/stocks/ranking/${source.slug}?market=all`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });
  if (!response.ok) throw new Error(`${source.slug}: HTTP ${response.status}`);
  const rows = parseRankingState(await response.text())
    .filter((row) => /^東証(?:PRM|STD|GRT)$/.test(String(row.marketName || "")))
    .filter((row) => /^[0-9A-Z]{4}$/.test(String(row.stockCode || "")))
    .slice(0, 50);
  return { source, rows };
}

async function scanMarket(cors) {
  const settled = await Promise.allSettled(RANKING_SOURCES.map(fetchRanking));
  const successful = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
  const errors = settled
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason?.message || "ランキング取得失敗"));
  if (!successful.length) return json({ error: "市場ランキングを取得できませんでした", errors }, 502, cors);

  const byCode = new Map();
  for (const { source, rows } of successful) {
    rows.forEach((row, index) => {
      const code = String(row.stockCode);
      const candidate = byCode.get(code) || {
        symbol: code,
        name: String(row.stockName || code),
        market: String(row.marketName || "東証"),
        scan_score: 0,
        market_scan_hits: [],
      };
      candidate.scan_score += Math.max(1, 50 - index);
      if (!candidate.market_scan_hits.includes(source.label)) candidate.market_scan_hits.push(source.label);
      byCode.set(code, candidate);
    });
  }

  // 3種類を順番に拾い、値上がり率だけに偏らないようにする。
  const selectedCodes = [];
  for (let index = 0; selectedCodes.length < MARKET_SCAN_LIMIT && index < 50; index += 1) {
    for (const { rows } of successful) {
      const code = String(rows[index]?.stockCode || "");
      if (code && !selectedCodes.includes(code)) selectedCodes.push(code);
      if (selectedCodes.length >= MARKET_SCAN_LIMIT) break;
    }
  }

  const candidates = selectedCodes
    .map((code) => byCode.get(code))
    .filter(Boolean)
    .sort((a, b) => b.scan_score - a.scan_score);
  return json({
    updated_at: new Date().toISOString(),
    ranked_count: byCode.size,
    sources: successful.map(({ source }) => source.label),
    candidates,
    errors,
  }, 200, cors);
}

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-J-Quants-API-Key",
      "Cache-Control": "no-store",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    const requestUrl = new URL(request.url);
    if (requestUrl.searchParams.get("ranking") === "scan") return scanMarket(cors);
    const target = requestUrl.searchParams.get("url");
    // 生文字列ではなくパース・正規化後のURLで検証する
    // （../ によるパストラバーサルでチャートAPI以外へ抜けられるのを防ぐ）
    let parsed;
    try {
      parsed = new URL(target || "");
    } catch {
      parsed = null;
    }
    const yahooHost =
      parsed && ["query1.finance.yahoo.com", "query2.finance.yahoo.com"].includes(parsed.hostname);
    const yahooPath = parsed && parsed.pathname.startsWith("/v8/finance/chart/");
    const jquantsHost = parsed && parsed.hostname === "api.jquants.com";
    const jquantsPaths = new Set([
      "/v2/equities/master",
      "/v2/markets/calendar",
      "/v2/equities/bars/daily",
    ]);
    const jquantsPath = parsed && jquantsPaths.has(parsed.pathname);
    const isYahoo = Boolean(yahooHost && yahooPath);
    const isJquants = Boolean(jquantsHost && jquantsPath);
    if (!parsed || parsed.protocol !== "https:" || (!isYahoo && !isJquants)) {
      return new Response(JSON.stringify({ error: "許可されたデータAPI以外は中継しません" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    const headers = {};
    if (isYahoo) {
      headers["User-Agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
    } else {
      const apiKey = request.headers.get("X-J-Quants-API-Key");
      if (!apiKey) {
        return new Response(JSON.stringify({ error: "J-Quants V2 APIキーが必要です" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
      headers["x-api-key"] = apiKey;
    }

    const upstream = await fetch(parsed.toString(), {
      headers,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...cors },
    });
  },
};
