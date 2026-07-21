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
    const target = new URL(request.url).searchParams.get("url");
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
