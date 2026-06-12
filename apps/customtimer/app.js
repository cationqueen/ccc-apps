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

const SOUND_KEY = 'ct_sound';
const GROUP_KEY = 'ct_groups';

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
  editingId: null,
};

// ── AUDIO ─────────────────────────────────────────────────────────────────────
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playBeep() {
  const ctx = getAudioCtx();
  [880, 1100].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq;
    const t = ctx.currentTime + i * 0.25;
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.start(t); osc.stop(t + 0.4);
  });
}

function playBell() {
  const ctx = getAudioCtx();
  [523, 659, 784, 1047].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq;
    const t = ctx.currentTime + i * 0.12;
    gain.gain.setValueAtTime(0.2, t);
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

function resetToGroup(id) {
  const g = getGroup(id);
  state.currentId = id;
  state.timerIdx  = 0;
  state.round     = 0;
  state.isRunning = false;
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

// ── TIMER LOGIC ───────────────────────────────────────────────────────────────
function startTimer() {
  if (state.isRunning) return;
  state.isRunning = true;
  state.targetMs  = Date.now() + state.timeLeftMs;
  state.tick      = setInterval(onTick, 250);
  render();
}

function pauseTimer() {
  if (!state.isRunning) return;
  state.isRunning  = false;
  state.timeLeftMs = Math.max(0, state.targetMs - Date.now());
  clearInterval(state.tick); state.tick = null;
  render();
}

function resetTimer() {
  state.isRunning = false;
  if (state.tick) { clearInterval(state.tick); state.tick = null; }
  resetToGroup(state.currentId);
  render();
}

function skipTimer() {
  pauseTimer();
  advanceTimer(true);
}

function onTick() {
  state.timeLeftMs = Math.max(0, state.targetMs - Date.now());
  if (state.timeLeftMs <= 0) advanceTimer(false);
  else renderTimeAndRing();
}

function advanceTimer(manual) {
  state.isRunning = false;
  if (state.tick) { clearInterval(state.tick); state.tick = null; }

  const g         = getGroup(state.currentId);
  const prevTimer = g.timers[state.timerIdx];

  if (!manual) { playSound(); vibrate(); }

  state.timerIdx++;
  if (state.timerIdx >= g.timers.length) {
    state.timerIdx = 0;
    state.round++;
  }

  const nextTimer      = g.timers[state.timerIdx];
  state.totalMs        = nextTimer.sec * 1000;
  state.timeLeftMs     = state.totalMs;

  if (!manual) {
    notify(`${g.name} — ${prevTimer.name}終了！`, `次は ${nextTimer.name} ${fmtSec(nextTimer.sec)}`);
  }

  render();
  if (!manual) setTimeout(() => startTimer(), 800);
}

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

  // バッジ（タイマー名 + グループカラー）
  const badge = document.getElementById('session-badge');
  badge.textContent = t.name;
  badge.className   = 'session-badge';

  // ステップ表示（タイマーが複数あるときのみ）
  const stepEl = document.getElementById('step-indicator');
  if (g.timers.length > 1) {
    stepEl.textContent  = `STEP ${state.timerIdx + 1} / ${g.timers.length}`;
    stepEl.style.display = 'block';
  } else {
    stepEl.style.display = 'none';
  }

  // 周回カウント
  document.getElementById('round-count').textContent =
    state.round > 0 ? `🔄 ${state.round}周目` : '開始前';

  renderTimeAndRing();
  const ring = document.getElementById('ring-progress');
  ring.style.stroke = color;
  ring.style.filter = `drop-shadow(0 0 6px ${color})`;

  const btn = document.getElementById('start-btn');
  btn.textContent      = state.isRunning ? '⏸ 一時停止' : '▶ スタート';
  btn.style.background = state.isRunning ? 'rgba(255,255,255,0.1)' : color;

  renderTimerListPanel();
}

function renderTimerListPanel() {
  const body = document.getElementById('timer-list-body');
  if (!body) return;
  const g = getGroup(state.currentId);
  body.innerHTML = '';
  g.timers.forEach((t, i) => {
    const isActive = i === state.timerIdx;
    const row = document.createElement('div');
    row.className = 'tl-row' + (isActive ? ' active' : '');
    row.innerHTML = `
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
  state.groups = loadGroups();
  state.sound  = localStorage.getItem(SOUND_KEY) || 'beep';

  resetToGroup(state.groups[0].id);
  renderGroupTabs();
  render();

  document.getElementById('ring-progress').style.strokeDasharray  = CIRCUMFERENCE;
  document.getElementById('ring-progress').style.strokeDashoffset = 0;

  if ('Notification' in window && Notification.permission !== 'granted')
    document.getElementById('notif-banner').style.display = 'block';

  document.getElementById('start-btn').addEventListener('click', () =>
    state.isRunning ? pauseTimer() : startTimer());
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

  document.querySelectorAll('.sound-opt').forEach(el =>
    el.addEventListener('click', () => {
      state.sound = el.dataset.sound;
      localStorage.setItem(SOUND_KEY, state.sound);
      if (state.sound !== 'none') playSound();
      document.querySelectorAll('.sound-opt').forEach(o =>
        o.classList.toggle('selected', o.dataset.sound === state.sound));
    }));

  requestNotifPerm();
}

document.addEventListener('DOMContentLoaded', init);
