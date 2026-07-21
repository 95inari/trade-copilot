/**
 * Yahoo Financeチャート API 中継用 Cloudflare Worker（任意・無料枠で動作）
 *
 * GitHub Pages版PWAはブラウザから直接Yahooを叩けない（CORS未対応）ため、
 * リアルタイム価格が必要な場合のみこのWorkerを自分のCloudflareアカウントに
 * デプロイし、そのURLをPWAの「データ設定」に貼り付ける。
 *
 * デプロイ手順（約5分）:
 *   1. https://dash.cloudflare.com/ で無料アカウント作成
 *   2. Workers & Pages → Create Worker
 *   3. このファイルの内容を貼り付けて Deploy
 *   4. 表示されたURL（https://xxx.workers.dev）をPWAのデータ設定に入力
 *
 * 中継先はYahooのチャートAPIのみに制限している（オープンプロキシにしない）。
 */
export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
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
    const allowedHost =
      parsed && ["query1.finance.yahoo.com", "query2.finance.yahoo.com"].includes(parsed.hostname);
    const allowedPath = parsed && parsed.pathname.startsWith("/v8/finance/chart/");
    if (!parsed || parsed.protocol !== "https:" || !allowedHost || !allowedPath) {
      return new Response(JSON.stringify({ error: "Yahoo chart API 以外は中継しません" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
    const upstream = await fetch(parsed.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", ...cors },
    });
  },
};
