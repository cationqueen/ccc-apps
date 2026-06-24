'use strict';

// ── DEFAULT GROUPS ────────────────────────────────────────────────────────────
// timers: 各タイマーを順番に実行。末尾まで来たら先頭に戻り round++ する。
const DEFAULT_GROUPS = [
  {
    id: 'pomodoro',
    name: 'ポモドーロ',
    icon: '🍅',
    color: '#e74c3c',
    timers: [
      { name: '作業', sec: 1500 },
      { name: '休憩', sec: 300  },
    ],
  },
  {
    id: 'special1',
    name: 'スペシャル①',
    icon: '⭐',
    color: '#9b59b6',
    timers: [
      { name: '作業①',   sec: 1500 },
      { name: '休憩',     sec: 300  },
      { name: '作業②',   sec: 1500 },
      { name: '休憩',     sec: 300  },
      { name: '作業③',   sec: 1800 },
      { name: '休憩',     sec: 300  },
      { name: '長い休憩', sec: 1200 },
    ],
  },
  {
    id: 'special2',
    name: 'スペシャル②',
    icon: '🌟',
    color: '#e67e22',
    timers: [
      { name: '作業①',   sec: 1500 },
      { name: '休憩',     sec: 300  },
      { name: '作業②',   sec: 1500 },
      { name: '休憩',     sec: 300  },
      { name: '作業③',   sec: 1500 },
      { name: '長い休憩', sec: 1500 },
    ],
  },
  {
    id: 'special3',
    name: 'ウルトラディアン',
    icon: '🌊',
    color: '#3498db',
    timers: [
      { name: '作業', sec: 5400 },
      { name: '休憩', sec: 1200 },
    ],
  },
];

const SOUND_KEY     = 'ct_sound';
const VOLUME_KEY    = 'ct_volume';
const GROUP_KEY     = 'ct_groups';
const SHOWCLOCK_KEY = 'ct_showclock';
const START_KEY     = 'ct_start';
const END_KEY       = 'ct_end';

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {
  groups: [],
  currentId: 'pomodoro',
  timerIdx: 0,
  timeLeftMs: 0,
  totalMs: 0,
  isRunning: false,
  round: 0,
  targetMs: null,
  tick: null,
  sound: 'beep',
  volume: 0.8,
  editingId: null,

  // ── スケジュール（時計ベース）関連 ──
  showClock: true,    // タイマー一覧に時刻を表示
  startStr: '',       // 開始時間 "9:00" / "25:00"（空=なし）
  endStr: '',         // 終了時間（空=なし）
  started: false,     // 実行開始済み（一時停止中も true）
  waiting: false,     // 開始時間待ち
  finished: false,    // 終了時間に到達して終了
  pausedAtMs: null,   // 一時停止した時刻
  shiftMs: 0,         // スケジュール全体のずらし量（再開モードB / スキップ）
  runStartMs: null,   // 実行開始した時刻（終了時間のみ設定時のアンカー）
  segStartMs: null,   // 現在パートの開始時刻（絶対）
  segEndMs: null,     // 現在パートの終了時刻（絶対）
  segTruncated: false,// 終了時間で短縮された最終パートか
};

// ── AUDIO ─────────────────────────────────────────────────────────────────────
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playBeep() {
  const ctx = getAudioCtx();
  const vol = state.volume;
  [880, 1100].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq;
    const t = ctx.currentTime + i * 0.25;
    gain.gain.setValueAtTime(0.25 * vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.start(t); osc.stop(t + 0.4);
  });
}

function playBell() {
  const ctx = getAudioCtx();
  const vol = state.volume;
  [523, 659, 784, 1047].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq;
    const t = ctx.currentTime + i * 0.12;
    gain.gain.setValueAtTime(0.2 * vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
    osc.start(t); osc.stop(t + 1.2);
  });
}

function playSound() {
  if (state.sound === 'none') return;
  try { state.sound === 'bell' ? playBell() : playBeep(); } catch (e) {}
}

function vibrate() {
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
}

// ── NOTIFICATION ──────────────────────────────────────────────────────────────
async function requestNotifPerm() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    const p = await Notification.requestPermission();
    if (p === 'granted') document.getElementById('notif-banner').style.display = 'none';
  } else if (Notification.permission === 'granted') {
    document.getElementById('notif-banner').style.display = 'none';
  }
}

function notify(title, body) {
  if ('Notification' in window && Notification.permission === 'granted')
    new Notification(title, { body });
}

// ── GROUP HELPERS ─────────────────────────────────────────────────────────────
// 旧形式（sequence/workMin）から新形式（timers）へ移行
function migrateGroup(g) {
  if (g.timers) return g;
  if (g.sequence) {
    return { ...g, timers: g.sequence.map(s => ({ name: s.label || s.name || '作業', sec: (s.min || 1) * 60 })) };
  }
  return {
    ...g,
    timers: [
      { name: '作業', sec: (g.workMin || 25) * 60 },
      { name: '休憩', sec: (g.breakMin || 5) * 60 },
    ],
  };
}

function loadGroups() {
  try {
    const raw = localStorage.getItem(GROUP_KEY);
    if (raw) {
      const saved = JSON.parse(raw).map(migrateGroup);
      // 保存順序を維持しつつ、デフォルトの内容は最新定義で上書き
      const result = saved.map(g => {
        const def = DEFAULT_GROUPS.find(d => d.id === g.id);
        return def ? { ...def } : g;
      });
      // 保存データにないデフォルトグループがあれば末尾に追加
      DEFAULT_GROUPS.forEach(d => {
        if (!result.some(g => g.id === d.id)) result.push({ ...d });
      });
      return result;
    }
  } catch (e) {}
  return DEFAULT_GROUPS.map(g => ({ ...g, timers: [...g.timers] }));
}

function saveGroups() {
  localStorage.setItem(GROUP_KEY, JSON.stringify(state.groups));
}

function getGroup(id) {
  return state.groups.find(g => g.id === id) || state.groups[0];
}

function getCurrentTimer() {
  const g = getGroup(state.currentId);
  return g.timers[Math.min(state.timerIdx, g.timers.length - 1)];
}

function cycleSec(g) {
  return g.timers.reduce((s, t) => s + t.sec, 0);
}

function resetToGroup(id) {
  const g = getGroup(id);
  state.currentId    = id;
  state.timerIdx     = 0;
  state.round        = 0;
  state.isRunning    = false;
  state.started      = false;
  state.waiting      = false;
  state.finished     = false;
  state.pausedAtMs   = null;
  state.shiftMs      = 0;
  state.runStartMs   = null;
  state.segStartMs   = null;
  state.segEndMs     = null;
  state.segTruncated = false;
  if (state.tick) { clearInterval(state.tick); state.tick = null; }
  state.totalMs    = g.timers[0].sec * 1000;
  state.timeLeftMs = state.totalMs;
}

// ── TIME FORMATTING ───────────────────────────────────────────────────────────
function fmtMs(ms) {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// サマリー表示用（例: 25分、1時間30分、45秒）
function fmtSec(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h) parts.push(`${h}時間`);
  if (m) parts.push(`${m}分`);
  if (s || !parts.length) parts.push(`${s}秒`);
  return parts.join('');
}

// 絶対時刻 → "H:MM"（実際の時計表記。25:00 入力でも翌日1:00として表示）
function fmtClock(ms) {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── SCHEDULE HELPERS ──────────────────────────────────────────────────────────
// "9:00" / "25:30" → 本日0時を基準にした絶対ms（時は24以上で翌日扱い）。無効なら null
function clockToMs(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const h  = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (mi > 59) return null;
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  return base.getTime() + (h * 3600 + mi * 60) * 1000;
}

function effectiveEndMs() {
  const e = clockToMs(state.endStr);
  return e === null ? null : e + state.shiftMs;
}

// 開始/終了どちらかが設定されていればスケジュールモード
function isScheduled() {
  return clockToMs(state.startStr) !== null || clockToMs(state.endStr) !== null;
}

// 現在時刻 now がスケジュール上のどのパートに当たるか
function locateSegment(now) {
  const g        = getGroup(state.currentId);
  const startClk = clockToMs(state.startStr);
  const endMs    = effectiveEndMs();
  const anchor   = (startClk !== null) ? startClk + state.shiftMs
                                       : (state.runStartMs || now) + state.shiftMs;
  let cursor = anchor, i = 0, round = 0;
  for (let n = 0; n < 5000; n++) {
    let dur    = g.timers[i].sec * 1000;
    let segEnd = cursor + dur;
    let truncated = false;
    if (endMs !== null && segEnd >= endMs) { segEnd = endMs; truncated = true; }
    if (now < segEnd) {
      const segStart = cursor;
      return {
        i, round, segStartMs: segStart, segEndMs: segEnd, truncated,
        remainingMs: Math.max(0, segEnd - Math.max(now, segStart)),
        finished: false,
      };
    }
    if (truncated) return { finished: true };
    cursor = segEnd; i++;
    if (i >= g.timers.length) { i = 0; round++; }
  }
  return { finished: true };
}

// タイマー一覧の各行が始まる時計時刻を求めるための、現在ラウンド先頭の絶対時刻
function getRoundAnchorMs() {
  const g        = getGroup(state.currentId);
  const startClk = clockToMs(state.startStr);
  if (startClk !== null) {
    return startClk + state.shiftMs + state.round * cycleSec(g) * 1000;
  }
  const segStart = state.segStartMs != null ? state.segStartMs : Date.now();
  let before = 0;
  for (let k = 0; k < state.timerIdx; k++) before += g.timers[k].sec * 1000;
  return segStart - before;
}

function rowClockMs(i) {
  const g = getGroup(state.currentId);
  let before = 0;
  for (let k = 0; k < i; k++) before += g.timers[k].sec * 1000;
  return getRoundAnchorMs() + before;
}

// ── TIMER LOGIC ───────────────────────────────────────────────────────────────
function onStartButton() {
  if (state.waiting)  { resetTimer(); return; }          // 待機中止
  if (state.isRunning){ pauseTimer(); return; }
  if (state.finished) { resetTimer(); return; }          // もう一度
  if (state.started && state.pausedAtMs != null) {        // 再開
    if (isScheduled()) { openResumeDialog(); return; }
    resumeShift();
    return;
  }
  beginRun();
}

function beginRun() {
  state.started    = true;
  state.finished   = false;
  state.waiting    = false;
  state.shiftMs    = 0;
  state.runStartMs = Date.now();

  const startClk = clockToMs(state.startStr);
  if (startClk !== null && Date.now() < startClk) {
    // A①：開始時間より前 → 待機
    state.waiting   = true;
    state.isRunning = false;
    state.targetMs  = startClk;
    state.tick      = setInterval(onWaitTick, 250);
    render();
    return;
  }
  // A②③ / 終了時間のみ / フリー
  locateAndBegin(Date.now());
}

function locateAndBegin(now) {
  const g = getGroup(state.currentId);
  if (isScheduled()) {
    const loc = locateSegment(now);
    if (loc.finished) { finishSchedule(); return; }
    state.timerIdx     = loc.i;
    state.round        = loc.round;
    state.totalMs      = g.timers[loc.i].sec * 1000;
    state.timeLeftMs   = loc.remainingMs;
    state.segStartMs   = loc.segStartMs;
    state.segEndMs     = loc.segEndMs;
    state.segTruncated = loc.truncated;
  } else {
    state.totalMs    = g.timers[state.timerIdx].sec * 1000;
    state.timeLeftMs = state.totalMs;
    state.segStartMs = now;
    state.segEndMs   = now + state.totalMs;
  }
  runCurrentSegment();
}

function runCurrentSegment() {
  state.isRunning  = true;
  state.waiting    = false;
  state.finished   = false;
  state.pausedAtMs = null;
  state.started    = true;
  state.targetMs   = Date.now() + state.timeLeftMs;
  state.tick       = setInterval(onTick, 250);
  render();
}

function pauseTimer() {
  if (!state.isRunning) return;
  state.isRunning  = false;
  state.timeLeftMs = Math.max(0, state.targetMs - Date.now());
  state.pausedAtMs = Date.now();
  clearInterval(state.tick); state.tick = null;
  render();
}

// 再開モードB（配分に従う）／フリーモードの通常再開：止めた分だけ全体を後ろにずらす
function resumeShift() {
  const pauseDur = state.pausedAtMs != null ? (Date.now() - state.pausedAtMs) : 0;
  if (state.segStartMs != null) state.segStartMs += pauseDur;
  if (state.segEndMs   != null) state.segEndMs   += pauseDur;
  if (isScheduled()) state.shiftMs += pauseDur;
  runCurrentSegment();
}

// 再開モードA（時計に従う）：休んだ分は飛ばして現在時刻のスケジュール位置へ復帰
function resumeFollowClock() {
  state.pausedAtMs = null;
  locateAndBegin(Date.now());
}

function resetTimer() {
  if (state.tick) { clearInterval(state.tick); state.tick = null; }
  resetToGroup(state.currentId);
  render();
}

function skipTimer() {
  if (state.finished) return;
  if (state.waiting) {
    // 待機をスキップ → 今すぐ開始
    clearInterval(state.tick); state.tick = null;
    state.waiting = false;
    locateAndBegin(Date.now());
    return;
  }
  const wasRunning = state.isRunning;
  if (state.isRunning) {
    state.isRunning  = false;
    state.timeLeftMs = Math.max(0, state.targetMs - Date.now());
    clearInterval(state.tick); state.tick = null;
  }
  advanceTimer(true, wasRunning);
}

function onWaitTick() {
  if (Date.now() >= state.targetMs) {
    clearInterval(state.tick); state.tick = null;
    state.waiting = false;
    locateAndBegin(Date.now());
  } else {
    document.getElementById('timer-time').textContent = fmtMs(Math.max(0, state.targetMs - Date.now()));
  }
}

function onTick() {
  state.timeLeftMs = Math.max(0, state.targetMs - Date.now());
  if (state.timeLeftMs <= 0) advanceTimer(false);
  else renderTimeAndRing();
}

function advanceTimer(manual, autoStart = false) {
  state.isRunning = false;
  if (state.tick) { clearInterval(state.tick); state.tick = null; }

  const g    = getGroup(state.currentId);
  const prev = g.timers[Math.min(state.timerIdx, g.timers.length - 1)];

  if (!manual) { playSound(); vibrate(); }

  let i = state.timerIdx + 1, round = state.round;
  if (i >= g.timers.length) { i = 0; round++; }

  // ── スケジュールモード（実行中） ──
  if (isScheduled() && state.started) {
    const endMs = effectiveEndMs();

    // 手動スキップ：次パートが「今」始まるようスケジュールをずらす
    if (manual) {
      state.shiftMs += Date.now() - (state.segEndMs != null ? state.segEndMs : Date.now());
    }
    const nextStart = manual ? Date.now() : (state.segEndMs != null ? state.segEndMs : Date.now());

    if (endMs !== null && nextStart >= endMs) {
      state.timerIdx = i; state.round = round;
      finishSchedule();
      return;
    }

    let dur     = g.timers[i].sec * 1000;
    let nextEnd = nextStart + dur;
    let truncated = false;
    if (endMs !== null && nextEnd >= endMs) { nextEnd = endMs; truncated = true; } // B②：最終パートを短縮

    state.timerIdx     = i;
    state.round        = round;
    state.totalMs      = dur;
    state.segStartMs   = nextStart;
    state.segEndMs     = nextEnd;
    state.segTruncated = truncated;
    state.timeLeftMs   = Math.max(0, nextEnd - Date.now());

    if (!manual) notify(`${g.name} — ${prev.name}終了！`, `次は ${g.timers[i].name}`);
    render();
    if (!manual || autoStart) setTimeout(runCurrentSegment, 300);
    return;
  }

  // ── フリーモード ──
  state.timerIdx   = i;
  state.round      = round;
  state.totalMs    = g.timers[i].sec * 1000;
  state.timeLeftMs = state.totalMs;
  const willRun = (!manual || autoStart);
  state.segStartMs = willRun ? Date.now() : null;
  state.segEndMs   = willRun ? Date.now() + state.totalMs : null;

  if (!manual) notify(`${g.name} — ${prev.name}終了！`, `次は ${g.timers[i].name} ${fmtSec(g.timers[i].sec)}`);
  render();
  if (willRun) setTimeout(runCurrentSegment, 300);
}

function finishSchedule() {
  state.isRunning = false;
  state.finished  = true;
  state.waiting   = false;
  state.started   = false;
  state.timeLeftMs = 0;
  if (state.tick) { clearInterval(state.tick); state.tick = null; }
  playSound(); vibrate();
  notify('スケジュール終了', '設定した終了時間になりました');
  render();
}

// ── RESUME DIALOG ─────────────────────────────────────────────────────────────
function openResumeDialog()  { document.getElementById('resume-overlay').classList.add('open'); }
function closeResumeDialog() { document.getElementById('resume-overlay').classList.remove('open'); }

// ── RENDER ────────────────────────────────────────────────────────────────────
const CIRCUMFERENCE = 2 * Math.PI * 116;

function renderTimeAndRing() {
  const t = getCurrentTimer();
  const timeEl = document.getElementById('timer-time');
  timeEl.textContent = fmtMs(state.timeLeftMs);
  timeEl.style.fontSize = t.sec >= 3600 ? '44px' : '56px';
  const progress = state.totalMs > 0 ? state.timeLeftMs / state.totalMs : 1;
  document.getElementById('ring-progress').style.strokeDashoffset =
    CIRCUMFERENCE * (1 - progress);
}

function render() {
  const g     = getGroup(state.currentId);
  const t     = getCurrentTimer();
  const color = g.color;

  document.documentElement.style.setProperty('--preset-color', color);

  document.querySelectorAll('.preset-tab').forEach(el => {
    const active = el.dataset.id === state.currentId;
    el.classList.toggle('active', active);
    if (active) el.style.setProperty('--preset-color', color);
  });

  const badge  = document.getElementById('session-badge');
  const stepEl = document.getElementById('step-indicator');
  const roundEl= document.getElementById('round-count');
  const ring   = document.getElementById('ring-progress');
  const timeEl = document.getElementById('timer-time');

  badge.className = 'session-badge';

  if (state.waiting) {
    badge.textContent    = '開始待ち';
    stepEl.style.display = 'none';
    timeEl.textContent   = fmtMs(Math.max(0, state.targetMs - Date.now()));
    timeEl.style.fontSize= '44px';
    roundEl.textContent  = `開始まで（${fmtClock(state.targetMs)}）`;
    ring.style.strokeDashoffset = 0;
  } else if (state.finished) {
    badge.textContent    = '終了';
    stepEl.style.display = 'none';
    timeEl.textContent   = '00:00';
    timeEl.style.fontSize= '56px';
    roundEl.textContent  = '🏁 スケジュール終了';
    ring.style.strokeDashoffset = 0;
  } else {
    badge.textContent = t.name;
    if (g.timers.length > 1) {
      stepEl.textContent   = `STEP ${state.timerIdx + 1} / ${g.timers.length}`;
      stepEl.style.display = 'block';
    } else {
      stepEl.style.display = 'none';
    }
    roundEl.textContent = state.round > 0 ? `🔄 ${state.round}周目` : '開始前';
    renderTimeAndRing();
  }

  ring.style.stroke = color;
  ring.style.filter = `drop-shadow(0 0 6px ${color})`;

  const btn = document.getElementById('start-btn');
  if (state.waiting) {
    btn.textContent = '✕ 待機中止'; btn.style.background = 'rgba(255,255,255,0.1)';
  } else if (state.finished) {
    btn.textContent = '↺ もう一度'; btn.style.background = color;
  } else if (state.isRunning) {
    btn.textContent = '⏸ 一時停止'; btn.style.background = 'rgba(255,255,255,0.1)';
  } else {
    btn.textContent = '▶ スタート'; btn.style.background = color;
  }

  renderTimerListPanel();
}

function renderTimerListPanel() {
  const body = document.getElementById('timer-list-body');
  if (!body) return;
  const g = getGroup(state.currentId);
  body.innerHTML = '';
  g.timers.forEach((t, i) => {
    const isActive = !state.waiting && !state.finished && i === state.timerIdx;
    const row = document.createElement('div');
    row.className = 'tl-row' + (isActive ? ' active' : '');
    const clockHtml = state.showClock
      ? `<span class="tl-clock">${fmtClock(rowClockMs(i))}</span>` : '';
    row.innerHTML = `
      ${clockHtml}
      <span class="tl-step">${i + 1}</span>
      <span class="tl-name">${escHtml(t.name)}</span>
      <span class="tl-dur">${fmtSec(t.sec)}</span>
    `;
    body.appendChild(row);
  });
  const activeRow = body.querySelector('.tl-row.active');
  if (activeRow) activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderGroupTabs() {
  const container = document.getElementById('preset-tabs');
  container.innerHTML = '';
  state.groups.forEach(g => {
    const btn = document.createElement('button');
    btn.className = 'preset-tab' + (g.id === state.currentId ? ' active' : '');
    btn.dataset.id = g.id;
    btn.style.setProperty('--preset-color', g.color);
    btn.textContent = `${g.icon} ${g.name}`;
    btn.addEventListener('click', () => { resetToGroup(g.id); render(); });
    container.appendChild(btn);
  });
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────
function renderSettings() {
  const list = document.getElementById('preset-list');
  list.innerHTML = '';
  const isDefault = id => DEFAULT_GROUPS.some(d => d.id === id);

  state.groups.forEach((g, idx) => {
    const summary = g.timers.map(t => `${t.name}(${fmtSec(t.sec)})`).join(' → ');
    const first = idx === 0;
    const last  = idx === state.groups.length - 1;

    const item = document.createElement('div');
    item.className = 'preset-item';
    item.innerHTML = `
      <div class="pi-dot" style="background:${g.color}"></div>
      <div class="pi-info">
        <div class="pi-name">${g.icon} ${g.name}</div>
        <div class="pi-times">${summary}</div>
      </div>
      <div class="pi-actions">
        <div class="pi-move">
          <button class="pi-btn move-up" data-id="${g.id}" ${first ? 'disabled' : ''}>↑</button>
          <button class="pi-btn move-dn" data-id="${g.id}" ${last  ? 'disabled' : ''}>↓</button>
        </div>
        ${!isDefault(g.id) ? `<button class="pi-btn edit" data-id="${g.id}">編集</button>` : ''}
        ${!isDefault(g.id) ? `<button class="pi-btn delete" data-id="${g.id}">削除</button>` : ''}
        ${isDefault(g.id)  ? `<span class="pi-lock">🔒</span>` : ''}
      </div>`;
    list.appendChild(item);
  });

  list.querySelectorAll('.pi-btn.move-up').forEach(btn =>
    btn.addEventListener('click', () => moveGroup(btn.dataset.id, -1)));
  list.querySelectorAll('.pi-btn.move-dn').forEach(btn =>
    btn.addEventListener('click', () => moveGroup(btn.dataset.id, +1)));
  list.querySelectorAll('.pi-btn.edit').forEach(btn =>
    btn.addEventListener('click', () => openGroupForm(btn.dataset.id)));
  list.querySelectorAll('.pi-btn.delete').forEach(btn =>
    btn.addEventListener('click', () => deleteGroup(btn.dataset.id)));

  document.querySelectorAll('.sound-opt').forEach(el =>
    el.classList.toggle('selected', el.dataset.sound === state.sound));

  const slider = document.getElementById('volume-slider');
  const label  = document.getElementById('volume-label');
  if (slider) {
    slider.value   = Math.round(state.volume * 100);
    label.textContent = Math.round(state.volume * 100) + '%';
  }

  // スケジュール設定欄
  const sc = document.getElementById('show-clock-chk');
  if (sc) sc.checked = state.showClock;
  const st = document.getElementById('start-time');
  if (st) st.value = state.startStr;
  const et = document.getElementById('end-time');
  if (et) et.value = state.endStr;
}

// ── GROUP FORM ────────────────────────────────────────────────────────────────
function secToHMS(sec) {
  return { h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60), s: sec % 60 };
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// フォーム内の現在値をDOMから読み取る
function readFormTimers() {
  return Array.from(document.querySelectorAll('#f-timer-list .timer-row')).map(row => ({
    name: row.querySelector('.tr-name').value,
    h:    parseInt(row.querySelector('.tr-h').value)  || 0,
    m:    parseInt(row.querySelector('.tr-m').value)  || 0,
    s:    parseInt(row.querySelector('.tr-s').value)  || 0,
  }));
}

function renderFormTimers(timers) {
  const container = document.getElementById('f-timer-list');
  container.innerHTML = '';
  timers.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'timer-row';
    row.innerHTML = `
      <input type="text" class="tr-name" placeholder="タイマー名" value="${escHtml(t.name)}" maxlength="20">
      <div class="tr-time">
        <input type="number" class="tr-h" min="0" max="99" value="${t.h}">
        <span class="tr-sep">:</span>
        <input type="number" class="tr-m" min="0" max="59" value="${t.m}">
        <span class="tr-sep">:</span>
        <input type="number" class="tr-s" min="0" max="59" value="${t.s}">
      </div>
      <button class="tr-del" title="削除">✕</button>
    `;
    row.querySelector('.tr-del').addEventListener('click', () => {
      const current = readFormTimers();
      current.splice(i, 1);
      if (!current.length) current.push({ name: '', h: 0, m: 0, s: 30 });
      renderFormTimers(current);
    });
    container.appendChild(row);
  });
}

function openGroupForm(id) {
  document.getElementById('preset-form').classList.add('open');
  state.editingId = id || null;
  if (id) {
    const g = getGroup(id);
    document.getElementById('f-name').value  = g.name;
    document.getElementById('f-icon').value  = g.icon;
    document.getElementById('f-color').value = g.color;
    renderFormTimers(g.timers.map(t => ({ name: t.name, ...secToHMS(t.sec) })));
  } else {
    document.getElementById('f-name').value  = '';
    document.getElementById('f-icon').value  = '⏱';
    document.getElementById('f-color').value = '#e67e22';
    renderFormTimers([
      { name: '作業', h: 0, m: 25, s: 0 },
      { name: '休憩', h: 0, m: 5,  s: 0 },
    ]);
  }
}

function closeGroupForm() {
  document.getElementById('preset-form').classList.remove('open');
  state.editingId = null;
}

function saveGroupForm() {
  const name  = document.getElementById('f-name').value.trim();
  const icon  = document.getElementById('f-icon').value.trim() || '⏱';
  const color = document.getElementById('f-color').value;
  if (!name) return;

  const timers = readFormTimers()
    .map(r => ({ name: r.name.trim(), sec: r.h * 3600 + r.m * 60 + r.s }))
    .filter(t => t.name && t.sec > 0);

  if (!timers.length) return;

  const group = { name, icon, color, timers };

  if (state.editingId) {
    const idx = state.groups.findIndex(g => g.id === state.editingId);
    if (idx >= 0) state.groups[idx] = { ...state.groups[idx], ...group };
  } else {
    state.groups.push({ id: 'custom_' + Date.now(), ...group });
  }

  saveGroups();
  closeGroupForm();
  renderGroupTabs();
  renderSettings();
  render();
}

function moveGroup(id, dir) {
  const idx = state.groups.findIndex(g => g.id === id);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= state.groups.length) return;
  const tmp = state.groups[idx];
  state.groups[idx] = state.groups[newIdx];
  state.groups[newIdx] = tmp;
  saveGroups();
  renderGroupTabs();
  renderSettings();
  render();
}

function deleteGroup(id) {
  state.groups = state.groups.filter(g => g.id !== id);
  if (state.currentId === id) resetToGroup(state.groups[0].id);
  saveGroups();
  renderGroupTabs();
  renderSettings();
  render();
}

// ── INIT ──────────────────────────────────────────────────────────────────────
function init() {
  state.groups    = loadGroups();
  state.sound     = localStorage.getItem(SOUND_KEY)  || 'beep';
  state.volume    = parseFloat(localStorage.getItem(VOLUME_KEY) ?? '0.8');
  state.showClock = localStorage.getItem(SHOWCLOCK_KEY) !== 'false';
  state.startStr  = localStorage.getItem(START_KEY) || '';
  state.endStr    = localStorage.getItem(END_KEY)   || '';

  resetToGroup(state.groups[0].id);
  renderGroupTabs();
  render();

  document.getElementById('ring-progress').style.strokeDasharray  = CIRCUMFERENCE;
  document.getElementById('ring-progress').style.strokeDashoffset = 0;

  if ('Notification' in window && Notification.permission !== 'granted')
    document.getElementById('notif-banner').style.display = 'block';

  document.getElementById('start-btn').addEventListener('click', onStartButton);
  document.getElementById('reset-btn').addEventListener('click', resetTimer);
  document.getElementById('skip-btn').addEventListener('click', skipTimer);
  document.getElementById('notif-banner').addEventListener('click', requestNotifPerm);

  document.getElementById('settings-btn').addEventListener('click', () => {
    renderSettings();
    document.getElementById('settings-overlay').classList.add('open');
  });
  document.getElementById('settings-close').addEventListener('click', () =>
    document.getElementById('settings-overlay').classList.remove('open'));
  document.getElementById('settings-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget)
      document.getElementById('settings-overlay').classList.remove('open');
  });

  document.getElementById('btn-add-preset').addEventListener('click', () => openGroupForm(null));
  document.getElementById('form-save').addEventListener('click', saveGroupForm);
  document.getElementById('form-cancel').addEventListener('click', closeGroupForm);

  document.getElementById('timer-list-toggle').addEventListener('click', () => {
    const body = document.getElementById('timer-list-body');
    const btn  = document.getElementById('timer-list-toggle');
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    btn.classList.toggle('collapsed', open);
  });

  document.getElementById('f-add-timer').addEventListener('click', () => {
    const current = readFormTimers();
    current.push({ name: '', h: 0, m: 0, s: 30 });
    renderFormTimers(current);
  });

  document.getElementById('volume-slider').addEventListener('input', e => {
    state.volume = parseInt(e.target.value) / 100;
    localStorage.setItem(VOLUME_KEY, state.volume);
    document.getElementById('volume-label').textContent = e.target.value + '%';
  });

  document.querySelectorAll('.sound-opt').forEach(el =>
    el.addEventListener('click', () => {
      state.sound = el.dataset.sound;
      localStorage.setItem(SOUND_KEY, state.sound);
      if (state.sound !== 'none') playSound();
      document.querySelectorAll('.sound-opt').forEach(o =>
        o.classList.toggle('selected', o.dataset.sound === state.sound));
    }));

  // ── スケジュール（時計ベース）設定 ──
  document.getElementById('show-clock-chk').addEventListener('change', e => {
    state.showClock = e.target.checked;
    localStorage.setItem(SHOWCLOCK_KEY, state.showClock);
    renderTimerListPanel();
  });
  document.getElementById('start-time').addEventListener('input', e => {
    state.startStr = e.target.value.trim();
    localStorage.setItem(START_KEY, state.startStr);
    render();
  });
  document.getElementById('end-time').addEventListener('input', e => {
    state.endStr = e.target.value.trim();
    localStorage.setItem(END_KEY, state.endStr);
    render();
  });

  // ── 再開ダイアログ ──
  document.getElementById('resume-clock').addEventListener('click', () => {
    closeResumeDialog(); resumeFollowClock();
  });
  document.getElementById('resume-shift').addEventListener('click', () => {
    closeResumeDialog(); resumeShift();
  });
  document.getElementById('resume-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeResumeDialog();
  });

  requestNotifPerm();
}

document.addEventListener('DOMContentLoaded', init);
