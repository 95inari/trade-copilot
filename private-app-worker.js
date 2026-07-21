const COOKIE_NAME = "tc_private_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (a.length !== b.length) return false;
  let different = 0;
  for (let index = 0; index < a.length; index += 1) {
    different |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return different === 0;
}

async function sha256(value) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function signExpiry(expiresAt, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(String(expiresAt))));
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator === -1) continue;
    if (item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return "";
}

async function hasValidSession(request, env) {
  const token = readCookie(request, COOKIE_NAME);
  const separator = token.indexOf(".");
  if (separator === -1 || !env.SESSION_SECRET) return false;
  const expiresAt = Number(token.slice(0, separator));
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  const signature = token.slice(separator + 1);
  return safeEqual(signature, await signExpiry(expiresAt, env.SESSION_SECRET));
}

function loginPage({ invalid = false, status = 200 } = {}) {
  const message = invalid
    ? '<p class="error" role="alert">パスワードが違います。もう一度確認してください。</p>'
    : '<p class="note">このアプリは限定公開です。</p>';
  const html = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow,noarchive" />
  <title>Trade Co-Pilot | 限定アクセス</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #18312d; background: #f3f7f5; }
    main { width: min(100%, 430px); padding: 34px; border: 1px solid #d8e3df; border-radius: 24px; background: #fff; box-shadow: 0 20px 55px rgba(24, 49, 45, .12); }
    .eyebrow { margin: 0 0 10px; color: #087b68; font-size: 13px; font-weight: 800; letter-spacing: .12em; }
    h1 { margin: 0; font-size: clamp(25px, 6vw, 34px); line-height: 1.2; }
    .note { margin: 12px 0 24px; color: #65756f; }
    label { display: grid; gap: 8px; font-weight: 800; }
    input { width: 100%; min-height: 52px; padding: 12px 14px; border: 1px solid #bdccc7; border-radius: 12px; font: inherit; }
    input:focus { outline: 3px solid rgba(8, 123, 104, .18); border-color: #087b68; }
    button { width: 100%; min-height: 52px; margin-top: 14px; border: 0; border-radius: 12px; color: #fff; background: #087b68; font: inherit; font-weight: 800; cursor: pointer; }
    button:hover { background: #066655; }
    .error { margin: 12px 0 18px; padding: 11px 12px; border-radius: 10px; color: #982c39; background: #fff0f1; font-weight: 700; }
    .privacy { margin: 18px 0 0; color: #7b8984; font-size: 12px; line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">PRIVATE PWA</p>
    <h1>Trade Co-Pilot</h1>
    ${message}
    <form action="/auth/login" method="post">
      <label>アクセスパスワード
        <input name="password" type="password" autocomplete="current-password" required autofocus />
      </label>
      <button type="submit">アプリを開く</button>
    </form>
    <p class="privacy">認証状態はこのブラウザに30日間保存されます。共有端末では使用しないでください。</p>
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

function redirect(location, cookie) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.ACCESS_PASSWORD_HASH || !env.SESSION_SECRET) {
      return new Response("認証設定が完了していません", { status: 503 });
    }

    if (url.pathname === "/auth/login" && request.method === "POST") {
      const form = await request.formData();
      const password = String(form.get("password") || "").slice(0, 256);
      if (!safeEqual(await sha256(password), env.ACCESS_PASSWORD_HASH)) {
        return loginPage({ invalid: true, status: 401 });
      }
      const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
      const signature = await signExpiry(expiresAt, env.SESSION_SECRET);
      const cookie = `${COOKIE_NAME}=${expiresAt}.${signature}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`;
      return redirect("/", cookie);
    }

    if (url.pathname === "/auth/logout") {
      return redirect("/", `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`);
    }

    if (!(await hasValidSession(request, env))) return loginPage();

    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    headers.set("Vary", "Cookie");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  },
};
