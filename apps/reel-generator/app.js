// ▼▼ デプロイ後にWorkerのURLをここに設定（例: https://ccc-reel-generator.xxxx.workers.dev）▼▼
const WORKER_URL = "https://ccc-reel-generator.cationqueen.workers.dev";

const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

const loginCard = document.getElementById("login-card");
const appCard = document.getElementById("app-card");
const inviteInput = document.getElementById("invite-code");
const loginBtn = document.getElementById("login-btn");
const loginStatus = document.getElementById("login-status");
const userLabel = document.getElementById("user-label");
const usageBadge = document.getElementById("usage-badge");

const photoInput = document.getElementById("photo-input");
const scriptInput = document.getElementById("script-input");
const generateBtn = document.getElementById("generate-btn");
const generateStatus = document.getElementById("generate-status");
const resultVideo = document.getElementById("result-video");
const downloadLink = document.getElementById("download-link");

let inviteCode = localStorage.getItem("ccc_reel_invite_code") || "";

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

async function uploadPhoto(file) {
  const data = await apiFetch("/upload-photo", {
    method: "POST",
    headers: { "Content-Type": file.type || "image/jpeg" },
    body: file,
  });
  return data.photoUrl;
}

async function pollJob(jobId) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const data = await apiFetch(`/jobs/${jobId}`);
    if (data.status === "done") return data;
    if (data.status === "error") throw new Error(data.error || "動画生成に失敗しました");
    setStatus(generateStatus, "動画を生成しています...(数十秒〜数分かかります)");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("生成がタイムアウトしました。時間をおいて再度お試しください");
}

generateBtn.addEventListener("click", async () => {
  const file = photoInput.files[0];
  const script = scriptInput.value.trim();
  const postMode = document.querySelector('input[name="post-mode"]:checked').value;
  const voiceGender = document.querySelector('input[name="voice-gender"]:checked').value;

  if (!file) return setStatus(generateStatus, "顔写真をアップロードしてください", true);
  if (!script) return setStatus(generateStatus, "原稿を入力してください", true);

  generateBtn.disabled = true;
  resultVideo.style.display = "none";
  downloadLink.style.display = "none";

  try {
    setStatus(generateStatus, "写真をアップロードしています...");
    const photoUrl = await uploadPhoto(file);

    setStatus(generateStatus, "音声・動画の生成を開始しています...");
    const { jobId } = await apiFetch("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script, photoUrl, postMode, voiceGender }),
    });

    const result = await pollJob(jobId);
    setStatus(generateStatus, "完成しました！");
    resultVideo.src = result.videoUrl;
    resultVideo.style.display = "block";
    downloadLink.href = result.videoUrl;
    downloadLink.style.display = "block";
  } catch (e) {
    setStatus(generateStatus, e.message, true);
  } finally {
    generateBtn.disabled = false;
  }
});
