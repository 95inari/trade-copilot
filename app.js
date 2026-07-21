const state = {
  stocks: [],
  selected: null,
  selectSeq: 0,
  paperAutoTimer: null,
  paperAutoRunning: false,
  paperAutoBusy: false,
  brokerFilter: "all",
  notificationsEnabled: false,
  marketHoliday: false,
  ruleAlertTimer: null,
  todayPnl: null,
};

const yen = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0,
});

function formatNumber(value) {
  return new Intl.NumberFormat("ja-JP").format(value);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

// ローカル（JST）の日付。toISOString()はUTCのため0〜9時に前日へずれる
function localDate() {
  return new Date().toLocaleDateString("sv-SE");
}

function formatTime(isoString) {
  if (!isoString) return "";
  const parsed = new Date(isoString);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleTimeString("ja-JP");
}

const shownOnceToasts = new Set();
function showToastOnce(key, message, type = "info") {
  if (shownOnceToasts.has(key)) return;
  shownOnceToasts.add(key);
  showToast(message, type);
}

function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 300);
  }, type === "error" ? 6000 : 3500);
}

// asyncイベントハンドラの未処理rejectionを握りつぶさず、必ずトーストに出す
function bindAsync(handler) {
  return (event) => {
    Promise.resolve(handler(event)).catch((error) => {
      showToast(error.message || "予期しないエラーが発生しました", "error");
    });
  };
}

function describeApiError(detail) {
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        const field = Array.isArray(item.loc) ? item.loc[item.loc.length - 1] : "";
        return field ? `${field}: ${item.msg}` : item.msg;
      })
      .join(" / ");
  }
  return typeof detail === "string" ? detail : "";
}

async function api(path, options = {}) {
  // PWA版: バックエンドサーバーの代わりにブラウザ内エンジン（engine.js）を呼ぶ
  try {
    return await window.TradeCoPilot.localApi(path, options);
  } catch (error) {
    throw new Error(error.detail || error.message || "処理に失敗しました");
  }
}

function updateNotificationStatus() {
  const status = document.getElementById("notificationStatus");
  const ruleButton = document.getElementById("ruleNotificationButton");
  const updateRuleButton = (text, active = false, disabled = false) => {
    if (!ruleButton) return;
    ruleButton.textContent = text;
    ruleButton.classList.toggle("is-active", active);
    ruleButton.disabled = disabled;
  };
  if (!("Notification" in window)) {
    state.notificationsEnabled = false;
    status.textContent = "通知: 非対応";
    status.className = "mini-status is-blocked";
    updateRuleButton("通知非対応", false, true);
    return;
  }

  state.notificationsEnabled = Notification.permission === "granted";
  if (Notification.permission === "granted") {
    status.textContent = "通知: 許可済み";
    status.className = "mini-status is-active";
    updateRuleButton("ルール通知 ON", true);
  } else if (Notification.permission === "denied") {
    status.textContent = "通知: ブロック中";
    status.className = "mini-status is-blocked";
    updateRuleButton("通知ブロック中", false, true);
  } else {
    status.textContent = "通知: 未許可";
    status.className = "mini-status";
    updateRuleButton("ルール通知をON");
  }
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) {
    updateNotificationStatus();
    return false;
  }

  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }

  updateNotificationStatus();
  if (Notification.permission === "granted") checkRuleAlerts();
  return Notification.permission === "granted";
}

function sendAppNotification(title, body, tag) {
  if (!state.notificationsEnabled || !("Notification" in window)) {
    return;
  }

  const options = { body, tag, icon: "./icons/icon-192.png" };

  // モバイル（Android Chrome / iOS PWA）は new Notification() 非対応で例外になるため、
  // Service Worker経由を優先し、通知の失敗で自動売買を止めない
  try {
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.ready
        .then((registration) => registration.showNotification(title, options))
        .catch(() => {});
      return;
    }
    const notification = new Notification(title, options);
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // 通知はベストエフォート
  }
}

function notifyPaperTrade(trade, sideLabel) {
  const reason = EXIT_REASON_LABELS[trade.exit_reason] || trade.exit_reason;
  const title = sideLabel === "売却"
    ? `${reason}: ${trade.stock_name} ${trade.symbol}`
    : `ペーパー購入: ${trade.stock_name} ${trade.symbol}`;
  const detail = sideLabel === "売却"
    ? `決済 ${formatNumber(trade.exit_price)}円 / 損益 ${yen.format(trade.realized_pnl || 0)}`
    : `${formatNumber(trade.quantity)}株 / 利確 ${formatNumber(trade.target_price)}円 / 損切り ${formatNumber(trade.stop_price)}円`;
  sendAppNotification(title, detail, `paper-${sideLabel}-${trade.id}`);
}

function jstClock() {
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return {
    date: date.toISOString().slice(0, 10),
    time: date.toISOString().slice(11, 16),
    weekday: date.getUTCDay(),
  };
}

function notifyRuleOnce(kind, title, body) {
  const { date } = jstClock();
  const key = `tc_rule_alert_${date}_${kind}`;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch (_error) {
    // 保存できない環境では、同一セッション中の通知重複をブラウザ側のtagで抑える
  }
  sendAppNotification(title, body, key);
}

function checkRuleAlerts() {
  if (!state.notificationsEnabled || state.marketHoliday) return;
  const { time, weekday } = jstClock();
  if (weekday === 0 || weekday === 6) return;
  if (time >= "09:05" && time < "11:30") {
    notifyRuleOnce(
      "morning_start",
      "朝トレ時間｜11:30まで",
      "値動きが大きい朝だけ判断します。利確・損切り価格を先に決めてください。",
    );
  } else if (time >= "11:30" && time <= "15:30") {
    notifyRuleOnce(
      "morning_end",
      "朝トレ終了｜今日は追わない",
      "新規エントリーは終了。保有分は利確・損切り到達だけ確認し、次の朝まで待ちます。",
    );
  }
}

function startRuleAlertMonitor() {
  if (state.ruleAlertTimer) return;
  checkRuleAlerts();
  state.ruleAlertTimer = window.setInterval(checkRuleAlerts, 30_000);
}

async function loadSettings() {
  const data = await api("/api/settings");
  const settings = data.settings || {};
  const assign = (id, value) => {
    if (value !== null && value !== undefined) {
      document.getElementById(id).value = value;
    }
  };
  assign("paperCapital", settings.capital_amount);
  assign("paperMaxLoss", settings.max_loss_per_trade);
  assign("paperDailyLoss", settings.max_loss_per_day);
  assign("paperMaxPositions", settings.max_positions);
  assign("paperMaxStreak", settings.max_consecutive_losses);
  // null = 「1銘柄上限なし」。HTMLデフォルトの15000が復活しないよう空欄を明示的に復元する
  document.getElementById("paperOrderAmount").value = settings.order_amount_per_trade ?? "";
  document.getElementById("paperTimeGuard").checked = settings.enforce_time_window ?? true;
  if (settings.broker_mode) {
    document.getElementById("paperBrokerMode").value = settings.broker_mode;
  }
  updateStopLine();
}

const DATA_SOURCE_LABELS = {
  yahoo: "Yahoo Finance（プロキシ経由）",
  unconfigured: "未接続",
  unavailable: "実データ取得失敗",
};

function renderMarketPhase(data) {
  const cell = document.getElementById("marketPhaseCell");
  const label = document.getElementById("marketPhase");
  if (!data.market_phase_label) return;
  state.marketHoliday = data.market_phase === "closed" && data.market_phase_label === "休場日";
  label.textContent = data.market_phase_label;
  cell.classList.toggle("is-morning", data.market_phase === "morning");
}

function jquantsNote(jquantsStatus) {
  if (!jquantsStatus) return "";
  if (!jquantsStatus.configured) {
    return "J-Quants: 未設定（銘柄マスタ・営業日カレンダーは近似動作）";
  }
  return `J-Quants: 併用中（本日 ${jquantsStatus.used}/${jquantsStatus.budget}リクエスト）`;
}

function renderJquantsPanel(status) {
  const badge = document.getElementById("jquantsBadge");
  const setup = document.getElementById("jquantsSetup");
  const connected = document.getElementById("jquantsConnected");

  if (status.configured) {
    badge.textContent = "接続済み";
    badge.className = "mini-status is-active";
    setup.hidden = true;
    connected.hidden = false;
    const lines = [
      `<p>V2 APIキー: <strong>${escapeHtml(status.key_label || "設定済み")}</strong></p>`,
      `<p>本日のアプリ内リクエスト: <strong>${escapeHtml(status.used)} / ${escapeHtml(status.budget)}</strong>（上限で自動停止）</p>`,
      `<p>銘柄マスタ: ${status.master_cached ? "取得済み" : "未取得"} / 営業日カレンダー: ${status.calendar_cached ? "取得済み" : "未取得"}</p>`,
      "<p>APIキーはこの端末内だけに保存され、自分専用の中継には保存されません。</p>",
      status.last_error ? `<p><strong>直近のエラー:</strong> ${escapeHtml(status.last_error)}</p>` : "",
    ];
    document.getElementById("jquantsInfo").innerHTML = lines.join("");
  } else {
    badge.textContent = "未設定";
    badge.className = "mini-status";
    setup.hidden = false;
    connected.hidden = true;
  }
}

async function loadJquantsStatus() {
  const data = await api("/api/jquants/status");
  renderJquantsPanel(data.status);
}

async function submitJquantsCredentials(event) {
  event.preventDefault();
  const button = document.querySelector("#jquantsForm button[type=submit]");
  button.disabled = true;
  button.textContent = "APIキーを確認中…";
  try {
    const result = await api("/api/jquants/credentials", {
      method: "POST",
      body: JSON.stringify({
        api_key: document.getElementById("jquantsApiKey").value.trim(),
      }),
    });
    document.getElementById("jquantsApiKey").value = "";
    showToast(result.message || "接続しました", "success");
    renderJquantsPanel(result.status);
    loadCandidates().catch((error) => showToast(error.message, "error"));
  } finally {
    button.disabled = false;
    button.textContent = "接続して保存";
  }
}

async function disconnectJquants() {
  if (!window.confirm("J-Quants連携を解除しますか？（この端末に保存したAPIキーを削除します）")) {
    return;
  }
  const result = await api("/api/jquants/credentials", { method: "DELETE" });
  showToast(result.message || "解除しました", "success");
  renderJquantsPanel(result.status);
}

function renderDataSource(data) {
  renderMarketPhase(data);
  const updated = document.getElementById("watchlistUpdated");
  const timeText = data.fetched_at
    ? `取得 ${formatTime(data.fetched_at)}`
    : data.updated_at
      ? `更新 ${formatTime(data.updated_at)}`
      : "";
  const sourceText = DATA_SOURCE_LABELS[data.data_source] || data.data_source || "";
  updated.textContent = [timeText, sourceText && `データ: ${sourceText}`].filter(Boolean).join(" / ");

  const note = document.getElementById("dataSourceNote");
  if (data.data_source === "yahoo") {
    const failures = (data.data_errors || []).length;
    const prevSession = (data.stocks || []).length && data.stocks.every((s) => s.is_previous_session);
    note.textContent =
      "掲示板・ニュースは未取得のためスコア加点なし。証券会社の取扱可否は目安。遅延データの可能性あり。" +
      (prevSession ? " / 前営業日データを表示中（寄り前・休日）" : "") +
      (failures ? ` / 取得失敗 ${failures}銘柄` : "") +
      ` / ${jquantsNote(data.jquants)}`;
    note.title = (data.data_errors || []).join("\n");
  } else if (data.data_source === "unavailable") {
    note.textContent = "実データを取得できませんでした。ダミー表示には切り替えていません。データ設定と接続を確認してください。";
    note.title = (data.data_errors || []).join("\n");
  } else {
    note.textContent = "価格データは未接続です。ダミーの銘柄・価格・スコアは表示していません。「設定」から実データを接続してください。";
    note.title = "";
  }

  const hasRealData = data.data_source === "yahoo";
  const hasCandidates = hasRealData && (data.stocks || []).length > 0;
  document.querySelector(".watchlist-panel").classList.toggle("is-data-empty", !hasRealData);
  document.querySelector(".analysis-panel").classList.toggle("is-data-empty", !hasCandidates);
  if (!hasCandidates) {
    const unavailable = data.data_source === "unavailable";
    document.getElementById("stockTitle").textContent = hasRealData
      ? "条件に一致する候補がありません"
      : unavailable
        ? "実データを取得できません"
        : "価格データは未接続です";
    document.getElementById("stockMeta").textContent = hasRealData
      ? "監視銘柄または証券会社フィルターを見直してください。"
      : "ダミーデータは表示しません。「設定」からYahooプロキシURLを登録してください。";
    document.getElementById("rankLabel").textContent = "-";
    document.getElementById("rankLabel").className = "rank-badge";
    document.getElementById("totalScore").textContent = "-";
    document.getElementById("checklist").innerHTML = "";
    document.getElementById("scoreBreakdown").innerHTML = "";
    document.getElementById("assistComment").textContent = "";
    document.getElementById("entryPrice").value = "";
    document.getElementById("stopPrice").value = "";
    document.getElementById("journalEntry").value = "";
  }
}

async function loadCandidates() {
  state.brokerFilter = document.getElementById("watchlistBrokerFilter").value;
  const query = state.brokerFilter === "all" ? "" : `?broker_mode=${encodeURIComponent(state.brokerFilter)}`;
  const data = await api(`/api/stocks/candidates${query}`);
  state.stocks = data.stocks;
  renderDataSource(data);
  if (!state.stocks.some((stock) => stock.symbol === state.selected?.symbol)) {
    state.selected = null;
  }
  renderStockRows();
  await selectStock(state.selected?.symbol || state.stocks[0]?.symbol);
}

async function loadWatchlist() {
  const data = await api("/api/watchlist");
  const chips = document.getElementById("watchlistChips");
  chips.innerHTML = (data.symbols || [])
    .map(
      (symbol) => `
        <span class="watch-chip">${escapeHtml(symbol)}
          <button type="button" class="watch-chip-remove" data-symbol="${escapeHtml(symbol)}" title="監視リストから削除">×</button>
        </span>
      `,
    )
    .join("");
  chips.querySelectorAll(".watch-chip-remove").forEach((button) => {
    button.addEventListener(
      "click",
      bindAsync(async () => {
        await api("/api/watchlist", {
          method: "POST",
          body: JSON.stringify({ action: "remove", symbol: button.dataset.symbol }),
        });
        showToast(`${button.dataset.symbol} を監視リストから削除しました`, "success");
        await loadWatchlist();
        await loadCandidates();
      }),
    );
  });
}

async function addWatchlistSymbol() {
  const input = document.getElementById("watchlistAddInput");
  // 全角英数（IME入力）を半角に正規化する
  const symbol = input.value
    .trim()
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toUpperCase();
  if (!/^[0-9][0-9A-Z]{3}$/.test(symbol)) {
    showToast("銘柄コードは 7203 のような4桁で入力してください", "error");
    return;
  }
  await api("/api/watchlist", {
    method: "POST",
    body: JSON.stringify({ action: "add", symbol }),
  });
  input.value = "";
  showToast(`${symbol} を監視リストに追加しました`, "success");
  await loadWatchlist();
  await loadCandidates();
}

function renderStockRows() {
  const tbody = document.getElementById("stockRows");
  tbody.innerHTML = state.stocks
    .map((stock) => {
      const score = stock.score;
      const active = state.selected?.symbol === stock.symbol ? " active" : "";
      const brokerTags = (stock.supported_broker_labels || [])
        .map((label) => `<span class="broker-tag">${escapeHtml(label)}</span>`)
        .join("");
      const staleMark = stock.is_stale
        ? `<span class="stale-mark" title="取得失敗のため前回値を表示中">⚠</span> `
        : "";
      return `
        <tr class="stock-row${active}" data-symbol="${escapeHtml(stock.symbol)}">
          <td>
            <strong>${staleMark}${escapeHtml(stock.name)}</strong>
            <span class="stock-code">${escapeHtml(stock.symbol)} ${escapeHtml(stock.market)}</span>
            <span class="broker-tags">${brokerTags}</span>
          </td>
          <td><span class="small-badge rank-${escapeHtml(score.rank_label)}">${escapeHtml(score.action_label)}</span></td>
          <td>${escapeHtml(score.total_score)}</td>
          <td>${escapeHtml(stock.change_rate)}%</td>
          <td>${escapeHtml(stock.volume_change_rate)}%</td>
        </tr>
      `;
    })
    .join("");

  if (!state.stocks.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="muted">選択した証券会社の取扱銘柄に一致する候補がありません。</td>
      </tr>
    `;
  }

  tbody.querySelectorAll("tr").forEach((row) => {
    if (row.dataset.symbol) {
      row.addEventListener("click", bindAsync(() => selectStock(row.dataset.symbol)));
    }
  });
}

async function fetchChecklist(symbol) {
  const stopValue = Number(document.getElementById("stopPrice").value);
  const query = stopValue > 0 ? `?stop_price=${encodeURIComponent(stopValue)}` : "";
  return api(`/api/stocks/${encodeURIComponent(symbol)}/entry-checklist${query}`);
}

async function refreshChecklist() {
  if (!state.selected) return;
  const seq = state.selectSeq;
  const checklist = await fetchChecklist(state.selected.symbol);
  if (seq !== state.selectSeq) return; // 別銘柄選択後に届いた古いレスポンスは破棄
  renderChecklist(checklist.checks);
}

async function selectStock(symbol) {
  if (!symbol) return;
  const seq = ++state.selectSeq;
  const stock = await api(`/api/stocks/${encodeURIComponent(symbol)}`);
  if (seq !== state.selectSeq) return; // 古いレスポンスは破棄（連打対策）
  state.selected = stock;
  renderStockRows();
  renderSelectedStock(stock);
  const checklist = await fetchChecklist(symbol);
  if (seq !== state.selectSeq) return;
  renderChecklist(checklist.checks);
}

function renderSelectedStock(stock) {
  const score = stock.score;
  document.getElementById("stockTitle").textContent = `${stock.name} ${stock.symbol}`;
  const metaParts = [
    stock.market,
    stock.sector !== "-" ? stock.sector : null,
    `現在値 ${formatNumber(stock.price)}円`,
    `VWAP ${formatNumber(stock.vwap)}円`,
    stock.reference?.avg_range_pct
      ? `平均日中値幅 ${stock.reference.avg_range_pct}%（J-Quants 12週遅延）`
      : null,
    stock.is_previous_session ? `前営業日(${stock.session_date})のデータ` : null,
  ].filter(Boolean);
  document.getElementById("stockMeta").textContent = metaParts.join(" / ");
  const rankLabel = document.getElementById("rankLabel");
  rankLabel.textContent = score.rank_label;
  rankLabel.className = `rank-badge rank-${score.rank_label}`;
  document.getElementById("totalScore").textContent = score.total_score;
  document.getElementById("assistComment").textContent = stock.assist_comment;

  document.getElementById("entryPrice").value = stock.price;
  document.getElementById("stopPrice").value = Math.max(1, Math.round(stock.vwap));
  document.getElementById("journalEntry").value = stock.price;
  document.getElementById("journalExit").value = "";

  renderScoreBreakdown(score.score_breakdown);
  drawChart(stock);
}

function renderChecklist(checks) {
  const root = document.getElementById("checklist");
  root.innerHTML = checks
    .map(
      (check) => `
        <div class="check-item">
          <i class="status-dot status-${escapeHtml(check.status)}"></i>
          <div>
            <strong>${escapeHtml(check.label)}</strong>
            <span>${escapeHtml(check.detail)}</span>
          </div>
          <span>${escapeHtml(check.status.toUpperCase())}</span>
        </div>
      `,
    )
    .join("");
}

function renderScoreBreakdown(breakdown) {
  const maxValues = {
    "値上がり率": 20,
    "出来高増加率": 20,
    "出来高": 15,
    "掲示板投稿数": 10,
    "ニュース材料": 15,
    "チャート形状": 10,
    "リスク": 10,
  };
  const root = document.getElementById("scoreBreakdown");
  root.innerHTML = Object.entries(breakdown)
    .map(([label, value]) => {
      const max = maxValues[label] || 20;
      const width = Math.max(2, Math.min(100, (value / max) * 100));
      return `
        <div class="score-item">
          <span></span>
          <div>
            <strong>${escapeHtml(label)}</strong>
            <span>${escapeHtml(value)} / ${max}</span>
          </div>
          <div class="score-meter"><i style="width:${width}%"></i></div>
        </div>
      `;
    })
    .join("");
}

function drawChart(stock) {
  const canvas = document.getElementById("priceChart");
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !stock.candles?.length) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  ctx.scale(ratio, ratio);

  const width = rect.width;
  const height = rect.height;
  const pad = { top: 28, right: 52, bottom: 44, left: 46 };
  ctx.clearRect(0, 0, width, height);

  const candles = stock.candles;
  const prices = candles.flatMap((candle) => candle.slice(0, 4)).concat(stock.vwap);
  const minPrice = Math.min(...prices) * 0.995;
  const maxPrice = Math.max(...prices) * 1.005;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const y = (price) => pad.top + (maxPrice - price) / (maxPrice - minPrice) * innerH;
  const x = (index) => pad.left + innerW / candles.length * (index + 0.5);

  ctx.strokeStyle = "#d8ded9";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#66737f";
  ctx.font = "12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  for (let i = 0; i <= 4; i += 1) {
    const yy = pad.top + (innerH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(width - pad.right, yy);
    ctx.stroke();
    const price = maxPrice - (maxPrice - minPrice) / 4 * i;
    ctx.fillText(Math.round(price).toLocaleString("ja-JP"), width - pad.right + 8, yy + 4);
  }

  candles.forEach((candle, index) => {
    const [open, high, low, close] = candle;
    const cx = x(index);
    const bodyW = Math.max(22, innerW / candles.length * 0.46);
    const up = close >= open;
    ctx.strokeStyle = up ? "#0f8f75" : "#b43b45";
    ctx.fillStyle = up ? "#0f8f75" : "#b43b45";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, y(high));
    ctx.lineTo(cx, y(low));
    ctx.stroke();
    const top = y(Math.max(open, close));
    const bottom = y(Math.min(open, close));
    ctx.fillRect(cx - bodyW / 2, top, bodyW, Math.max(3, bottom - top));
  });

  ctx.strokeStyle = "#285d9a";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(pad.left, y(stock.vwap));
  ctx.lineTo(width - pad.right, y(stock.vwap));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#285d9a";
  ctx.fillText("VWAP", pad.left + 8, y(stock.vwap) - 8);

  const maxVolume = Math.max(...candles.map((candle) => candle[4]));
  const volumeBase = height - 18;
  candles.forEach((candle, index) => {
    const cx = x(index);
    const volumeHeight = candle[4] / maxVolume * 42;
    ctx.fillStyle = "rgba(31, 41, 51, 0.16)";
    ctx.fillRect(cx - 14, volumeBase - volumeHeight, 28, volumeHeight);
  });

  ctx.fillStyle = "#1f2933";
  ctx.font = "700 13px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.fillText(stock.chart_pattern, pad.left, 20);
}

async function calculateRisk(event) {
  event.preventDefault();
  const takeProfit = Number(document.getElementById("takeProfitPrice").value);
  const payload = {
    capital_amount: Number(document.getElementById("capitalAmount").value),
    max_loss_per_trade: Number(document.getElementById("maxLossPerTrade").value),
    entry_price: Number(document.getElementById("entryPrice").value),
    stop_price: Number(document.getElementById("stopPrice").value),
    take_profit_price: takeProfit > 0 ? takeProfit : null,
  };
  const result = await api("/api/risk/calculate-position-size", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const warnings = result.warnings.length
    ? `<p><strong>警告:</strong> ${result.warnings.map(escapeHtml).join(" / ")}</p>`
    : "";
  const riskReward = result.risk_reward !== null && result.risk_reward !== undefined
    ? `<p>リスクリワード: <strong>${escapeHtml(result.risk_reward)}</strong></p>`
    : "";
  document.getElementById("riskResult").innerHTML = `
    <p>最大株数: <strong>${formatNumber(result.max_quantity)}株</strong></p>
    <p>想定損失: <strong>${yen.format(result.estimated_loss)}</strong></p>
    <p>建玉金額: <strong>${yen.format(result.position_value)}</strong></p>
    <p>資金比リスク: <strong>${escapeHtml(result.risk_ratio)}%</strong></p>
    ${riskReward}
    ${warnings}
  `;
}

async function submitJournal(event) {
  event.preventDefault();
  if (!state.selected) {
    showToast("銘柄を選択してから日誌を登録してください", "error");
    return;
  }
  const emotion = document.getElementById("emotionTag").value;
  const payload = {
    symbol: state.selected.symbol,
    stock_name: state.selected.name,
    trade_date: localDate(),
    entry_reason: document.getElementById("entryReason").value,
    entry_price: Number(document.getElementById("journalEntry").value),
    exit_price: Number(document.getElementById("journalExit").value) || null,
    quantity: Number(document.getElementById("journalQty").value),
    planned_stop_price: Number(document.getElementById("stopPrice").value) || null,
    planned_take_profit_price: Number(document.getElementById("takeProfitPrice").value) || null,
    rule_followed: document.getElementById("ruleFollowed").value === "true",
    emotion_tags: emotion ? [emotion] : [],
    notes: document.getElementById("journalNotes").value,
  };
  const result = await api("/api/journals", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  document.getElementById("journalNotes").value = "";
  showToast("日誌を保存しました", "success");
  (result.warnings || []).forEach((warning) => showToast(`ルール警告: ${warning}`, "error"));
  await updateTodayStats();
  await loadJournalData();
}

function journalCard(item) {
  const pnl = item.realized_pnl;
  const pnlText = pnl === null || pnl === undefined
    ? "未決済"
    : `<span class="${pnl > 0 ? "profit" : pnl < 0 ? "loss" : ""}">${yen.format(pnl)}</span>`;
  const violations = (item.rule_violations || [])
    .map((v) => `<span class="violation-tag">${escapeHtml(v)}</span>`)
    .join("");
  const emotions = (item.emotion_tags || []).map(escapeHtml).join("・");
  return `
    <div class="trade-card">
      <strong>${escapeHtml(item.trade_date)} ${escapeHtml(item.stock_name)} ${escapeHtml(item.symbol)}</strong>
      <span>${escapeHtml(item.entry_reason)} / ${formatNumber(item.quantity)}株 / 入口 ${formatNumber(item.entry_price)}円${item.exit_price ? ` / 出口 ${formatNumber(item.exit_price)}円` : ""} / 損益 ${pnlText}</span>
      <span>ルール遵守: ${item.rule_followed ? "はい" : "いいえ"}${emotions ? ` / 感情: ${emotions}` : ""}</span>
      ${violations ? `<span class="violation-tags">${violations}</span>` : ""}
      ${item.notes ? `<span>${escapeHtml(item.notes)}</span>` : ""}
    </div>
  `;
}

function summaryTable(rows, label) {
  if (!rows.length) return "";
  const body = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.period)}</td>
          <td>${escapeHtml(row.trades)}</td>
          <td class="${row.total_pnl > 0 ? "profit" : row.total_pnl < 0 ? "loss" : ""}">${yen.format(row.total_pnl)}</td>
          <td>${escapeHtml(row.win_rate)}%</td>
          <td>${escapeHtml(row.rule_follow_rate)}%</td>
        </tr>
      `,
    )
    .join("");
  return `
    <p class="summary-label">${escapeHtml(label)}</p>
    <table class="mini-table">
      <thead><tr><th>期間</th><th>件数</th><th>損益</th><th>勝率</th><th>遵守率</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

async function loadJournalData() {
  const [listData, summaryData] = await Promise.all([
    api("/api/journals"),
    api("/api/journals/summary"),
  ]);
  const journals = listData.journals || [];
  document.getElementById("journalCount").textContent = journals.length
    ? `日誌 ${journals.length}件（最新${Math.min(journals.length, 8)}件を表示）`
    : "";
  document.getElementById("journalList").innerHTML = journals.slice(0, 8).map(journalCard).join("");
  document.getElementById("journalSummary").innerHTML =
    summaryTable((summaryData.daily || []).slice(0, 5), "日次集計") +
    summaryTable((summaryData.weekly || []).slice(0, 4), "週次集計");
}

function updateStopLine(todayPnl = null) {
  const dailyLoss = Number(document.getElementById("paperDailyLoss").value) || 600;
  const stopLine = document.getElementById("stopLine");
  const cell = document.getElementById("stopLineCell");
  stopLine.textContent = `-${formatNumber(dailyLoss)}円`;
  if (todayPnl !== null && todayPnl <= -dailyLoss) {
    stopLine.textContent = "停止ライン到達";
    cell.classList.add("is-halted");
  } else {
    cell.classList.remove("is-halted");
  }
}

async function updateTodayStats() {
  const data = await api("/api/journals");
  const today = localDate();
  const todays = data.journals.filter((item) => item.trade_date === today);
  const pnl = todays.reduce((sum, item) => sum + (item.realized_pnl || 0), 0);
  const pnlNode = document.getElementById("todayPnl");
  pnlNode.textContent = yen.format(pnl);
  pnlNode.className = pnl > 0 ? "profit" : pnl < 0 ? "loss" : "";
  document.getElementById("todayTrades").textContent = todays.length;
  state.todayPnl = pnl;
  updateStopLine(pnl);
}

async function generateReview() {
  const review = await api("/api/ai/review-daily", {
    method: "POST",
    body: JSON.stringify({ trade_date: localDate() }),
  });
  document.getElementById("aiReview").innerHTML = `
    <p>${escapeHtml(review.review)}</p>
    <p><strong>問題点</strong></p>
    <ul>${review.problems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    <p><strong>改善案</strong></p>
    <ul>${review.improvements.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
  `;
}

function getPaperAutoPayload() {
  return {
    capital_amount: Number(document.getElementById("paperCapital").value),
    max_loss_per_trade: Number(document.getElementById("paperMaxLoss").value),
    max_loss_per_day: Number(document.getElementById("paperDailyLoss").value),
    max_positions: Number(document.getElementById("paperMaxPositions").value),
    max_consecutive_losses: Number(document.getElementById("paperMaxStreak").value) || 3,
    broker_mode: document.getElementById("paperBrokerMode").value,
    order_amount_per_trade: Number(document.getElementById("paperOrderAmount").value) || null,
    enforce_time_window: document.getElementById("paperTimeGuard").checked,
  };
}

function setPaperAutoRunning(running) {
  state.paperAutoRunning = running;
  const status = document.getElementById("paperAutoStatus");
  const interval = Number(document.getElementById("paperIntervalSeconds").value);
  if (!running) {
    status.textContent = "停止中";
  } else if (!status.textContent.startsWith("稼働中")) {
    status.textContent = `稼働中: ${interval}秒ごとに条件チェック`;
  }
  status.classList.toggle("is-active", running);
  document.getElementById("paperStartButton").disabled = running;
  document.getElementById("paperStopButton").disabled = !running;
  // 稼働中の頻度・証券会社変更は次回開始時から反映のため、混乱を避けてロックする
  document.getElementById("paperIntervalSeconds").disabled = running;
  document.getElementById("paperBrokerMode").disabled = running;
}

function renderHaltNotice(summary) {
  const notice = document.getElementById("paperHaltNotice");
  if (summary?.halted) {
    notice.hidden = false;
    notice.textContent = `取引停止中: ${summary.halt_reasons.join(" / ")}`;
  } else {
    notice.hidden = true;
    notice.textContent = "";
  }
}

async function executePaperAuto() {
  if (state.paperAutoBusy) return; // リクエストが監視間隔を超えた場合の多重実行ガード
  state.paperAutoBusy = true;
  try {
    const payload = getPaperAutoPayload();
    const result = await api("/api/paper-trading/auto-run", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const created = result.created.length
      ? result.created
          .map(
            (trade) =>
              `<li>${escapeHtml(trade.stock_name)} ${escapeHtml(trade.symbol)}: ${formatNumber(trade.quantity)}株 / 建玉 ${yen.format(trade.position_value)} / 想定損失 ${yen.format(trade.estimated_loss)}</li>`,
          )
          .join("")
      : "<li>新規の仮想購入はありません</li>";
    const closed = result.closed.length
      ? result.closed
          .map(
            (trade) =>
              `<li>${escapeHtml(trade.stock_name)} ${escapeHtml(trade.symbol)}: ${escapeHtml(trade.exit_reason)} / 損益 ${yen.format(trade.realized_pnl || 0)}</li>`,
          )
          .join("")
      : "";
    const skipped = result.skipped.length
      ? `<p><strong>見送り:</strong> ${result.skipped.map((item) => `${escapeHtml(item.symbol)} ${escapeHtml(item.reason)}`).join(" / ")}</p>`
      : "";

    document.getElementById("paperAutoResult").innerHTML = `
      <p>${escapeHtml(result.message)}</p>
      <ul>${created}</ul>
      ${closed ? `<p><strong>仮想売却:</strong></p><ul>${closed}</ul>` : ""}
      <p>想定: <strong>${escapeHtml(result.summary.broker_mode)}</strong></p>
      <p>残り仮想資金: <strong>${yen.format(result.summary.available_capital)}</strong></p>
      <p>残り損失枠: <strong>${yen.format(result.summary.available_daily_risk)}</strong></p>
      ${skipped}
    `;
    result.created.forEach((trade) => notifyPaperTrade(trade, "購入"));
    result.closed.forEach((trade) => notifyPaperTrade(trade, "売却"));
    renderPaperSummary(result.summary);
    if (state.paperAutoRunning) {
      const interval = Number(document.getElementById("paperIntervalSeconds").value);
      document.getElementById("paperAutoStatus").textContent =
        `稼働中: ${interval}秒ごとに条件チェック / 最終チェック ${new Date().toLocaleTimeString("ja-JP")}`;
    }
    await loadPaperTrades();
  } finally {
    state.paperAutoBusy = false;
  }
}

async function startPaperAuto() {
  if (state.paperAutoRunning || state.paperAutoTimer) {
    return;
  }

  const maxLoss = Number(document.getElementById("paperMaxLoss").value);
  const dailyLoss = Number(document.getElementById("paperDailyLoss").value);
  if (dailyLoss < maxLoss) {
    showToast("1日損失は1回損失以上に設定してください", "error");
    return;
  }

  // 通知プロンプト表示中の再クリックでintervalがリークしないよう、先に稼働状態にする
  setPaperAutoRunning(true);

  try {
    if ("Notification" in window && Notification.permission === "default") {
      await requestNotificationPermission();
    } else {
      updateNotificationStatus();
    }
    if (!state.paperAutoRunning) return; // 通知プロンプト中に停止された
    await executePaperAuto();
  } catch (error) {
    stopPaperAuto();
    throw error;
  }

  // await中に停止された場合は孤児intervalを作らない
  if (!state.paperAutoRunning || state.paperAutoTimer) return;

  const intervalMs = Number(document.getElementById("paperIntervalSeconds").value) * 1000;
  state.paperAutoTimer = window.setInterval(() => {
    executePaperAuto().catch((error) => {
      document.getElementById("paperAutoResult").innerHTML =
        `<p><strong>エラー:</strong> ${escapeHtml(error.message)}</p>`;
      showToast(`自動売買を停止しました: ${error.message}`, "error");
      stopPaperAuto();
    });
  }, intervalMs);
}

function stopPaperAuto() {
  if (state.paperAutoTimer) {
    window.clearInterval(state.paperAutoTimer);
    state.paperAutoTimer = null;
  }
  setPaperAutoRunning(false);
}

async function resetPaperTrades() {
  const confirmed = window.confirm("ペーパー自動売買の履歴をすべてリセットしますか？");
  if (!confirmed) {
    return;
  }

  stopPaperAuto();
  const result = await api("/api/paper-trades/reset", {
    method: "POST",
    body: JSON.stringify({}),
  });
  document.getElementById("paperAutoResult").innerHTML = `<p>${escapeHtml(result.message)}</p>`;
  showToast("履歴をリセットしました", "success");
  await loadPaperTrades();
}

async function settlePaperTrades(forceClose = false) {
  const result = await api("/api/paper-trades/settle", {
    method: "POST",
    body: JSON.stringify({ force_close: forceClose }),
  });
  const closedText = result.closed.length
    ? result.closed
        .map((trade) => `<li>${escapeHtml(trade.stock_name)} ${escapeHtml(trade.symbol)}: ${escapeHtml(trade.exit_reason)} / 損益 ${yen.format(trade.realized_pnl || 0)}</li>`)
        .join("")
    : "<li>決済対象はありません</li>";
  document.getElementById("paperAutoResult").innerHTML = `
    <p>${forceClose ? "全決済を実行しました。" : "決済条件をチェックしました。"}</p>
    <ul>${closedText}</ul>
  `;
  result.closed.forEach((trade) => notifyPaperTrade(trade, "売却"));
  renderPaperSummary(result.summary);
  await loadPaperTrades();
}

const EXIT_REASON_LABELS = {
  stop_loss: "損切り",
  take_profit: "利確",
  manual_close: "手動決済",
};

function renderPaperSummary(summary) {
  const root = document.getElementById("paperSummary");
  const strategyRoot = document.getElementById("paperStrategyStats");
  renderHaltNotice(summary);
  if (!summary) {
    root.innerHTML = "";
    strategyRoot.innerHTML = "";
    return;
  }
  const pnlClass = (value) => (value > 0 ? "profit" : value < 0 ? "loss" : "");
  root.innerHTML = `
    <div class="summary-cell"><span>評価損益</span><strong class="${pnlClass(summary.unrealized_pnl)}">${yen.format(summary.unrealized_pnl)}</strong></div>
    <div class="summary-cell"><span>確定損益</span><strong class="${pnlClass(summary.realized_pnl)}">${yen.format(summary.realized_pnl)}</strong></div>
    <div class="summary-cell"><span>合計損益</span><strong class="${pnlClass(summary.total_pnl)}">${yen.format(summary.total_pnl)}</strong></div>
    <div class="summary-cell"><span>本日確定</span><strong class="${pnlClass(summary.today_realized_pnl)}">${yen.format(summary.today_realized_pnl || 0)}</strong></div>
    <div class="summary-cell"><span>勝率</span><strong>${escapeHtml(summary.win_rate)}%（${escapeHtml(summary.wins)}勝${escapeHtml(summary.losses)}敗）</strong></div>
    <div class="summary-cell"><span>連敗</span><strong class="${summary.consecutive_losses >= summary.max_consecutive_losses ? "loss" : ""}">${escapeHtml(summary.consecutive_losses)} / ${escapeHtml(summary.max_consecutive_losses)}</strong></div>
    <div class="summary-cell"><span>平均利益</span><strong class="profit">${yen.format(summary.avg_win || 0)}</strong></div>
    <div class="summary-cell"><span>平均損失</span><strong class="${summary.avg_loss < 0 ? "loss" : ""}">${yen.format(summary.avg_loss || 0)}</strong></div>
    <div class="summary-cell"><span>最大DD</span><strong class="${summary.max_drawdown < 0 ? "loss" : ""}">${yen.format(summary.max_drawdown || 0)}</strong></div>
    <div class="summary-cell"><span>保有数</span><strong>${escapeHtml(summary.open_positions)}</strong></div>
    <div class="summary-cell"><span>残り資金</span><strong>${yen.format(summary.available_capital)}</strong></div>
    <div class="summary-cell"><span>残り損失枠</span><strong class="${summary.available_daily_risk <= 0 ? "loss" : ""}">${yen.format(summary.available_daily_risk)}</strong></div>
  `;

  const strategies = Object.entries(summary.by_strategy || {});
  strategyRoot.innerHTML = strategies.length
    ? `
      <p class="summary-label">戦略別成績</p>
      <table class="mini-table">
        <thead><tr><th>戦略</th><th>件数</th><th>勝率</th><th>損益</th></tr></thead>
        <tbody>
          ${strategies
            .map(
              ([name, stats]) => `
                <tr>
                  <td>${escapeHtml(name)}</td>
                  <td>${escapeHtml(stats.trades)}</td>
                  <td>${escapeHtml(stats.win_rate)}%</td>
                  <td class="${stats.total_pnl > 0 ? "profit" : stats.total_pnl < 0 ? "loss" : ""}">${yen.format(stats.total_pnl)}</td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    `
    : "";
}

async function loadPaperTrades() {
  const result = await api("/api/paper-trades");
  renderPaperSummary(result.summary);
  const root = document.getElementById("paperTrades");
  const countNode = document.getElementById("paperTradeCount");
  if (!result.trades.length) {
    root.innerHTML = "";
    countNode.textContent = "";
    return;
  }
  const openCount = result.trades.filter((trade) => trade.status === "open").length;
  countNode.textContent = `履歴 ${result.trades.length}件（保有 ${openCount} / 決済 ${result.trades.length - openCount}）`;
  root.innerHTML = result.trades
    .map(
      (trade) => `
        <div class="trade-card">
          <strong>${escapeHtml(trade.stock_name)} ${escapeHtml(trade.symbol)}</strong>
          <span>${escapeHtml(trade.broker_mode || "ペーパー")} / ${escapeHtml(trade.strategy_type)} / ${formatNumber(trade.quantity)}株 / ${trade.status === "open" ? "保有中" : "決済済み"}</span>
          <span>入口 ${formatNumber(trade.entry_price)}円 / 損切り ${formatNumber(trade.stop_price)}円 / 利確 ${formatNumber(trade.target_price)}円</span>
          ${trade.status === "closed" ? `<span>${escapeHtml(EXIT_REASON_LABELS[trade.exit_reason] || trade.exit_reason)} ${formatNumber(trade.exit_price)}円 / 損益 <span class="${(trade.realized_pnl || 0) > 0 ? "profit" : (trade.realized_pnl || 0) < 0 ? "loss" : ""}">${yen.format(trade.realized_pnl || 0)}</span></span>` : ""}
        </div>
      `,
    )
    .join("");
}

function setupToolTabs() {
  const tabs = [...document.querySelectorAll("[data-tool-tab]")];
  const panels = [...document.querySelectorAll("[data-tool-panel]")];
  const allowedTabs = tabs.map((tab) => tab.dataset.toolTab);
  let savedTab = "risk";

  try {
    savedTab = localStorage.getItem("trade-copilot-active-tool") || "risk";
  } catch (_error) {
    // プライベートブラウズ等で保存できない場合もタブ自体は利用できる
  }

  function activateTool(toolName, shouldFocus = false) {
    const activeName = allowedTabs.includes(toolName) ? toolName : "risk";
    tabs.forEach((tab) => {
      const active = tab.dataset.toolTab === activeName;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && shouldFocus) tab.focus();
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.toolPanel !== activeName;
    });
    try {
      localStorage.setItem("trade-copilot-active-tool", activeName);
    } catch (_error) {
      // 保存不可でも現在の表示は維持する
    }
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateTool(tab.dataset.toolTab));
    tab.addEventListener("keydown", (event) => {
      let nextIndex = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabs.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      activateTool(tabs[nextIndex].dataset.toolTab, true);
    });
  });

  activateTool(savedTab);
}

setupToolTabs();

document.getElementById("refreshButton").addEventListener("click", bindAsync(loadCandidates));
document.getElementById("watchlistBrokerFilter").addEventListener("change", bindAsync(loadCandidates));
document.getElementById("watchlistAddButton").addEventListener("click", bindAsync(addWatchlistSymbol));
document.getElementById("watchlistAddInput").addEventListener("keydown", (event) => {
  // IME変換確定のEnter（isComposing / keyCode 229）では発火させない
  if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    bindAsync(addWatchlistSymbol)(event);
  }
});
document.getElementById("paperBrokerMode").addEventListener("change", bindAsync(async () => {
  document.getElementById("watchlistBrokerFilter").value = document.getElementById("paperBrokerMode").value;
  await loadCandidates();
}));
document.getElementById("riskForm").addEventListener("submit", bindAsync(calculateRisk));
document.getElementById("stopPrice").addEventListener("change", bindAsync(refreshChecklist));
document.getElementById("paperAutoForm").addEventListener("submit", (event) => event.preventDefault());
document.getElementById("paperStartButton").addEventListener("click", bindAsync(startPaperAuto));
document.getElementById("paperStopButton").addEventListener("click", stopPaperAuto);
document.getElementById("paperResetButton").addEventListener("click", bindAsync(resetPaperTrades));
document.getElementById("paperSettleButton").addEventListener("click", bindAsync(() => settlePaperTrades(false)));
document.getElementById("paperCloseAllButton").addEventListener("click", bindAsync(() => settlePaperTrades(true)));
document.getElementById("notificationButton").addEventListener("click", bindAsync(requestNotificationPermission));
document.getElementById("ruleNotificationButton").addEventListener("click", bindAsync(requestNotificationPermission));
document.getElementById("journalForm").addEventListener("submit", bindAsync(submitJournal));
document.getElementById("reviewButton").addEventListener("click", bindAsync(generateReview));
document.getElementById("jquantsForm").addEventListener("submit", bindAsync(submitJquantsCredentials));
document.getElementById("jquantsRefreshButton").addEventListener("click", bindAsync(loadJquantsStatus));
document.getElementById("jquantsDisconnectButton").addEventListener("click", bindAsync(disconnectJquants));
document.getElementById("paperDailyLoss").addEventListener("input", () => updateStopLine(state.todayPnl));
window.addEventListener("resize", () => {
  if (state.selected) drawChart(state.selected);
});

// モバイルではバックグラウンドでタイマーが止まるため、画面復帰時に即チェックする
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkRuleAlerts();
  if (document.visibilityState === "visible" && state.paperAutoRunning && !state.paperAutoBusy) {
    executePaperAuto().catch((error) => showToast(error.message, "error"));
  }
});

async function loadDataConfig() {
  const config = await api("/api/data-config");
  document.getElementById("proxyUrl").value = config.proxy_url || "";
  const note = document.getElementById("dataModeNote");
  note.textContent = config.mode === "yahoo"
    ? "データ中継接続済み: J-QuantsとYahoo Financeを安全に中継します。"
    : "データ中継未接続: J-Quantsと価格データを使うにはプロキシURLを設定してください。";
}

async function saveDataConfig(event) {
  event.preventDefault();
  const result = await api("/api/data-config", {
    method: "POST",
    body: JSON.stringify({ proxy_url: document.getElementById("proxyUrl").value }),
  });
  showToast(result.mode === "yahoo" ? "データ中継URLを保存しました" : "データ中継を解除しました", "success");
  await loadDataConfig();
  await loadCandidates();
}

document.getElementById("dataConfigForm").addEventListener("submit", bindAsync(saveDataConfig));

// --- バックアップ（localStorageはブラウザ都合で消えることがあるため必須機能）---

const BACKUP_KEYS = ["journals", "paper_trades", "settings", "watchlist", "proxy_url"];

function exportAppData() {
  const data = { app: "trade-copilot", version: 1, exported_at: new Date().toISOString() };
  for (const key of BACKUP_KEYS) {
    const raw = localStorage.getItem(`tc_${key}`);
    data[key] = raw === null ? null : JSON.parse(raw);
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `trade-copilot-backup-${localDate()}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  showToast("バックアップをダウンロードしました（認証情報は含まれません）", "success");
}

async function importAppData(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("バックアップファイルを読み込めません（JSONが壊れています）");
  }
  if (data.app !== "trade-copilot") {
    throw new Error("Trade Co-Pilotのバックアップファイルではありません");
  }
  if (!window.confirm("現在の日誌・ペーパー取引・設定をバックアップの内容で上書きします。よろしいですか？")) {
    return;
  }
  for (const key of BACKUP_KEYS) {
    if (data[key] !== null && data[key] !== undefined) {
      localStorage.setItem(`tc_${key}`, JSON.stringify(data[key]));
    }
  }
  showToast("インポートしました。再読み込みします", "success");
  window.setTimeout(() => window.location.reload(), 800);
}

document.getElementById("exportDataButton").addEventListener("click", exportAppData);
document.getElementById("importDataButton").addEventListener("click", () => {
  document.getElementById("importDataFile").click();
});
document.getElementById("importDataFile").addEventListener("change", bindAsync(async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) await importAppData(file);
}));

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

// 初期ロード。candidates（実データ取得で数秒かかり得る）が他の表示を道連れにしないよう並列化する
loadSettings()
  .catch((error) => showToast(`設定の読み込みに失敗: ${error.message}`, "error"))
  .then(() =>
    Promise.allSettled([
      loadWatchlist().then(loadCandidates),
      updateTodayStats(),
      loadPaperTrades(),
      loadJournalData(),
      loadJquantsStatus(),
      loadDataConfig(),
    ]),
  )
  .then((results) => {
    updateNotificationStatus();
    startRuleAlertMonitor();
    results
      .filter((result) => result.status === "rejected")
      .forEach((result) => showToast(result.reason?.message || "読み込みに失敗しました", "error"));
  });
