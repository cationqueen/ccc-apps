// ▼▼ デプロイ後にWorkerのURLをここに設定（例: https://ccc-reel-generator.xxxx.workers.dev）▼▼
const WORKER_URL = "https://ccc-reel-generator.cationqueen.workers.dev";

const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS_PHOTO = 8 * 60 * 1000; // 原稿が長いとHeyGen側のレンダリングが5分を超えることがあるため余裕を持たせる
const POLL_TIMEOUT_MS_VIDEO = 15 * 60 * 1000; // 動画素材はアバター学習が長くなるため余裕を持たせる

const loginCard = document.getElementById("login-card");
const appCard = document.getElementById("app-card");
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
const scriptInput = document.getElementById("script-input");
const generateBtn = document.getElementById("generate-btn");
const checkStatusBtn = document.getElementById("check-status-btn");
const generateStatus = document.getElementById("generate-status");
const progressDetail = document.getElementById("progress-detail");
const resultVideo = document.getElementById("result-video");
const downloadLink = document.getElementById("download-link");

let inviteCode = localStorage.getItem("ccc_reel_invite_code") || "";

// 生成中にタイムアウト表示になっても、サーバー側（HeyGen）では処理が続いていて
// 実際は完成していることが多い。そこで「再生成」で余計な課金をしないよう、
// 直近のジョブIDをlocalStorageに保持し、いつでも状態だけ再確認できるようにする。
const PENDING_JOB_KEY = "ccc_reel_pending_job";

function savePendingJob(jobId, sourceType) {
  localStorage.setItem(PENDING_JOB_KEY, JSON.stringify({ jobId, sourceType, ts: Date.now() }));
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
  userLabel.textContent = inviteCode;
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

function showResult(result) {
  setStatus(generateStatus, "完成しました！");
  progressDetail.style.display = "none";
  resultVideo.src = result.videoUrl;
  resultVideo.style.display = "block";
  downloadLink.href = result.videoUrl;
  downloadLink.style.display = "block";
  clearPendingJob();
  refreshPendingJobUi();
}

checkStatusBtn.addEventListener("click", async () => {
  const pending = getPendingJob();
  if (!pending) return;
  checkStatusBtn.disabled = true;
  try {
    setStatus(generateStatus, "前回の生成状況を確認しています...");
    const timeoutMs = pending.sourceType === "video" ? POLL_TIMEOUT_MS_VIDEO : POLL_TIMEOUT_MS_PHOTO;
    const result = await pollJob(pending.jobId, timeoutMs);
    showResult(result);
  } catch (e) {
    setStatus(generateStatus, e.message, true);
  } finally {
    checkStatusBtn.disabled = false;
  }
});

generateBtn.addEventListener("click", async () => {
  const sourceType = currentSourceType();
  const isStock = sourceType === "stock";
  const file = sourceType === "video" ? videoInput.files[0] : photoInput.files[0];
  const script = scriptInput.value.trim();
  const postMode = document.querySelector('input[name="post-mode"]:checked').value;
  const voiceGender = document.querySelector('input[name="voice-gender"]:checked').value;
  const stockAvatarGender = document.querySelector('input[name="stock-avatar-gender"]:checked')?.value;

  if (!isStock && !file) {
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

  try {
    let mediaUrl;
    if (isStock) {
      setStatus(generateStatus, "音声・動画の生成を開始しています...");
    } else {
      setStatus(generateStatus, sourceType === "video" ? "動画をアップロードしています...(サイズによっては時間がかかります)" : "写真をアップロードしています...");
      mediaUrl = await uploadMedia(file);
      setStatus(generateStatus, "音声・動画の生成を開始しています...");
    }

    const { jobId } = await apiFetch("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script, mediaUrl, sourceType, postMode, voiceGender, stockAvatarGender }),
    });
    savePendingJob(jobId, sourceType);
    refreshPendingJobUi();

    const timeoutMs = sourceType === "video" ? POLL_TIMEOUT_MS_VIDEO : POLL_TIMEOUT_MS_PHOTO;
    const result = await pollJob(jobId, timeoutMs);
    showResult(result);
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
