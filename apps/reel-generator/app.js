// ▼▼ デプロイ後にWorkerのURLをここに設定（例: https://ccc-reel-generator.xxxx.workers.dev）▼▼
const WORKER_URL = "https://ccc-reel-generator.cationqueen.workers.dev";

const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS_PHOTO = 8 * 60 * 1000; // 原稿が長いとHeyGen側のレンダリングが5分を超えることがあるため余裕を持たせる
const POLL_TIMEOUT_MS_VIDEO = 15 * 60 * 1000; // 動画素材はアバター学習が長くなるため余裕を持たせる
const POLL_TIMEOUT_MS_GESTURE = 60 * 60 * 1000; // 振り付け（ローカルWan2.2）は数十分〜1時間かかることがある

const loginCard = document.getElementById("login-card");
const appCard = document.getElementById("app-card");
const settingsCard = document.getElementById("settings-card");
const inviteInput = document.getElementById("invite-code");
const loginBtn = document.getElementById("login-btn");
const loginStatus = document.getElementById("login-status");
const userLabel = document.getElementById("user-label");
const usageBadge = document.getElementById("usage-badge");

const photoInput = document.getElementById("photo-input");
const videoInput = document.getElementById("video-input");
const photoInputLabel = document.getElementById("photo-input-label");
const photoInputHint = document.getElementById("photo-input-hint");
const videoInputLabel = document.getElementById("video-input-label");
const videoInputHint = document.getElementById("video-input-hint");
const stockInput = document.getElementById("stock-input");
const stockInputLabel = document.getElementById("stock-input-label");
const stockInputHint = document.getElementById("stock-input-hint");
const gestureInputWrap = document.getElementById("gesture-input-wrap");
const gestureInput = document.getElementById("gesture-input");
const scriptInput = document.getElementById("script-input");
const generateBtn = document.getElementById("generate-btn");
const checkStatusBtn = document.getElementById("check-status-btn");
const generateStatus = document.getElementById("generate-status");
const progressDetail = document.getElementById("progress-detail");
const resultVideo = document.getElementById("result-video");
const downloadLink = document.getElementById("download-link");
const publishBtn = document.getElementById("publish-btn");
const publishStatus = document.getElementById("publish-status");

let inviteCode = localStorage.getItem("ccc_reel_invite_code") || "";
let currentJobId = null;

// 生成中にタイムアウト表示になっても、サーバー側（HeyGen）では処理が続いていて
// 実際は完成していることが多い。そこで「再生成」で余計な課金をしないよう、
// 直近のジョブIDをlocalStorageに保持し、いつでも状態だけ再確認できるようにする。
const PENDING_JOB_KEY = "ccc_reel_pending_job";

// 候補数・精度・超解像の組み合わせから、おおよその時間倍率を見積もる
// （タイムアウト・ポーリング時間の目安に使うだけで、実際の生成ロジックには影響しない）。
function estimateTimeMultiplier({ candidateCount, precision, upscale }) {
  return candidateCount * (precision === "high" ? 1.75 : 1) + (upscale ? 0.5 : 0);
}

function savePendingJob(jobId, sourceType, isGesture, quality, postMode) {
  localStorage.setItem(
    PENDING_JOB_KEY,
    JSON.stringify({ jobId, sourceType, isGesture: Boolean(isGesture), quality, postMode, ts: Date.now() })
  );
}
function clearPendingJob() {
  localStorage.removeItem(PENDING_JOB_KEY);
}
function getPendingJob() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_JOB_KEY));
  } catch {
    return null;
  }
}
function refreshPendingJobUi() {
  checkStatusBtn.style.display = getPendingJob() ? "block" : "none";
}

function setStatus(el, message, isError) {
  el.textContent = message || "";
  el.classList.toggle("error", Boolean(isError));
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "X-Invite-Code": inviteCode,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラーが発生しました (${res.status})`);
  return data;
}

function showApp() {
  loginCard.style.display = "none";
  appCard.style.display = "block";
  settingsCard.style.display = "block";
  userLabel.textContent = inviteCode;
  refreshVoiceList().catch(() => {});
  refreshInstagramStatus().catch(() => {});
}

loginBtn.addEventListener("click", async () => {
  const code = inviteInput.value.trim();
  if (!code) return setStatus(loginStatus, "招待コードを入力してください", true);
  inviteCode = code;
  try {
    // 招待コードの有効性はアップロード時にも検証されるが、ここでは簡易に保存だけ行う
    localStorage.setItem("ccc_reel_invite_code", inviteCode);
    setStatus(loginStatus, "");
    showApp();
  } catch (e) {
    setStatus(loginStatus, e.message, true);
  }
});

if (inviteCode) {
  inviteInput.value = inviteCode;
  showApp();
}
refreshPendingJobUi();

function currentSourceType() {
  return document.querySelector('input[name="source-type"]:checked').value;
}

document.querySelectorAll('input[name="source-type"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const type = currentSourceType();
    const showPhoto = type === "photo";
    const showVideo = type === "video";
    const showStock = type === "stock";
    photoInputLabel.style.display = showPhoto ? "block" : "none";
    photoInputHint.style.display = showPhoto ? "block" : "none";
    photoInput.style.display = showPhoto ? "block" : "none";
    videoInputLabel.style.display = showVideo ? "block" : "none";
    videoInputHint.style.display = showVideo ? "block" : "none";
    videoInput.style.display = showVideo ? "block" : "none";
    stockInputLabel.style.display = showStock ? "block" : "none";
    stockInputHint.style.display = showStock ? "block" : "none";
    stockInput.style.display = showStock ? "flex" : "none";
    gestureInputWrap.style.display = showPhoto ? "block" : "none";
    // my_avatar は追加の入力欄が不要（登録済みのIDをそのまま使う）
  });
});

async function uploadMedia(file) {
  const data = await apiFetch("/upload-media", {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  return data.mediaUrl;
}

class PollTimeoutError extends Error {}

function formatElapsed(startedAt) {
  // startedAtはサーバーのSQLite datetime('now')形式（UTC、"YYYY-MM-DD HH:MM:SS"）
  const startMs = Date.parse(startedAt.replace(" ", "T") + "Z");
  const elapsedSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const m = Math.floor(elapsedSec / 60);
  const s = elapsedSec % 60;
  return `${m}分${String(s).padStart(2, "0")}秒`;
}

function showProgress(data) {
  if (!data.label) {
    progressDetail.style.display = "none";
    return;
  }
  const elapsed = data.startedAt ? `経過時間: ${formatElapsed(data.startedAt)}` : "";
  progressDetail.textContent = [data.label, elapsed].filter(Boolean).join(" / ");
  progressDetail.style.display = "block";
}

// タイムアウトは「失敗」ではなく「確認をあきらめた」だけ。
// サーバー側（HeyGen）は裏で処理を続けており、実際には完成することが多いため、
// 呼び出し側はジョブIDを捨てずに、あとで再確認できるようにすること。
async function pollJob(jobId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await apiFetch(`/jobs/${jobId}`);
    if (data.status === "done") return data;
    if (data.status === "error") throw new Error(data.error || "動画生成に失敗しました");
    setStatus(generateStatus, "動画を生成しています...(素材が動画の場合は特に時間がかかります)");
    showProgress(data);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new PollTimeoutError(
    "確認できる時間を超えました。生成自体は裏側で続いている可能性が高いです。しばらくしてから「前回の生成状況を確認する」を押してください（もう一度「動画を生成する」を押すと、二重に課金される新しい動画が作られてしまいます）"
  );
}

// <a download>は、リンク先が別ドメイン（今回はWorker側）だとブラウザに無視され、
// ダウンロードではなく「開く」動作になってしまう。動画を一旦blobとして取得し、
// 同一オリジン扱いのblob URLに変換することで、確実にダウンロードさせる。
// 投稿処理（コンテナ作成→処理待ち→公開）が終わるまでジョブ状態をポーリングする。
// 自動投稿モードでは動画完成直後から、手動投稿モードでは「Instagramに投稿する」ボタン押下後に呼ぶ。
async function pollInstagramPublish(jobId, timeoutMs = 3 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await apiFetch(`/jobs/${jobId}`);
    if (data.instagramStatus === "published") return { status: "published" };
    if (data.instagramStatus === "error") return { status: "error", error: data.instagramError };
    setStatus(publishStatus, "Instagramに投稿しています...");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { status: "timeout" };
}

async function showResult(result, jobId, postMode) {
  const notices = [];
  if (result.photoWarnings?.length) notices.push(...result.photoWarnings);
  if (result.naturalnessFlagged) {
    notices.push("AIチェックで表情や顔に不自然な点が見つかりました。動画を確認し、気になる場合は再生成をお試しください。");
  }
  if (notices.length) {
    setStatus(generateStatus, `完成しました（${notices.join(" / ")}）`, true);
  } else {
    setStatus(generateStatus, "完成しました！");
  }
  progressDetail.style.display = "none";
  resultVideo.src = result.videoUrl;
  resultVideo.style.display = "block";
  clearPendingJob();
  refreshPendingJobUi();

  try {
    const videoRes = await fetch(result.videoUrl);
    const blob = await videoRes.blob();
    downloadLink.href = URL.createObjectURL(blob);
  } catch {
    downloadLink.href = result.videoUrl; // 失敗時は従来通り（新タブで開くだけになる可能性あり）
  }
  downloadLink.setAttribute("download", "reel.mp4");
  downloadLink.style.display = "block";

  setStatus(publishStatus, "");
  if (postMode === "auto") {
    publishBtn.style.display = "none";
    setStatus(publishStatus, "Instagramに投稿しています...");
    const igResult = await pollInstagramPublish(jobId);
    if (igResult.status === "published") {
      setStatus(publishStatus, "Instagramに投稿しました！");
    } else if (igResult.status === "error") {
      setStatus(publishStatus, `Instagramへの投稿に失敗しました: ${igResult.error || ""}`, true);
    } else {
      setStatus(publishStatus, "Instagramへの投稿処理が確認できる時間を超えました。しばらくしてページを再読み込みしてください。", true);
    }
  } else {
    publishBtn.style.display = "block";
  }
}

checkStatusBtn.addEventListener("click", async () => {
  const pending = getPendingJob();
  if (!pending) return;
  checkStatusBtn.disabled = true;
  try {
    setStatus(generateStatus, "前回の生成状況を確認しています...");
    const pendingMultiplier = pending.quality ? estimateTimeMultiplier(pending.quality) : 1;
    const timeoutMs = pending.isGesture
      ? POLL_TIMEOUT_MS_GESTURE * pendingMultiplier
      : pending.sourceType === "video"
        ? POLL_TIMEOUT_MS_VIDEO
        : POLL_TIMEOUT_MS_PHOTO;
    currentJobId = pending.jobId;
    const result = await pollJob(pending.jobId, timeoutMs);
    await showResult(result, pending.jobId, pending.postMode || "manual");
  } catch (e) {
    setStatus(generateStatus, e.message, true);
  } finally {
    checkStatusBtn.disabled = false;
  }
});

generateBtn.addEventListener("click", async () => {
  const sourceType = currentSourceType();
  const needsUpload = sourceType === "photo" || sourceType === "video";
  const file = sourceType === "video" ? videoInput.files[0] : photoInput.files[0];
  const script = scriptInput.value.trim();
  const postMode = document.querySelector('input[name="post-mode"]:checked').value;
  const voiceChoice = document.querySelector('input[name="voice-gender"]:checked').value;
  const isCustomVoice = voiceChoice.startsWith("custom:");
  const voiceGender = isCustomVoice ? "custom" : voiceChoice;
  const customVoiceId = isCustomVoice ? voiceChoice.split(":")[1] : undefined;
  const stockAvatarGender = document.querySelector('input[name="stock-avatar-gender"]:checked')?.value;
  const gesturePrompt = sourceType === "photo" ? gestureInput.value.trim() : "";
  const quality = {
    candidateCount: Number(document.querySelector('input[name="candidate-count"]:checked')?.value || 1),
    precision: document.querySelector('input[name="precision"]:checked')?.value || "normal",
    upscale: document.getElementById("upscale-checkbox")?.checked || false,
  };

  if (needsUpload && !file) {
    return setStatus(
      generateStatus,
      sourceType === "video" ? "動画をアップロードしてください" : "顔写真をアップロードしてください",
      true
    );
  }
  if (!script) return setStatus(generateStatus, "原稿を入力してください", true);

  generateBtn.disabled = true;
  resultVideo.style.display = "none";
  downloadLink.style.display = "none";
  publishBtn.style.display = "none";
  setStatus(publishStatus, "");

  try {
    let mediaUrl;
    if (!needsUpload) {
      setStatus(generateStatus, "音声・動画の生成を開始しています...");
    } else {
      setStatus(generateStatus, sourceType === "video" ? "動画をアップロードしています...(サイズによっては時間がかかります)" : "写真をアップロードしています...");
      mediaUrl = await uploadMedia(file);
      setStatus(generateStatus, "音声・動画の生成を開始しています...");
    }

    const { jobId } = await apiFetch("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        script,
        mediaUrl,
        sourceType,
        postMode,
        voiceGender,
        customVoiceId,
        stockAvatarGender,
        gesturePrompt,
        candidateCount: quality.candidateCount,
        precision: quality.precision,
        upscale: quality.upscale,
      }),
    });
    savePendingJob(jobId, sourceType, Boolean(gesturePrompt), quality, postMode);
    refreshPendingJobUi();
    currentJobId = jobId;

    const qualityTimeoutMultiplier = estimateTimeMultiplier(quality);
    const timeoutMs = gesturePrompt
      ? POLL_TIMEOUT_MS_GESTURE * qualityTimeoutMultiplier
      : sourceType === "video"
        ? POLL_TIMEOUT_MS_VIDEO
        : POLL_TIMEOUT_MS_PHOTO;
    const result = await pollJob(jobId, timeoutMs);
    await showResult(result, jobId, postMode);
  } catch (e) {
    setStatus(generateStatus, e.message, true);
    // タイムアウト以外（原稿未入力・生成失敗など）の場合は、もう completed する見込みがないので
    // pendingジョブを残さない（残すと「確認する」ボタンが意味のない状態で出続けてしまう）。
    if (!(e instanceof PollTimeoutError)) {
      clearPendingJob();
      refreshPendingJobUi();
    }
  } finally {
    generateBtn.disabled = false;
  }
});

const avatarIdInput = document.getElementById("avatar-id-input");
const registerAvatarBtn = document.getElementById("register-avatar-btn");
const avatarRegisterStatus = document.getElementById("avatar-register-status");

registerAvatarBtn.addEventListener("click", async () => {
  const avatarId = avatarIdInput.value.trim();
  if (!avatarId) return setStatus(avatarRegisterStatus, "アバターIDを入力してください", true);
  registerAvatarBtn.disabled = true;
  try {
    setStatus(avatarRegisterStatus, "登録しています...");
    await apiFetch("/register-avatar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatarId }),
    });
    setStatus(avatarRegisterStatus, "登録しました。「自分のアバター」から使えます。");
  } catch (e) {
    setStatus(avatarRegisterStatus, e.message, true);
  } finally {
    registerAvatarBtn.disabled = false;
  }
});

const voiceSampleInput = document.getElementById("voice-sample-input");
const voiceLabelInput = document.getElementById("voice-label-input");
const registerVoiceBtn = document.getElementById("register-voice-btn");
const voiceRegisterStatus = document.getElementById("voice-register-status");
const customVoiceList = document.getElementById("custom-voice-list");
const customVoiceEmptyHint = document.getElementById("custom-voice-empty-hint");

// 登録済みの声を一覧取得し、生成画面の選択肢（ラジオボタン）として描画する
async function refreshVoiceList() {
  const data = await apiFetch("/voice-status");
  const voices = data.voices || [];
  customVoiceList.innerHTML = "";
  const usable = voices.filter((v) => v.status === "complete");
  customVoiceEmptyHint.style.display = usable.length ? "none" : "block";
  for (const v of usable) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "voice-gender";
    input.value = `custom:${v.id}`;
    label.appendChild(input);
    label.appendChild(document.createTextNode(` ${v.label}`));
    customVoiceList.appendChild(label);
  }
  return voices;
}

async function pollVoiceStatus(voiceId) {
  const timeoutMs = 5 * 60 * 1000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const voices = await refreshVoiceList();
    const voice = voices.find((v) => v.id === voiceId);
    if (voice?.status === "complete") return voice;
    if (voice?.status === "error") throw new Error("ボイスクローンの作成に失敗しました");
    setStatus(voiceRegisterStatus, "声を登録しています...(数分かかることがあります)");
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("確認できる時間を超えました。しばらくしてからページを再読み込みして確認してください");
}

registerVoiceBtn.addEventListener("click", async () => {
  const file = voiceSampleInput.files[0];
  if (!file) return setStatus(voiceRegisterStatus, "話している動画をアップロードしてください", true);
  const label = voiceLabelInput.value.trim();
  registerVoiceBtn.disabled = true;
  try {
    setStatus(voiceRegisterStatus, "動画をアップロードしています...");
    const mediaUrl = await uploadMedia(file);
    setStatus(voiceRegisterStatus, "音声を抽出してボイスクローンを作成しています...");
    const { id } = await apiFetch("/register-voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaUrl, label }),
    });
    await pollVoiceStatus(id);
    setStatus(voiceRegisterStatus, "声の登録が完了しました。");
    voiceLabelInput.value = "";
    voiceSampleInput.value = "";
  } catch (e) {
    setStatus(voiceRegisterStatus, e.message, true);
  } finally {
    registerVoiceBtn.disabled = false;
  }
});

// Instagramアプリ ID（公開情報。Facebookアプリ全体のIDとは別物で、こちらは秘密にする必要がない）
const INSTAGRAM_APP_ID = "1612137493666687";
const INSTAGRAM_OAUTH_REDIRECT_URI = `${WORKER_URL}/instagram-oauth-callback`;

const connectInstagramBtn = document.getElementById("connect-instagram-btn");
const instagramConnectStatus = document.getElementById("instagram-connect-status");
const instagramConnectedStatus = document.getElementById("instagram-connected-status");

async function refreshInstagramStatus() {
  const data = await apiFetch("/instagram-status");
  if (data.connected) {
    instagramConnectedStatus.textContent = `連携済み（Instagramアカウント: ${data.igUserId}）`;
    instagramConnectedStatus.style.display = "block";
  } else {
    instagramConnectedStatus.style.display = "none";
  }
  return data;
}

connectInstagramBtn.addEventListener("click", () => {
  if (!inviteCode) return;
  const authorizeUrl = new URL("https://www.instagram.com/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", INSTAGRAM_APP_ID);
  authorizeUrl.searchParams.set("redirect_uri", INSTAGRAM_OAUTH_REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set(
    "scope",
    "instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages"
  );
  authorizeUrl.searchParams.set("state", inviteCode);
  window.location.href = authorizeUrl.toString();
});

// Instagramログイン後、ワーカー側のコールバックからここに戻ってくる（?instagram_connected=1/0）
(function handleInstagramOAuthReturn() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("instagram_connected")) return;
  const ok = params.get("instagram_connected") === "1";
  const message = params.get("instagram_message");
  window.history.replaceState({}, "", window.location.pathname);
  if (ok) {
    setStatus(instagramConnectStatus, "連携しました。");
  } else {
    setStatus(instagramConnectStatus, message || "Instagram連携に失敗しました", true);
  }
})();

publishBtn.addEventListener("click", async () => {
  if (!currentJobId) return;
  publishBtn.disabled = true;
  try {
    setStatus(publishStatus, "Instagramへの投稿を開始しています...");
    await apiFetch(`/jobs/${currentJobId}/publish`, { method: "POST" });
    const igResult = await pollInstagramPublish(currentJobId);
    if (igResult.status === "published") {
      setStatus(publishStatus, "Instagramに投稿しました！");
      publishBtn.style.display = "none";
    } else if (igResult.status === "error") {
      setStatus(publishStatus, `Instagramへの投稿に失敗しました: ${igResult.error || ""}`, true);
    } else {
      setStatus(publishStatus, "Instagramへの投稿処理が確認できる時間を超えました。しばらくしてページを再読み込みしてください。", true);
    }
  } catch (e) {
    setStatus(publishStatus, e.message, true);
  } finally {
    publishBtn.disabled = false;
  }
});
