const CONFIG = {
  apiBase: (window.POKER_API_BASE || document.querySelector('meta[name="poker-api-base"]')?.content || '').replace(/\/$/, ''),
  wsBase: (window.POKER_WS_BASE || document.querySelector('meta[name="poker-ws-base"]')?.content || '').replace(/\/$/, ''),
  transport: (window.POKER_TRANSPORT || document.querySelector('meta[name="poker-transport"]')?.content || 'auto').toLowerCase(),
};
const FAST_BURST_POLL_MS = 1100;
const ACTIVE_ROOM_POLL_MS = 2100;
const WAITING_SEATED_ROOM_POLL_MS = 10000;
const IDLE_ROOM_POLL_MS = 60000;
const LOBBY_POLL_MS = 180000;
const HIDDEN_POLLING_MESSAGE = 'Updates paused while this tab is hidden. A 30-minute ultra-low-use heartbeat keeps your seat; closing the tab releases it after about 90 minutes.';
const HEARTBEAT_VISIBLE_MS = 30 * 60 * 1000;
const HEARTBEAT_HIDDEN_MS = 30 * 60 * 1000;
function apiPath(path) {
  return CONFIG.apiBase ? `${CONFIG.apiBase}${path}` : path;
}
function wsBase() {
  let base = CONFIG.wsBase;
  if (!base && /^https?:\/\//i.test(CONFIG.apiBase)) base = CONFIG.apiBase.replace(/^http/i, 'ws');
  if (base) {
    if (/^https?:\/\//i.test(base)) return base.replace(/^http/i, 'ws');
    if (/^wss?:\/\//i.test(base)) return base;
    if (base.startsWith('/')) {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${location.host}${base}`;
    }
    return base;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}
function wsPath(path) {
  return `${wsBase()}${path}`;
}
function makeClientId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `client-${Math.random().toString(16).slice(2)}-${Date.now()}`;
}
function initialRoomId() {
  const fromUrl = new URLSearchParams(location.search).get('room');
  const saved = localStorage.getItem('poker.roomId');
  const id = String(fromUrl || saved || '').trim().toUpperCase();
  return id && id !== 'MAIN01' ? id : '';
}
function roomInviteUrl() {
  if (!S.roomId || S.roomId === 'MAIN01') throw new Error('Create or join a table first.');
  const url = new URL(location.href);
  url.searchParams.set('room', S.roomId);
  url.hash = '';
  return url.toString();
}
function syncRoomUrl() {
  const url = new URL(location.href);
  if (!S?.roomId || S.roomId === 'MAIN01') {
    if (url.searchParams.has('room')) { url.searchParams.delete('room'); history.replaceState(null, '', url); }
    return;
  }
  if (url.searchParams.get('room') === S.roomId) return;
  url.searchParams.set('room', S.roomId);
  history.replaceState(null, '', url);
}
const S = {
  roomId: initialRoomId(),
  token: localStorage.getItem('poker.token') || '',
  clientId: localStorage.getItem('poker.clientId') || makeClientId(),
  tokensByRoom: JSON.parse(localStorage.getItem('poker.tokensByRoom') || '{}'),
  selectedSeat: 0, prevCommunity: [], prevHoles: {}, lastPot: null,
  lastTurnKey: '', lastSoundRoom: '', hasRenderedState: false, lastChipSoundAt: 0, lastState: null,
  creatorTokens: JSON.parse(localStorage.getItem('poker.creatorTokens') || '{}'),
  ws: null, wsTimer: null, lobbyWs: null, lobbyTimer: null, pollTimer: null, lobbyPollTimer: null, heartbeatTimer: null, turnCountdownTimer: null, turnTimerKey: '', turnTimerEnd: 0, autoNextTimer: null, autoNextInterval: null, autoNextKey: '', autoNextDeadline: 0, autoNextSuppressedKey: '', dismissedSummaryKey: '',
  wantsRoomPolling: false, wantsLobbyPolling: false, fastPollUntil: 0, pendingMutation: false,
  lastLegalActions: [],
  lastRevealHandKey: '', lastRevealCommunityCount: 0, lastRevealHoleCount: 0, playedHoleRevealFor: '',
};
const $ = id => document.getElementById(id);
if (S.tokensByRoom[S.roomId]) S.token = S.tokensByRoom[S.roomId];
else if (S.token && S.roomId) S.tokensByRoom[S.roomId] = S.token;
function tokenForRoom(roomId) { return S.tokensByRoom[String(roomId || '').toUpperCase()] || ''; }
function isRealRoomId(roomId) { const id = String(roomId || '').trim().toUpperCase(); return Boolean(id && id !== 'MAIN01'); }
function hasActiveRoom(p = S.lastState) {
  const roomId = String(p?.room?.room_id || S.roomId || '').trim().toUpperCase();
  return isRealRoomId(roomId);
}
function isActiveGameplay(p = S.lastState) {
  return Boolean(p && (p.hand_in_progress || p.hand_complete));
}
function isTableMode(p = S.lastState) {
  return Boolean(hasActiveRoom(p) && (p?.viewer_token_valid || S.token));
}
function syncPokerLayout(p = S.lastState) {
  const hasRoom = hasActiveRoom(p);
  const playing = isActiveGameplay(p);
  const tableMode = isTableMode(p);
  const wasTableMode = document.body.classList.contains('poker-table-mode');
  const seated = tableMode;
  // "hand-live" = a hand is actually being played (not the post-hand summary).
  // The core Fold/Check/Call/Raise/All-in bar shows only during a live hand so
  // it stays a stable, consistent set rather than appearing and disappearing.
  const handLive = Boolean(p && p.hand_in_progress && !p.hand_complete);
  const gameOver = Boolean(p?.game_winner);
  const myTurn = Boolean(p && p.viewer_token_valid && p.current_actor_index === p.viewer_seat
    && Array.isArray(p.legal_actions) && p.legal_actions.length > 0);
  document.body.classList.toggle('poker-table-mode', tableMode);
  document.body.classList.toggle('poker-playing', playing);
  document.body.classList.toggle('poker-hand-live', handLive);
  document.body.classList.toggle('poker-my-turn', myTurn);
  document.body.classList.toggle('poker-game-over', gameOver);
  document.body.classList.toggle('poker-lobby-mode', !tableMode);
  document.body.classList.toggle('poker-no-room', !hasRoom);
  const leaveBtn = $('leaveSeatBtn');
  if (leaveBtn) {
    leaveBtn.hidden = !seated;
    leaveBtn.disabled = !seated || Boolean(S.pendingMutation);
    leaveBtn.textContent = playing ? 'Leave Game' : 'Leave Table';
  }
  const copyBtn = $('copyRoomLinkBtn');
  if (copyBtn) copyBtn.disabled = !hasRoom;
  if (tableMode && !wasTableMode) {
    window.requestAnimationFrame(() => {
      const top = $('appMain')?.getBoundingClientRect().top ?? 0;
      window.scrollTo({ top: Math.max(0, window.scrollY + top - 4), behavior: 'smooth' });
    });
  }
}
function isRoomCreator(roomId = S.roomId) {
  const id = String(roomId || '').trim().toUpperCase();
  return Boolean(id && S.creatorTokens && S.creatorTokens[id]);
}
function creatorTokenFor(roomId = S.roomId) {
  return S.creatorTokens[String(roomId || '').trim().toUpperCase()] || '';
}
function activeCreatedRoomIds() { return Object.keys(S.creatorTokens || {}).filter(id => isRealRoomId(id)); }
if (!isRealRoomId(S.roomId)) { S.token = ''; localStorage.removeItem('poker.token'); }
function rememberCreatorToken(roomId, token) {
  const id = String(roomId || '').toUpperCase();
  if (!id || id === 'MAIN01') return;
  if (token) S.creatorTokens[id] = token;
  else delete S.creatorTokens[id];
}
function rememberRoomToken(roomId, token) {
  const id = String(roomId || '').toUpperCase();
  if (!id) return;
  if (token) S.tokensByRoom[id] = token;
  else delete S.tokensByRoom[id];
}
function switchRoom(roomId, connect=true) {
  const id = String(roomId || '').trim().toUpperCase();
  if (!isRealRoomId(id)) {
    S.roomId = '';
    S.token = '';
    S.hasRenderedState = false;
    save();
    stopPresenceHeartbeat();
    showNoRoomSelected();
    return;
  }
  S.roomId = id;
  S.token = tokenForRoom(S.roomId);
  S.hasRenderedState = false;
  save();
  startPresenceHeartbeat(Boolean(S.token));
  if (connect) connectWs();
}

const SUIT = {c:'♣️',d:'♦️',s:'♠️',h:'♥️'};
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch] || ch));
}
function displayRank(rank) { return String(rank || '').toUpperCase() === 'T' ? '10' : String(rank || ''); }
function winnerText(showdown = []) {
  const rows = Array.isArray(showdown) ? showdown : [];
  if (!rows.length) return '';
  if (rows.length === 1) {
    const w = rows[0];
    const hand = w.hand ? ` with ${w.hand}` : (w.reason === 'uncontested' ? ' uncontested' : '');
    return `${w.player_name} wins ${w.amount}${hand}`;
  }
  const names = rows.map(w => w.player_name).join(' + ');
  const amount = rows.map(w => w.amount).join(' / ');
  const hand = rows[0]?.hand ? ` with ${rows[0].hand}` : '';
  return `Split pot: ${names} win ${amount}${hand}`;
}

function winnerHeadline(showdown = []) {
  const rows = Array.isArray(showdown) ? showdown : [];
  if (!rows.length) return '';
  if (rows.length === 1) return `${rows[0].player_name} wins ${rows[0].amount} chips`;
  return `${rows.map(w => w.player_name).join(' + ')} split the pot`;
}
function showdownHandText(showdown = []) {
  const hands = [...new Set((Array.isArray(showdown) ? showdown : []).map(w => w.hand).filter(Boolean))];
  return hands.length ? hands.join(' / ') : '';
}
function boardText(cards = []) {
  const shown = (cards || []).filter(Boolean).map(pretty);
  return shown.length ? shown.join('  ') : 'No board cards';
}
function hashString(value) {
  let hash = 2166136261;
  for (const ch of String(value || '')) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function isBotSeat(seat) {
  return Boolean(seat && seat.ai_level && seat.ai_level !== 'human');
}
const BOT_AVATAR_PALETTES = [
  {bg:'#8ee0a8', face:'#164a3a', accent:'#f3df79', shadow:'#0b2b2b'},
  {bg:'#9ed1ff', face:'#1d3558', accent:'#ffdf86', shadow:'#112340'},
  {bg:'#ffc4df', face:'#603052', accent:'#9ee8ff', shadow:'#351d34'},
  {bg:'#c8ec72', face:'#405722', accent:'#fff2a1', shadow:'#243314'},
  {bg:'#b7a6ff', face:'#2d285a', accent:'#72efc5', shadow:'#181739'},
  {bg:'#ffbf78', face:'#633b1f', accent:'#d8fff3', shadow:'#3a2112'},
];
function botAvatarMarkup(seat, seatIndex) {
  if (!isBotSeat(seat)) return '';
  const seed = hashString(`${seat.player_name || ''}:${seat.ai_level || ''}:${seatIndex}`);
  const p = BOT_AVATAR_PALETTES[seed % BOT_AVATAR_PALETTES.length];
  const eye = seed % 3 === 0 ? 4 : 3;
  const brow = seed % 2 === 0
    ? `<path d="M17 25 Q23 20 29 24" fill="none" stroke="${p.accent}" stroke-width="3" stroke-linecap="round"/><path d="M35 24 Q41 20 47 25" fill="none" stroke="${p.accent}" stroke-width="3" stroke-linecap="round"/>`
    : `<rect x="17" y="21" width="12" height="4" rx="2" fill="${p.accent}" opacity=".9"/><rect x="35" y="21" width="12" height="4" rx="2" fill="${p.accent}" opacity=".9"/>`;
  const mouth = seed % 4 === 0
    ? '<path d="M24 43 Q32 49 40 43" fill="none" stroke="#eafff3" stroke-width="3" stroke-linecap="round"/>'
    : seed % 4 === 1
      ? '<path d="M25 43 H39" fill="none" stroke="#eafff3" stroke-width="3" stroke-linecap="round"/>'
      : '<path d="M25 41 Q32 45 39 41" fill="none" stroke="#eafff3" stroke-width="3" stroke-linecap="round"/>';
  const mark = seed % 3 === 0
    ? `<circle cx="47" cy="14" r="5" fill="${p.accent}" opacity=".9"/>`
    : seed % 3 === 1
      ? `<path d="M17 14 L25 7 L33 14 Z" fill="${p.accent}" opacity=".9"/>`
      : `<rect x="39" y="9" width="12" height="8" rx="4" fill="${p.accent}" opacity=".9"/>`;
  return `<span class="seat-avatar" aria-hidden="true"><svg viewBox="0 0 64 64" focusable="false">
    <rect width="64" height="64" rx="18" fill="${p.bg}"/>
    <path d="M0 49 C15 41 23 60 39 48 C49 40 54 50 64 43 V64 H0 Z" fill="${p.shadow}" opacity=".45"/>
    <circle cx="32" cy="34" r="22" fill="${p.face}"/>
    ${mark}
    ${brow}
    <circle cx="23" cy="33" r="${eye}" fill="#eafff3"/>
    <circle cx="41" cy="33" r="${eye}" fill="#eafff3"/>
    <circle cx="23" cy="33" r="1.6" fill="#071413"/>
    <circle cx="41" cy="33" r="1.6" fill="#071413"/>
    ${mouth}
  </svg></span>`;
}
function seatTurnIndicatorMarkup(p, seatIndex) {
  const active = p?.current_actor_index === seatIndex && p?.hand_in_progress && !p?.hand_complete;
  return active ? '<div class="seat-turn-indicator" aria-label="Current turn timer"></div>' : '';
}
function visualSeatPosition(p, seatIndex) {
  const maxSeats = Number(p?.max_seats || p?.seats?.length || 0);
  const viewerSeat = Number(p?.viewer_seat);
  if (!p?.viewer_token_valid || !Number.isInteger(viewerSeat) || !maxSeats) return seatIndex % 9;
  return ((Number(seatIndex) - viewerSeat + maxSeats) % maxSeats) % 9;
}
function handSummaryKey(p) {
  return p?.room?.room_id && p?.hand_id ? `${p.room.room_id}:${p.hand_id}` : '';
}

const AUDIO_STORAGE = { muted:'poker.audioMuted', volume:'poker.audioVolume' };
// Vercel cleanUrls can serve this page as /poker instead of /poker/index.html.
// Relative paths like ./audio/file.mp3 then resolve to /audio/file.mp3 and break only in deployment.
// Use a stable root path online while keeping file:// previews working.
const AUDIO_BASE = location.protocol === 'file:' ? './audio/' : '/poker/audio/';
const AUDIO_PATHS = {
  music:AUDIO_BASE + '8bit-bossa.mp3',
  ui:AUDIO_BASE + 'select_003.ogg',
  toggle:AUDIO_BASE + 'switch_002.ogg',
  deal:AUDIO_BASE + 'card-slide-3.ogg',
  place:AUDIO_BASE + 'card-place-2.ogg',
  revealOne:AUDIO_BASE + 'card-reveal-one.mp3',
  revealTwo:AUDIO_BASE + 'card-reveal-two.mp3',
  revealThree:AUDIO_BASE + 'card-reveal-three.mp3',
  shuffle:AUDIO_BASE + 'card-shuffle.ogg',
  fold:AUDIO_BASE + 'card-shove-2.ogg',
  bet:AUDIO_BASE + 'chip-lay-3.ogg',
  allIn:AUDIO_BASE + 'chips-stack-3.ogg',
  turn:AUDIO_BASE + 'confirmation_003.ogg',
  error:AUDIO_BASE + 'error_004.ogg',
};
const AUDIO_LEVELS = {
  ui:.34, toggle:.42, deal:.48, place:.5, revealOne:.72, revealTwo:.76, revealThree:.82, shuffle:.58, fold:.52,
  bet:.62, allIn:.75, turn:.62, error:.55,
};
const SPECIFIC_SOUND_BUTTONS = new Set([
  'createRoomBtn', 'joinSeatBtn', 'addAiBtn', 'startHandBtn', 'nextHandBtn',
  'resetBtn', 'leaveSeatBtn', 'foldBtn', 'checkBtn', 'callBtn', 'betBtn',
  'allInBtn', 'varianceBtn', 'muteBtn',
]);
const clampVolume = value => Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : 0.35));
const audioState = {
  muted: localStorage.getItem(AUDIO_STORAGE.muted) === '1',
  volume: clampVolume(localStorage.getItem(AUDIO_STORAGE.volume) ?? 0.35),
  music: null,
  unlocked: false,
  autostartAttempted: false,
  clips: {},
  preloaded: false,
};

async function api(path, opts={}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 9000);
  try {
    const r = await fetch(apiPath(path), {
      headers:{'Content-Type':'application/json'},
      ...opts,
      signal: opts.signal || controller.signal,
    });
    if (!r.ok) {
      const text = await r.text();
      let message = text;
      try { message = JSON.parse(text).detail || text; } catch(_) {}
      throw new Error(message || `Request failed (${r.status})`);
    }
    return (r.headers.get('content-type')||'').includes('json') ? r.json() : r.text();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Server took too long. Try once more.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function save() {
  syncRoomUrl();
  localStorage.setItem('poker.roomId', S.roomId||'');
  if (S.roomId) rememberRoomToken(S.roomId, S.token || '');
  localStorage.setItem('poker.token', S.token||'');
  localStorage.setItem('poker.tokensByRoom', JSON.stringify(S.tokensByRoom));
  localStorage.setItem('poker.clientId', S.clientId);
  localStorage.setItem('poker.creatorTokens', JSON.stringify(S.creatorTokens));
}

function musicAudio() {
  if (!audioState.music) {
    audioState.music = $('musicTrack') || new Audio();
    audioState.music.loop = true;
    audioState.music.preload = 'auto';
    audioState.music.setAttribute('playsinline', '');
  }
  if (!audioState.music.src || !audioState.music.src.includes('8bit-bossa.mp3')) {
    audioState.music.src = AUDIO_PATHS.music;
  }
  return audioState.music;
}

function updateAudioControls() {
  const muteBtn = $('muteBtn');
  const volumeRange = $('volumeRange');
  const volumeValue = $('volumeValue');
  if (volumeRange) volumeRange.value = String(audioState.volume);
  if (volumeValue) volumeValue.textContent = `${Math.round(audioState.volume * 100)}%`;
  if (muteBtn) {
    muteBtn.textContent = audioState.muted ? 'Unmute' : (audioState.unlocked ? 'Mute' : 'Music');
    muteBtn.setAttribute('aria-pressed', String(audioState.muted));
  }
  if (audioState.music) {
    audioState.music.muted = audioState.muted;
    audioState.music.volume = audioState.muted ? 0 : audioState.volume;
  }
}

function startMusic() {
  const music = musicAudio();
  music.muted = audioState.muted;
  music.volume = audioState.muted ? 0 : audioState.volume;
  if (audioState.muted || audioState.volume <= 0) {
    updateAudioControls();
    return Promise.resolve(false);
  }
  const attempt = music.play();
  if (!attempt?.then) {
    audioState.unlocked = true;
    updateAudioControls();
    return Promise.resolve(true);
  }
  return attempt.then(() => {
    audioState.unlocked = true;
    preloadAudioClips();
    updateAudioControls();
    return true;
  }).catch(() => {
    audioState.unlocked = false;
    updateAudioControls();
    return false;
  });
}

function tryAutostartMusic() {
  if (audioState.autostartAttempted) return;
  audioState.autostartAttempted = true;
  musicAudio();
  // Deployed browsers block autoplay until a real click/key press. This keeps
  // the player ready, then the name gate / Start Music click begins audio.
  updateAudioControls();
}

function preloadAudioClips() {
  if (audioState.preloaded) return;
  audioState.preloaded = true;
  Object.entries(AUDIO_PATHS).forEach(([name, src]) => {
    if (name === 'music') return;
    const clip = new Audio(src);
    clip.preload = 'auto';
    clip.load?.();
    audioState.clips[name] = clip;
  });
}

function unlockAudio() {
  preloadAudioClips();
  if (audioState.muted) {
    updateAudioControls();
    return Promise.resolve(false);
  }
  return startMusic();
}

function setMuted(muted) {
  audioState.muted = Boolean(muted);
  localStorage.setItem(AUDIO_STORAGE.muted, audioState.muted ? '1' : '0');
  updateAudioControls();
  if (audioState.muted) audioState.music?.pause();
  else startMusic();
}

function setVolume(value) {
  audioState.volume = clampVolume(value);
  // A zero slider acts like mute. Raising it again should immediately unmute.
  audioState.muted = audioState.volume <= 0;
  localStorage.setItem(AUDIO_STORAGE.volume, String(audioState.volume));
  localStorage.setItem(AUDIO_STORAGE.muted, audioState.muted ? '1' : '0');
  updateAudioControls();
  if (!audioState.muted) startMusic();
}

function playSound(name, volumeScale=1, delay=0) {
  if (audioState.muted || !AUDIO_PATHS[name] || audioState.volume <= 0) return;
  const run = () => {
    preloadAudioClips();
    const base = audioState.clips[name];
    const clip = base ? base.cloneNode(true) : new Audio(AUDIO_PATHS[name]);
    clip.preload = 'auto';
    clip.volume = Math.max(0, Math.min(1, audioState.volume * (AUDIO_LEVELS[name] || .5) * volumeScale));
    clip.currentTime = 0;
    clip.play().catch(() => {});
  };
  if (delay) window.setTimeout(run, delay);
  else run();
}

function playActionSound(action) {
  if (action === 'fold') playSound('fold');
  else if (action === 'all_in') { S.lastChipSoundAt = performance.now(); playSound('allIn'); }
  else if (action === 'call' || action === 'bet' || action === 'raise') { S.lastChipSoundAt = performance.now(); playSound('bet'); }
  else playSound('ui', .7);
}

function playCardRevealSound(type, delay = 0) {
  if (type === 'hole') playSound('revealTwo', 1, delay);
  else if (type === 'flop') playSound('revealThree', 1, delay);
  else if (type === 'turnRiver') playSound('revealOne', 1, delay);
}

function playCardRevealSequence({ holeCards = 0, communityCards = 0 } = {}) {
  // Exact poker reveal mapping:
  // - 2-card sound when your hole cards become visible.
  // - 3-card sound when the flop appears.
  // - 1-card sound for turn and river.
  let delay = 0;
  if (holeCards >= 2) { playCardRevealSound('hole', delay); delay += 360; }
  if (communityCards >= 3) { playCardRevealSound('flop', delay); delay += 420; }
  else if (communityCards === 1) { playCardRevealSound('turnRiver', delay); delay += 260; }
  else if (communityCards === 2) {
    playCardRevealSound('turnRiver', delay);
    playCardRevealSound('turnRiver', delay + 220);
  }
}

function currentViewerHoleCount(p) {
  if (!p || !p.viewer_token_valid || p.viewer_seat == null) return 0;
  const seat = p.seats?.[p.viewer_seat];
  return (seat?.hole_cards || []).filter(c => c && c !== '??').length;
}

function aiLevelLabel(level) {
  return { ai_easy:'Easy Bot', ai_medium:'Medium Bot', ai_hard:'Hard Bot' }[level] || 'Bot';
}

function firstOpenSeatIndex(p = S.lastState) {
  if (!p?.seats) return null;
  for (let i = 0; i < p.seats.length; i++) if (!p.seats[i]) return i;
  return null;
}

function updateBetSlider(p, legalDetails) {
  const wrap = $('betSliderWrap');
  const input = $('betAmount');
  const value = $('betAmountValue');
  const label = $('betSliderLabel');
  const action = $('betBtn')?.dataset?.action || 'bet';
  const spec = legalDetails.find(a => a.action === action);
  const viewer = p?.viewer_token_valid && p.viewer_seat != null ? p.seats?.[p.viewer_seat] : null;
  const canBet = Boolean(spec && input && wrap);
  if (!canBet) {
    if (wrap) wrap.classList.add('disabled');
    if (input) input.disabled = true;
    if (value) value.textContent = '—';
    return;
  }
  const rawMin = Number(spec.min_total ?? 1);
  const rawMax = Number(spec.max_total ?? (viewer?.chip_stack ?? rawMin));
  const min = Math.max(1, Math.floor(rawMin));
  const max = Math.max(min, Math.floor(rawMax));
  let current = Number(input.value || min);
  if (!Number.isFinite(current) || current < min || current > max) current = min;
  current = Math.min(max, Math.max(min, Math.round(current)));
  input.disabled = false;
  input.min = String(min);
  input.max = String(max);
  input.step = '1';
  input.value = String(current);
  wrap.classList.remove('disabled');
  if (label) label.textContent = action === 'raise' ? 'Raise to' : 'Bet amount';
  if (value) value.textContent = `${current} / ${max}`;
}

function syncBetSliderLabel() {
  const input = $('betAmount');
  const value = $('betAmountValue');
  if (input && value) value.textContent = `${input.value} / ${input.max || input.value}`;
}

function syncBotControls(p = S.lastState) {
  const aiSelect = $('aiKindSelect');
  const addBtn = $('addAiBtn');
  const tools = $('botTools');
  if (!addBtn) return;
  const handLocked = Boolean(p?.hand_in_progress && !p?.hand_complete);
  const openSeat = firstOpenSeatIndex(p);
  const canAdd = openSeat != null && !handLocked;
  addBtn.disabled = !canAdd;
  addBtn.textContent = canAdd ? `Add ${aiLevelLabel(aiSelect?.value)}` : (handLocked ? 'Bots locked' : 'No seats');
  tools?.classList.toggle('disabled', !canAdd);
}

function updateCardRevealSounds(p) {
  if (!p || !p.hand_in_progress || p.hand_complete) return;
  const handKey = `${p.room?.room_id || S.roomId}:${p.hand_id || 0}`;
  const handChanged = S.lastRevealHandKey !== handKey;
  if (handChanged) {
    S.lastRevealHandKey = handKey;
    S.lastRevealCommunityCount = 0;
    S.lastRevealHoleCount = 0;
    S.playedHoleRevealFor = '';
  }

  const holeCount = currentViewerHoleCount(p);
  const communityCount = (p.community_cards || []).filter(Boolean).length;
  let delay = 0;

  // Your two-card reveal: this now works even when a start-hand response is the
  // first render after the hand begins. Previously that first render could be
  // treated as "firstRender" and the sound got skipped.
  if (holeCount >= 2 && S.playedHoleRevealFor !== handKey) {
    playCardRevealSound('hole', delay);
    S.playedHoleRevealFor = handKey;
    delay += 360;
  }

  const previousBoard = handChanged ? 0 : Number(S.lastRevealCommunityCount || 0);
  if (previousBoard < 3 && communityCount >= 3) {
    playCardRevealSound('flop', delay);
    delay += 420;
  }
  if (previousBoard < 4 && communityCount >= 4) {
    playCardRevealSound('turnRiver', delay);
    delay += 260;
  }
  if (previousBoard < 5 && communityCount >= 5) {
    playCardRevealSound('turnRiver', delay);
  }

  S.lastRevealHoleCount = holeCount;
  S.lastRevealCommunityCount = communityCount;
}

function setupAudioControls() {
  updateAudioControls();
  tryAutostartMusic();
  $('muteBtn')?.addEventListener('click', () => {
    if (audioState.muted) {
      setMuted(false);
      playSound('toggle');
      return;
    }
    if (!audioState.unlocked) {
      startMusic().then(ok => { if (ok) playSound('toggle'); });
      return;
    }
    setMuted(true);
  });
  $('volumeRange')?.addEventListener('input', (e) => {
    setVolume(e.target.value);
  });
  ['pointerdown', 'touchstart', 'keydown'].forEach(type => {
    document.addEventListener(type, (event) => {
      if (event.target?.closest?.('#muteBtn')) return;
      if (!audioState.unlocked && !audioState.muted) startMusic();
    }, { once:true, capture:true });
  });
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('button');
    if (!el || el.disabled || el.id === 'muteBtn') return;
    if (SPECIFIC_SOUND_BUTTONS.has(el.id) || el.closest('.seat-empty') || el.classList.contains('del-btn')) return;
    playSound('ui', .45);
  });
  document.addEventListener('change', (e) => {
    if (e.target.matches?.('select')) playSound('ui', .38);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Stop full polling while hidden, but keep an ultra-low-cost 30-minute heartbeat
      // so switching tabs does not release the seat. Closing the tab stops this heartbeat,
      // then the server clears the seat after the longer timeout.
      stopRoomPollingTimerOnly();
      stopLobbyPollingTimerOnly();
      startPresenceHeartbeat(false);
      if ($('hintText')) $('hintText').textContent = HIDDEN_POLLING_MESSAGE;
      return;
    }
    startPresenceHeartbeat(true);
    if (CONFIG.transport === 'polling') {
      if (S.wantsRoomPolling) startPolling('Reconnected. Updates resumed.');
      if (S.wantsLobbyPolling) { loadRooms(); scheduleNextLobbyPoll(); }
    }
    if (audioState.unlocked && !audioState.muted) startMusic();
  });
}

function isPageVisibleForPolling() {
  return document.visibilityState !== 'hidden';
}

function stopRoomPollingTimerOnly() {
  if (S.pollTimer) { clearTimeout(S.pollTimer); S.pollTimer = null; }
}

function stopLobbyPollingTimerOnly() {
  if (S.lobbyPollTimer) { clearTimeout(S.lobbyPollTimer); S.lobbyPollTimer = null; }
}

function bumpFastPolling(ms = 6500) {
  S.fastPollUntil = Math.max(S.fastPollUntil || 0, Date.now() + ms);
  if (S.wantsRoomPolling && isPageVisibleForPolling()) scheduleNextRoomPoll();
}

function applyServerPayload(payload, { rooms = false, fast = 0 } = {}) {
  if (!payload) return Promise.resolve();
  if (payload.kicked_token && payload.kicked_token === S.token) {
    rememberRoomToken(S.roomId, '');
    S.token = '';
    save();
    stopPresenceHeartbeat();
  }
  if (payload.recovered_token && payload.recovered_token !== S.token) {
    S.token = payload.recovered_token;
    rememberRoomToken(payload.room?.room_id || S.roomId, S.token);
    save();
  }
  if (payload.state) render(payload.state);
  if (Array.isArray(payload.rooms)) renderRoomList(payload.rooms);
  else if (rooms) return loadRooms();
  if (fast) bumpFastPolling(fast);
  return Promise.resolve();
}

function setBusy(isBusy) {
  S.pendingMutation = Boolean(isBusy);
  document.body.classList.toggle('is-busy', S.pendingMutation);
  syncPokerLayout(S.lastState);
}

async function runMutation(work) {
  if (S.pendingMutation) return null;
  setBusy(true);
  try { return await work(); }
  finally { setBusy(false); }
}

function roomPollDelay() {
  if (Date.now() < (S.fastPollUntil || 0)) return FAST_BURST_POLL_MS;
  const activeHand = Boolean(S.lastState?.hand_in_progress);
  const seated = Boolean(S.token || S.lastState?.viewer_token_valid);
  if (activeHand) return ACTIVE_ROOM_POLL_MS;
  if (seated) return WAITING_SEATED_ROOM_POLL_MS;
  return IDLE_ROOM_POLL_MS;
}

function scheduleNextRoomPoll() {
  stopRoomPollingTimerOnly();
  if (!S.wantsRoomPolling || !isPageVisibleForPolling()) return;
  S.pollTimer = setTimeout(async () => {
    S.pollTimer = null;
    await refreshState(false);
    scheduleNextRoomPoll();
  }, roomPollDelay());
}

function scheduleNextLobbyPoll() {
  stopLobbyPollingTimerOnly();
  // Lobby auto-polling is intentionally very slow and only while visible.
  // Most updates happen directly after create/join/leave, and Refresh Rooms remains manual.
  if (!S.wantsLobbyPolling || !isPageVisibleForPolling()) return;
  S.lobbyPollTimer = setTimeout(async () => {
    S.lobbyPollTimer = null;
    await loadRooms();
    scheduleNextLobbyPoll();
  }, LOBBY_POLL_MS);
}

function clearPolling() {
  S.wantsRoomPolling = false;
  stopRoomPollingTimerOnly();
}

function clearLobbyPolling() {
  S.wantsLobbyPolling = false;
  stopLobbyPollingTimerOnly();
}

function stopPresenceHeartbeat() {
  if (S.heartbeatTimer) { clearTimeout(S.heartbeatTimer); S.heartbeatTimer = null; }
}

function heartbeatDelay() {
  return document.hidden ? HEARTBEAT_HIDDEN_MS : HEARTBEAT_VISIBLE_MS;
}

async function sendPresenceHeartbeat() {
  if (!S.roomId || !S.token) return false;
  try {
    const result = await api('/api/heartbeat', {
      method:'POST',
      timeoutMs:5000,
      body:JSON.stringify({ room_id:S.roomId, token:S.token, client_id:S.clientId })
    });
    if (result && result.ok === false) {
      rememberRoomToken(S.roomId, '');
      S.token = '';
      save();
      stopPresenceHeartbeat();
      if ($('hintText')) $('hintText').textContent = 'Seat expired. Join again to sit back down.';
      return false;
    }
    return true;
  } catch (_) {
    // Do not spam the UI for heartbeat hiccups; normal polling/actions still show errors.
    return false;
  }
}

function startPresenceHeartbeat(immediate = false) {
  stopPresenceHeartbeat();
  if (!S.roomId || !S.token) return;
  if (immediate) sendPresenceHeartbeat();
  S.heartbeatTimer = setTimeout(async () => {
    S.heartbeatTimer = null;
    await sendPresenceHeartbeat();
    startPresenceHeartbeat(false);
  }, heartbeatDelay());
}

async function refreshState(showError=true) {
  if (!isRealRoomId(S.roomId)) {
    showNoRoomSelected();
    return;
  }
  try {
    const p = await api(`/api/state?room_id=${encodeURIComponent(S.roomId)}&token=${encodeURIComponent(S.token)}&client_id=${encodeURIComponent(S.clientId)}`);
    if (p.recovered_token && p.recovered_token !== S.token) {
      S.token = p.recovered_token;
      rememberRoomToken(p.room.room_id, S.token);
      save();
    }
    render(p);
  } catch(e) {
    if (/room id not found|room doesn't exist|doesn't exist/i.test(e.message || '')) {
      S.roomId = '';
      S.token = '';
      save();
      await loadRooms();
      showNoRoomSelected();
      return;
    }
    if (showError) {
      $('hintText').textContent = 'State refresh failed: ' + e.message;
      playSound('error');
    }
  }
}

function startPolling(message='Connected (polling).', immediate=true) {
  S.wantsRoomPolling = true;
  if (S.ws) { try { S.ws.close(); } catch(_) {} S.ws = null; }
  if (S.wsTimer) { clearTimeout(S.wsTimer); S.wsTimer = null; }
  if (!isPageVisibleForPolling()) {
    stopRoomPollingTimerOnly();
    $('hintText').textContent = HIDDEN_POLLING_MESSAGE;
    return;
  }
  stopRoomPollingTimerOnly();
  if (immediate) refreshState().finally(scheduleNextRoomPoll);
  else scheduleNextRoomPoll();
  $('hintText').textContent = message;
}

function startLobbyPolling() {
  // Load the lobby once on entry, but do not constantly poll the room list.
  // This keeps Upstash usage low when someone is just sitting in the game.
  S.wantsLobbyPolling = false;
  if (S.lobbyWs) { try { S.lobbyWs.close(); } catch(_) {} S.lobbyWs = null; }
  if (S.lobbyTimer) { clearTimeout(S.lobbyTimer); S.lobbyTimer = null; }
  stopLobbyPollingTimerOnly();
  if (isPageVisibleForPolling()) loadRooms();
}

async function refreshAfterChange({rooms=false}={}) {
  if (S.pollTimer || !S.ws || S.ws.readyState !== WebSocket.OPEN) await refreshState();
  if (rooms || S.lobbyPollTimer || !S.lobbyWs || S.lobbyWs.readyState !== WebSocket.OPEN) await loadRooms();
}

function connectWs(immediate=true, message='Connected (Vercel polling mode).') {
  if (!isRealRoomId(S.roomId)) {
    showNoRoomSelected();
    return;
  }
  if (CONFIG.transport === 'polling') {
    startPolling(message, immediate);
    return;
  }
  clearPolling();
  if (S.ws) try { S.ws.close(); } catch(_) {}
  if (S.wsTimer) { clearTimeout(S.wsTimer); S.wsTimer = null; }
  let url = wsPath(`/ws/room/${encodeURIComponent(S.roomId)}`);
  if (S.token) url += `?token=${encodeURIComponent(S.token)}`;
  let sock;
  let opened = false;
  try {
    sock = new WebSocket(url);
  } catch(_) {
    startPolling('Connected (polling fallback).');
    return;
  }
  S.ws = sock;
  sock.onopen = () => { opened = true; $('hintText').textContent = 'Connected (real-time).'; };
  sock.onmessage = e => {
    let msg; try { msg = JSON.parse(e.data); } catch(_) { return; }
    if (msg.type==='welcome'||msg.type==='room_state') { render(msg.payload); loadRooms(); }
    else if (msg.type==='room_closed') { S.roomId=''; S.token=''; save(); showNoRoomSelected(); }
    else if (msg.type==='error') { $('hintText').textContent='Server: '+(msg.payload?.detail||'error'); playSound('error'); }
  };
  sock.onclose = () => {
    if (CONFIG.transport === 'websocket' || opened) S.wsTimer = setTimeout(connectWs, 2000);
    else startPolling('Connected (polling fallback for serverless hosting).');
  };
  sock.onerror = () => { try { sock.close(); } catch(_) {} };
}
function connectLobbyWs() {
  if (CONFIG.transport === 'polling') {
    startLobbyPolling();
    return;
  }
  clearLobbyPolling();
  if (S.lobbyWs) try { S.lobbyWs.close(); } catch(_) {}
  if (S.lobbyTimer) { clearTimeout(S.lobbyTimer); S.lobbyTimer = null; }
  const url = wsPath('/ws/lobby');
  let sock;
  let opened = false;
  try {
    sock = new WebSocket(url);
  } catch(_) {
    startLobbyPolling();
    return;
  }
  S.lobbyWs = sock;
  sock.onopen = () => { opened = true; };
  sock.onmessage = e => {
    let msg; try { msg = JSON.parse(e.data); } catch(_) { return; }
    if (msg.type === 'rooms_updated') loadRooms();
  };
  sock.onclose = () => {
    if (CONFIG.transport === 'websocket' || opened) S.lobbyTimer = setTimeout(connectLobbyWs, 2000);
    else startLobbyPolling();
  };
  sock.onerror = () => { try { sock.close(); } catch(_) {} };
}
function sendWsToken() {
  if (S.ws && S.ws.readyState===WebSocket.OPEN && S.token)
    S.ws.send(JSON.stringify({type:'set_token', token:S.token}));
  else refreshState();
}

function pretty(code) {
  if (!code||typeof code!=='string') return '';
  if (code === '??') return '??';
  const suit = code.slice(-1).toLowerCase(), rank = displayRank(code.slice(0,-1));
  return rank + (SUIT[suit]||'');
}
function cardEl(code, i, anim) {
  const d = (i||0)*0.1, s = anim ? `animation:flipIn .45s ease-out ${d}s both;` : '';
  return `<div class="card-wrap"><div class="card" style="${s}">${pretty(code)}</div></div>`;
}
function miniEl(code, i, anim) {
  const d = (i||0)*0.1, s = anim ? `animation:flipIn .45s ease-out ${d}s both;` : '';
  return `<div class="mini-wrap"><div class="mini" style="${s}">${pretty(code)}</div></div>`;
}

async function copyRoomLink(roomId = S.roomId) {
  const previousRoom = S.roomId;
  const targetRoom = String(roomId || previousRoom || '').toUpperCase();
  if (!isRealRoomId(targetRoom)) {
    $('hintText').textContent = 'Create or join a table before copying a link.';
    playSound('error', .45);
    return;
  }
  S.roomId = targetRoom;
  let url;
  try { url = roomInviteUrl(); }
  catch (e) { S.roomId = previousRoom; $('hintText').textContent = e.message; playSound('error', .45); return; }
  S.roomId = previousRoom;
  try {
    await navigator.clipboard.writeText(url);
    $('hintText').textContent = `Copied invite link for room ${targetRoom}.`;
    playSound('ui', .45);
  } catch (_) {
    window.prompt('Copy this poker room link:', url);
  }
}

function showStorageNotice(message, ok=false) {
  const box = $('storageNotice');
  if (!box) return;
  box.hidden = false;
  box.classList.toggle('ok', Boolean(ok));
  box.textContent = message;
}

async function checkBackendStorage() {
  try {
    const h = await api('/api/health');
    if (h.storage === 'redis') {
      showStorageNotice('Multiplayer storage connected. Tables will persist while you and friends switch tabs.', true);
    } else {
      showStorageNotice('Temporary server storage detected. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel or private tables can disappear between requests.');
    }
  } catch (e) {
    showStorageNotice('Could not check multiplayer storage: ' + e.message);
  }
}

function syncInvitePanel(p = S.lastState) {
  const panel = $('invitePanel');
  if (!panel) return;
  const room = p?.room;
  const roomId = String(room?.room_id || S.roomId || '').toUpperCase();
  if (!isRealRoomId(roomId)) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $('inviteCode').textContent = roomId;
  const creator = isRoomCreator(roomId);
  $('inviteTitle').textContent = creator ? 'Your table is ready' : 'Invite link';
  $('inviteHelp').textContent = creator
    ? 'Send this link to your friend. They will join and sit automatically.'
    : 'Share this table link with another player.';
}

function stopTurnCountdown() {
  if (S.turnCountdownTimer) clearInterval(S.turnCountdownTimer);
  S.turnCountdownTimer = null;
}

function resetTurnTimer() {
  S.turnTimerKey = '';
  S.turnTimerEnd = 0;
  stopTurnCountdown();
  updateTurnTimer();
}

function turnTimerKey(p) {
  if (!p) return '';
  return `${p.room?.room_id || ''}:${p.hand_id}:${p.current_actor_index}:${p.current_bet_to_call}:${p.street}`;
}

function turnProgressRatio(p = S.lastState) {
  const actor = p?.current_actor_index;
  const end = Number(S.turnTimerEnd) || 0;
  if (!end || actor == null || !p?.hand_in_progress || p?.hand_complete) return 0;
  const started = Number(p.turn_started_at) || 0;
  const deadline = Number(p.turn_deadline_at) || 0;
  const total = deadline > started ? Math.max(1000, deadline - started) : 30000;
  return Math.max(0, Math.min(1, (end - Date.now()) / total));
}

function updateSeatTurnIndicator() {
  const indicators = document.querySelectorAll('.seat-turn-indicator');
  if (!indicators.length) return;
  const p = S.lastState;
  const actor = p?.current_actor_index;
  indicators.forEach(el => {
    const ratio = actor != null && el.closest('.player')?.dataset.seat === String(actor)
      ? turnProgressRatio(p)
      : 0;
    el.style.setProperty('--turn-angle', `${Math.round(ratio * 360)}deg`);
    el.classList.toggle('is-low', ratio > 0 && ratio <= .18);
  });
}

// Reads only the locally-anchored deadline (S.turnTimerEnd), never the raw
// server timestamp, so each tick is consistent and monotonic.
function updateTurnTimer() {
  const el = $('turnTimer');
  if (!el) return;
  const p = S.lastState;
  const actor = p?.current_actor_index;
  const viewerSeat = p?.viewer_seat;
  const end = Number(S.turnTimerEnd) || 0;
  if (!end || actor == null || !p?.hand_in_progress || p?.hand_complete) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('is-mine','is-low');
    updateSeatTurnIndicator();
    return;
  }
  const left = Math.max(0, Math.round((end - Date.now()) / 1000));
  const isMine = viewerSeat != null && actor === viewerSeat;
  el.hidden = false;
  el.textContent = isMine ? `Your turn · ${left}s` : `Seat ${Number(actor) + 1} to act · ${left}s`;
  el.classList.toggle('is-mine', isMine);
  el.classList.toggle('is-low', left <= 10);
  updateSeatTurnIndicator();
}

function startTurnCountdown(p) {
  stopTurnCountdown();
  const active = p && p.turn_deadline_at && p.current_actor_index != null && p.hand_in_progress && !p.hand_complete;
  if (!active) { resetTurnTimer(); return; }
  const key = turnTimerKey(p);
  // Anchor the countdown to a single LOCAL deadline, captured once when a new
  // turn begins. Re-anchoring only on a real turn change (not every poll)
  // stops clock-skew between the server timestamp and the browser clock from
  // making the number bounce around (e.g. 3s -> 10s -> 2s -> 10s). Prefer the
  // server-computed seconds-left, which is already skew-free.
  if (key !== S.turnTimerKey || !S.turnTimerEnd) {
    const secs = Number(p.turn_seconds_left);
    S.turnTimerEnd = (Number.isFinite(secs) && secs > 0)
      ? Date.now() + secs * 1000
      : (Number(p.turn_deadline_at) || 0);
    S.turnTimerKey = key;
  }
  updateTurnTimer();
  S.turnCountdownTimer = setInterval(updateTurnTimer, 250);
}

function clearAutoNextCountdown(resetKey = false) {
  if (S.autoNextTimer) { clearTimeout(S.autoNextTimer); S.autoNextTimer = null; }
  if (S.autoNextInterval) { clearInterval(S.autoNextInterval); S.autoNextInterval = null; }
  S.autoNextDeadline = 0;
  if (resetKey) S.autoNextKey = '';
}
function autoNextSecondsLeft() {
  if (!S.autoNextDeadline) return 10;
  return Math.max(0, Math.ceil((S.autoNextDeadline - Date.now()) / 1000));
}
function autoNextSecondsForKey(key) {
  return S.autoNextKey === key && S.autoNextDeadline ? autoNextSecondsLeft() : 10;
}
function hideHandResultBanner() {
  const banner = $('winnerBanner');
  if (banner) { banner.hidden = true; banner.innerHTML = ''; }
  const panel = $('handSummary');
  if (panel) { panel.hidden = true; panel.innerHTML = ''; }
}
function prepareHandAdvance() {
  const key = handSummaryKey(S.lastState);
  if (key) S.autoNextSuppressedKey = key;
  clearAutoNextCountdown(true);
  hideHandResultBanner();
}
function updateAutoNextText(seconds = null, message = '') {
  const el = $('autoNextText');
  if (!el) return;
  if (message) { el.textContent = message; return; }
  if (seconds == null) seconds = autoNextSecondsLeft();
  el.textContent = `Next: ${seconds}s`; 
}
function startAutoNextCountdown(p) {
  const key = handSummaryKey(p);
  if (!key || S.autoNextSuppressedKey === key || !isRoomCreator(p.room?.room_id || S.roomId)) return;
  if (p.game_winner) return;
  if (!p.hand_complete || p.hand_in_progress || Number(p.room?.occupied_seats || 0) < 2) return;
  if (S.autoNextKey === key && S.autoNextDeadline) {
    updateAutoNextText(autoNextSecondsLeft());
    return;
  }
  S.autoNextKey = key;
  clearAutoNextCountdown();
  S.autoNextKey = key;
  S.autoNextDeadline = Date.now() + 10000;
  updateAutoNextText(autoNextSecondsLeft());
  S.autoNextInterval = setInterval(() => updateAutoNextText(autoNextSecondsLeft()), 250);
  S.autoNextTimer = setTimeout(async () => {
    clearAutoNextCountdown();
    if (S.lastState && handSummaryKey(S.lastState) === key && S.lastState.hand_complete) {
      await nextHand();
    }
  }, 10000);
}
function stopAutoNextIfNeeded(p) {
  if (!p?.hand_complete) {
    clearAutoNextCountdown(true);
    const key = handSummaryKey(p);
    if (!key || S.autoNextSuppressedKey !== key) S.autoNextSuppressedKey = '';
    return;
  }
}
function renderHandSummary(p, winnerSummary) {
  // The hand result now lives only on the table banner. The old centered modal
  // is intentionally kept hidden so it never covers cards/seats.
  const panel = $('handSummary');
  if (panel) { panel.hidden = true; panel.innerHTML = ''; }

  const banner = $('winnerBanner');
  if (!banner) return;
  const key = handSummaryKey(p);
  if (S.autoNextSuppressedKey && S.autoNextSuppressedKey !== key) S.autoNextSuppressedKey = '';
  if (!p?.hand_complete || !winnerSummary || S.dismissedSummaryKey === key || S.autoNextSuppressedKey === key) {
    banner.hidden = true;
    banner.innerHTML = '';
    clearAutoNextCountdown(S.autoNextSuppressedKey !== key);
    return;
  }

  const rows = Array.isArray(p.showdown) ? p.showdown : [];
  const viewerSeat = p.viewer_seat;
  const viewerWon = viewerSeat != null && rows.some(r => Number(r.seat_number) === Number(viewerSeat));
  const uncontested = rows.length === 1 && rows[0]?.reason === 'uncontested';
  const headline = winnerHeadline(rows) || winnerSummary;
  const hand = showdownHandText(rows);
  const creator = isRoomCreator(p.room?.room_id || S.roomId);
  const canAuto = creator && !p.game_winner && Number(p.room?.occupied_seats || 0) >= 2;
  const autoNextSeconds = canAuto ? autoNextSecondsForKey(key) : null;

  // Plain-language result: emphasise when the viewer wins, and never leave a
  // fold-win ambiguous — spell out that everyone else folded.
  const title = viewerWon
    ? (uncontested ? '🏆 You win — everyone folded' : '🏆 You win!')
    : (uncontested ? '🏆 Hand won — everyone folded' : '🏆 Result');
  const reason = uncontested
    ? (viewerWon ? 'All other players folded, so the pot is yours.' : 'All other players folded.')
    : '';

  banner.hidden = false;
  banner.classList.toggle('is-you', viewerWon);
  banner.classList.toggle('by-fold', uncontested);
  banner.innerHTML = `
    <span class="winner-title">${title}</span>
    <span class="winner-detail">${escapeHtml(headline)}</span>
    ${reason ? `<span class="winner-reason">${escapeHtml(reason)}</span>` : ''}
    ${hand ? `<span class="winner-hand">${escapeHtml(hand)}</span>` : ''}
    <span class="winner-timer" id="autoNextText">${p.game_winner ? 'Game over' : (canAuto ? `Next: ${autoNextSeconds}s` : 'Waiting for creator')}</span>
    ${creator && !p.game_winner ? '<button class="primary winner-start" id="summaryStartNow" type="button">Start</button>' : ''}`;

  const startBtn = $('summaryStartNow');
  if (startBtn) startBtn.onclick = async () => { await nextHand(); };
  if (canAuto) startAutoNextCountdown(p);
}

function renderGameOver(p) {
  const panel = $('gameOverPanel');
  if (!panel) return;
  const winner = p?.game_winner || null;
  if (!winner) {
    panel.hidden = true;
    if ($('gameOverActions')) $('gameOverActions').hidden = true;
    return;
  }
  clearAutoNextCountdown(true);
  const creator = isRoomCreator(p.room?.room_id || S.roomId);
  panel.hidden = false;
  if ($('gameOverTitle')) $('gameOverTitle').textContent = `${winner.player_name} wins the game`;
  if ($('gameOverDetail')) {
    $('gameOverDetail').textContent = creator
      ? `Seat ${Number(winner.seat_number) + 1} finished with ${winner.chip_stack} chips.`
      : `Seat ${Number(winner.seat_number) + 1} finished with ${winner.chip_stack} chips. Waiting for the host.`;
  }
  const actions = $('gameOverActions');
  if (actions) actions.hidden = !creator;
}

function showNoRoomSelected() {
  clearPolling();
  stopRoomPollingTimerOnly();
  S.lastState = null;
  S.hasRenderedState = false;
  const title = $('roomTitle'), meta = $('roomMeta'), table = $('table');
  if (title) title.textContent = 'Create or join a table';
  if (meta) meta.textContent = 'No active table selected';
  if ($('streetLabel')) $('streetLabel').textContent = 'Waiting for a table';
  if ($('potLabel')) $('potLabel').textContent = 'Pot: 0';
  if ($('communityCards')) $('communityCards').innerHTML = '';
  if ($('winnerBanner')) { $('winnerBanner').hidden = true; $('winnerBanner').innerHTML = ''; }
  if ($('gameOverPanel')) $('gameOverPanel').hidden = true;
  if ($('gameOverActions')) $('gameOverActions').hidden = true;
  if ($('callMatchBanner')) { $('callMatchBanner').hidden = true; $('callMatchBanner').innerHTML = ''; }
  if ($('mobileCallPanel')) { $('mobileCallPanel').hidden = true; $('mobileCallPanel').innerHTML = ''; $('mobileCallPanel').className = 'mobile-call-panel'; }
  if ($('handSummary')) { $('handSummary').hidden = true; $('handSummary').innerHTML = ''; }
  if ($('invitePanel')) $('invitePanel').hidden = true;
  resetTurnTimer();
  clearAutoNextCountdown();
  if (table) table.querySelectorAll('.player').forEach(n => n.remove());
  ['foldBtn','checkBtn','callBtn','allInBtn','betBtn','startHandBtn','nextHandBtn','leaveSeatBtn','resetBtn','joinSeatBtn','addAiBtn'].forEach(id => { const el=$(id); if (el) el.disabled = true; });
  if ($('callBtn')) $('callBtn').textContent = 'Call';
  if ($('hintText')) $('hintText').textContent = 'Create a room or join a friend\'s invite link to start.';
  syncPokerLayout(null);
  syncRoomUrl();
}

function renderRoomList(rooms = []) {
  const visibleRooms = (rooms || []).filter(room => isRealRoomId(room?.room_id) && !room.is_default);
  $('roomList').innerHTML = '';
  if (!visibleRooms.length) {
    $('roomList').innerHTML = '<div class="room-list-empty">No private tables yet. Create Room to start one, or open a friend\'s invite link.</div>';
    return;
  }
  visibleRooms.forEach(room => {
    const div = document.createElement('div'); div.className = 'room-card';
    const canDel = !room.is_default && S.creatorTokens[room.room_id];
    const active = String(room.room_id).toUpperCase() === String(S.roomId).toUpperCase();
    div.classList.toggle('active-room', active);
    const full = room.open_seats <= 0;
    const statusPill = room.game_complete ? 'Finished' : (room.hand_in_progress ? 'In play' : (full ? 'Full' : 'Open'));
    const statusClass = room.game_complete ? 'is-full' : (room.hand_in_progress ? 'is-playing' : (full ? 'is-full' : 'is-open'));
    const joinLabel = active && S.token ? 'Open Table' : (full ? 'Table Full' : 'Join & Sit');
    div.innerHTML = `
      <div class="room-card-head">
        <strong>${escapeHtml(room.name)}${active ? ' <span class="room-current">· current</span>' : ''}</strong>
        <span class="room-status ${statusClass}">${statusPill}</span>
      </div>
      <div class="room-meta">
        <span class="room-pill">${escapeHtml(room.room_id)}</span>
        <span class="room-pill">${escapeHtml(room.variant_display)}</span>
        <span class="room-pill">${room.occupied_seats}/${room.max_seats} seated</span>
      </div>
      <button class="join-btn"${full && !(active && S.token) ? ' disabled' : ''}>${joinLabel}</button>
      <div class="room-card-actions">
        <button class="copy-room-btn ghost-btn" type="button">Copy link</button>
        ${canDel ? '<button class="warn del-btn">Delete</button>' : ''}
      </div>`;
    div.querySelector('.join-btn').onclick = () => { autoJoinRoom(room.room_id); };
    div.querySelector('.copy-room-btn').onclick = async () => { await copyRoomLink(room.room_id); };
    if (canDel) div.querySelector('.del-btn').onclick = () => deleteRoom(room.room_id);
    $('roomList').appendChild(div);
  });
}

async function loadRooms() {
  const data = await api('/api/rooms');
  renderRoomList(data.rooms || []);
  return data;
}

function setCallMatchViews(html, className) {
  const banner = $('callMatchBanner');
  const mobile = $('mobileCallPanel');
  [banner, mobile].forEach(el => {
    if (!el) return;
    el.hidden = !html;
    el.className = el.id === 'mobileCallPanel' ? 'mobile-call-panel' : 'call-match-banner';
    if (className) el.classList.add(className);
    el.innerHTML = html || '';
  });
}

function updateCallMatchBanner(p, legalDetails) {
  setCallMatchViews('', '');
  if (!p || !p.hand_in_progress || p.hand_complete || !p.viewer_token_valid) return;
  const seat = Array.isArray(p.seats) ? p.seats[p.viewer_seat] : null;
  if (!seat || seat.folded || seat.all_in) return;
  const legal = Array.isArray(legalDetails) ? legalDetails : [];
  const callDetail = legal.find(a => a.action === 'call');
  const currentBet = Number(seat.current_bet || 0);
  const tableBet = Number(p.current_bet_to_call || 0);
  const rawToCall = Math.max(0, tableBet - currentBet);
  const toCall = callDetail ? Number(callDetail.call_amount || rawToCall) : rawToCall;
  const isMyTurn = p.current_actor_index === p.viewer_seat && legal.length > 0;
  if (toCall > 0) {
    setCallMatchViews(
      `<strong>To call: ${escapeHtml(toCall)} chips</strong><span>${isMyTurn ? 'Pay this to match the current bet.' : 'Needed to match the current bet.'}</span>`,
      'call-due'
    );
  } else {
    setCallMatchViews(`<strong>You are matched</strong><span>0 chips needed to call.</span>`, 'call-clear');
  }
}

function render(p) {
  S.lastState = p;
  if (S.token && !p.viewer_token_valid) {
    rememberRoomToken(S.roomId, '');
    S.token = '';
    save();
    stopPresenceHeartbeat();
  } else if (p.viewer_token_valid) {
    startPresenceHeartbeat(false);
  }
  $('roomTitle').textContent = `${p.room.name} (${p.room.room_id})`;
  $('roomMeta').textContent = `${p.variant_display} · ${p.room.occupied_seats}/${p.room.max_seats} seated · ${p.status_message}`;
  syncInvitePanel(p);
  startTurnCountdown(p);
  if (S.token && !p.viewer_token_valid) {
    rememberRoomToken(p.room.room_id, '');
    S.token = '';
    save();
  }
  const roomChanged = S.lastSoundRoom !== p.room.room_id;
  const firstRender = !S.hasRenderedState || roomChanged;
  if (roomChanged) {
    S.prevCommunity = [];
    S.prevHoles = {};
    S.lastPot = null;
    S.lastTurnKey = '';
    S.lastSoundRoom = p.room.room_id;
    S.lastRevealHandKey = '';
    S.lastRevealCommunityCount = 0;
    S.lastRevealHoleCount = 0;
    S.playedHoleRevealFor = '';
  }
  const sel = $('seatJoinSelect'); sel.innerHTML = '';
  const openSeats = [];
  for (let i=0; i<p.max_seats; i++) {
    if (!p.seats[i]) openSeats.push(i);
  }
  if (!openSeats.includes(S.selectedSeat)) S.selectedSeat = openSeats[0] ?? 0;
  openSeats.forEach(i => { const o=document.createElement('option'); o.value=i; o.textContent=`Seat ${i+1}`; sel.appendChild(o); });
  sel.value = String(S.selectedSeat);
  $('potLabel').textContent = `Pot: ${p.pot}`;
  $('streetLabel').textContent = p.street;
  const prev = S.prevCommunity, nw = p.community_cards;
  const newCommunityCount = firstRender ? 0 : nw.filter((c,i) => c && prev[i] !== c).length;
  $('communityCards').innerHTML = nw.map((c,i) => cardEl(c,i,i>=prev.length||prev[i]!==c)).join('') || '<span class="pill">No board cards yet</span>';
  S.prevCommunity = [...nw];
  $('log').innerHTML = p.log.map(x => `<div class="log-item"><strong>${x.actor}</strong><div class="muted">${x.message}</div></div>`).join('');
  const showdownRows = Array.isArray(p.showdown) ? p.showdown : [];
  const winnerSummary = winnerText(showdownRows);
  renderHandSummary(p, winnerSummary);
  renderGameOver(p);
  stopAutoNextIfNeeded(p);
  $('showdown').innerHTML = showdownRows.length
    ? showdownRows.map(x => `<div class="log-item winner-result"><strong>🏆 ${escapeHtml(x.player_name)}</strong><div class="muted">wins ${escapeHtml(x.amount)}${x.hand?' with '+escapeHtml(x.hand):x.reason==='uncontested'?' uncontested':''}</div>${x.cards?.length ? `<div class="muted">Cards: ${escapeHtml(x.cards.map(pretty).join(' '))}</div>` : ''}</div>`).join('')
    : '<div class="muted">No showdown yet</div>';
  const winnerSeats = new Set(showdownRows.map(x => Number(x.seat_number)).filter(Number.isFinite));
  const tbl = $('table');
  tbl.dataset.maxSeats = String(Number(p.max_seats || p.seats?.length || 0));
  tbl.querySelectorAll('.player').forEach(n => n.remove());
  let newHoleCount = 0;
  p.seats.forEach((seat,i) => {
    const box = document.createElement('div');
    const visualPos = visualSeatPosition(p, i);
    box.className = `player pos-${visualPos} ${p.current_actor_index===i?'active':''} ${winnerSeats.has(i)?'winner':''} ${isBotSeat(seat)?'has-avatar':''}`;
    box.dataset.seat = String(i);
    box.dataset.visualSeat = String(visualPos);
    if (!seat) {
      const sit = S.token ? '' : `<button onclick="quickJoin(${i})">Sit</button>`;
      const bot = p.hand_in_progress && !p.hand_complete ? '' : `<button class="bot-btn" onclick="quickAddAi(${i})">Bot</button>`;
      box.innerHTML = `<div class="seat-empty"><div class="muted">Seat ${i+1}</div>${sit}${bot}</div>`;
    } else {
      const aiLabel = String(seat.ai_level || '').replace('ai_', '');
      const canKick = isRoomCreator(p.room?.room_id || S.roomId) && i !== p.viewer_seat;
      const kickBtn = canKick ? `<div class="seat-actions"><button class="kick-seat" onclick="kickSeat(${i})" title="Remove this player">Kick</button></div>` : '';
      const stackText = `${seat.chip_stack} chips`;
      const statusText = seat.last_action || (p.current_actor_index === i ? 'Your move' : 'Waiting');
      box.innerHTML = `${seatTurnIndicatorMarkup(p, i)}<div class="seat-head">${botAvatarMarkup(seat, i)}<div class="seat-copy">
          <div class="name" title="${escapeHtml(seat.player_name || '')}">${escapeHtml(seat.player_name)}</div>
          <div class="chip-line" title="${escapeHtml(aiLabel)} · ${escapeHtml(stackText)}"><span>${escapeHtml(stackText)}</span><span class="seat-kind">${escapeHtml(aiLabel)}</span></div>
          <div class="last-action" title="${escapeHtml(statusText)}">${escapeHtml(statusText)}</div>
        </div></div>
        <div class="mini-cards">${seat.hole_cards.map((c,j)=>{const k=i+'-'+j,isNew=S.prevHoles[k]!==c;const isViewerHole=i===p.viewer_seat&&c&&c!=='??';if(!firstRender&&isNew&&isViewerHole)newHoleCount+=1;S.prevHoles[k]=c;return miniEl(c,j,isNew);}).join('')}</div>
        ${seat.hand_label?`<div class="pill" style="margin-top:4px;font-size:.75rem">${escapeHtml(seat.hand_label)}</div>`:''}${kickBtn}`;
    }
    tbl.appendChild(box);
  });
  updateSeatTurnIndicator();
  // Card reveal sounds are driven by street/hole-count transitions instead of
  // DOM diffing, so they still play after server payloads, refreshes, and first
  // render of a freshly-started hand.
  updateCardRevealSounds(p);
  const chipSoundIsLocal = performance.now() - S.lastChipSoundAt < 700;
  if (!firstRender && typeof S.lastPot === 'number' && p.hand_in_progress && p.pot > S.lastPot && !chipSoundIsLocal) {
    playSound('bet', .65);
  }
  S.lastPot = p.pot;
  const legalDetails = Array.isArray(p.legal_actions) ? p.legal_actions : [];
  updateCallMatchBanner(p, legalDetails);
  const legal = legalDetails.map(a => a.action);
  S.lastLegalActions = legal;
  $('foldBtn').disabled = !legal.includes('fold');
  $('checkBtn').disabled = !legal.includes('check');
  const callDetail = legalDetails.find(a => a.action === 'call');
  const callAmount = Number(callDetail?.call_amount ?? 0);
  $('callBtn').textContent = callAmount > 0 ? `Call ${callAmount}` : 'Call';
  $('callBtn').disabled = !legal.includes('call');
  const preferredBetAction = legal.includes('raise') ? 'raise' : 'bet';
  $('betBtn').dataset.action = preferredBetAction;
  $('betBtn').textContent = preferredBetAction === 'raise' ? 'Raise' : 'Bet';
  $('betBtn').disabled = !(legal.includes('bet')||legal.includes('raise'));
  updateBetSlider(p, legalDetails);
  $('allInBtn').disabled = !legal.includes('all_in');
  const gameOver = Boolean(p.game_winner);
  const roomCreator = isRoomCreator(p.room?.room_id || S.roomId);
  $('nextHandBtn').disabled = gameOver || !p.hand_complete || (isRealRoomId(p.room?.room_id) && !roomCreator);
  $('startHandBtn').disabled = gameOver || (p.hand_in_progress && !p.hand_complete) || p.room.occupied_seats < 2;
  $('joinSeatBtn').disabled = p.viewer_token_valid || p.room.open_seats <= 0;
  $('leaveSeatBtn').disabled = !p.viewer_token_valid;
  $('resetBtn').disabled = p.room.occupied_seats === 0 || (gameOver && !roomCreator);
  syncBotControls(p);
  const callStatus = p.hand_in_progress && !p.hand_complete && p.viewer_token_valid
    ? (callAmount > 0 ? `Need ${callAmount} to call` : 'You are matched')
    : '';
  $('hintText').textContent = gameOver
    ? `${p.game_winner.player_name} wins the game.`
    : (p.viewer_token_valid
      ? `Seat ${p.viewer_seat+1}${legal.length ? ' · Your turn' : ' · Waiting'}${callStatus ? ' · ' + callStatus : ''}${legal.length ? ' · ' + legal.join(', ') : ''}`
      : 'Join a room to auto-sit.');
  const isMyTurn = p.viewer_token_valid && p.current_actor_index === p.viewer_seat && legal.length > 0;
  const turnKey = `${p.room.room_id}:${p.hand_id}:${p.current_actor_index}:${p.current_bet_to_call}:${p.street}`;
  if (!firstRender && isMyTurn && S.lastTurnKey !== turnKey) {
    S.lastTurnKey = turnKey;
    playSound('turn');
  }
  if (!isMyTurn) S.lastTurnKey = '';
  syncPokerLayout(p);
  S.hasRenderedState = true;
}

window.quickJoin = async i => { S.selectedSeat=i; if ($('seatJoinSelect')) $('seatJoinSelect').value=String(i); await joinSeat(i); };
window.quickAddAi = async i => { S.selectedSeat=i; $('seatJoinSelect').value=String(i); await addAi(); };
window.kickSeat = kickSeat;

async function createRoom() {
  return runMutation(async () => {
    try {
      const p = await api('/api/rooms/create', {method:'POST', body:JSON.stringify({
        name:$('roomName').value,
        variant:$('roomVariant').value,
        max_seats:Number($('roomSeats').value),
        client_id:S.clientId,
        player_name:$('playerName').value||'Player',
        auto_join:true
      })});
      S.roomId=p.room_id;
      S.token=p.token||'';
      rememberRoomToken(p.room_id, S.token);
      startPresenceHeartbeat(true);
      if (p.creator_token) rememberCreatorToken(p.room_id, p.creator_token);
      if (p.warning) showStorageNotice(p.warning, false);
      save();
      await applyServerPayload(p, {rooms:true, fast:7000});
      connectWs(false, 'Room ready. Updates live.');
      playSound('place');
      $('hintText').textContent = p.already_exists ? `You already had room ${p.room_id}, so I brought you back to it.` : `Created ${p.room_id}. Copy the invite link and send it to your friend.`;
      syncInvitePanel(p.state || S.lastState);
    } catch(e) { $('hintText').textContent='Create failed: '+e.message; playSound('error'); }
  });
}
async function deleteRoom(room_id) {
  const ct=S.creatorTokens[room_id];
  if (!ct) { $('hintText').textContent='You are not the creator of that room.'; playSound('error'); return; }
  return runMutation(async () => {
    try {
      const p = await api('/api/rooms/close',{method:'POST',body:JSON.stringify({room_id:room_id,creator_token:ct})});
      rememberCreatorToken(room_id, '');
      rememberRoomToken(room_id, '');
      if (S.roomId===room_id){S.roomId='';S.token='';showNoRoomSelected();}
      save();
      if (Array.isArray(p.rooms)) renderRoomList(p.rooms); else await loadRooms();
      connectWs();
      playSound('fold');
    } catch(e) { $('hintText').textContent='Delete failed: '+e.message; playSound('error'); }
  });
}
async function joinSeat(seatIndex=null) {
  if (S.token) { $('hintText').textContent='Already seated at this table.'; playSound('ui', .45); return; }
  return runMutation(async () => {
    try {
      const body = {room_id:S.roomId,name:$('playerName').value||'Player',ai_level:'human',client_id:S.clientId};
      if (seatIndex != null) body.seat_index = Number(seatIndex);
      const p = await api('/api/join',{method:'POST',body:JSON.stringify(body)});
      S.token=p.token; rememberRoomToken(S.roomId, S.token); save(); sendWsToken(); startPresenceHeartbeat(true);
      await applyServerPayload(p, {rooms:true, fast:7000});
      playSound('place');
      $('hintText').textContent = p.already_seated ? `Reconnected to your seat ${p.seat_index + 1}.` : `Seated at seat ${p.seat_index + 1}.`;
    } catch(e) { $('hintText').textContent='Join failed: '+e.message; playSound('error'); }
  });
}

async function autoJoinRoom(roomId=S.roomId) {
  return runMutation(async () => {
    try {
      switchRoom(roomId, false);
      if (S.token) {
        connectWs(false, 'Opened table.');
        await refreshState(false);
        $('hintText').textContent = `Joined room ${S.roomId}. You are already seated.`;
        playSound('ui', .45);
        return;
      }
      const p = await api('/api/auto_join',{method:'POST',body:JSON.stringify({room_id:S.roomId,name:$('playerName').value||'Player',client_id:S.clientId})});
      S.token=p.token; rememberRoomToken(S.roomId, S.token); save(); sendWsToken(); startPresenceHeartbeat(true);
      await applyServerPayload(p, {rooms:true, fast:7000});
      connectWs(false, 'Joined and seated.');
      playSound('place');
      $('hintText').textContent = p.already_seated ? `Reconnected to your seat ${p.seat_index + 1}.` : `Joined ${S.roomId} and sat at seat ${p.seat_index + 1}.`;
    } catch(e) { $('hintText').textContent='Join room failed: '+e.message; playSound('error'); }
  });
}
async function addAi() {
  return runMutation(async () => {
    try {
      const state = S.lastState;
      let seatIndex = Number($('seatJoinSelect')?.value);
      if (!Number.isFinite(seatIndex) || state?.seats?.[seatIndex]) seatIndex = firstOpenSeatIndex(state);
      if (seatIndex == null) throw new Error('No open seats available.');
      S.selectedSeat = seatIndex;
      if ($('seatJoinSelect')) $('seatJoinSelect').value = String(seatIndex);
      const aiLevel = $('aiKindSelect')?.value || 'ai_easy';
      const p = await api('/api/add_ai',{method:'POST',body:JSON.stringify({room_id:S.roomId,seat_index:seatIndex,ai_level:aiLevel,token:S.token,client_id:S.clientId})});
      await applyServerPayload(p, {rooms:true, fast:6500});
      $('hintText').textContent = `${aiLevelLabel(aiLevel)} added to seat ${seatIndex + 1}.`;
      playSound('place');
    }
    catch(e) { $('hintText').textContent='Add AI failed: '+e.message; playSound('error'); }
  });
}
async function startHand() {
  return runMutation(async () => {
    try {
      prepareHandAdvance();
      const p = await api('/api/start_hand',{method:'POST',body:JSON.stringify({room_id:S.roomId,token:S.token,client_id:S.clientId})});
      await applyServerPayload(p, {fast:9000});
    }
    catch(e) { $('hintText').textContent='Start hand failed: '+e.message; playSound('error'); }
  });
}
async function nextHand() {
  return runMutation(async () => {
    try {
      prepareHandAdvance();
      const p = await api('/api/next_hand',{method:'POST',body:JSON.stringify({room_id:S.roomId,token:S.token,client_id:S.clientId})});
      await applyServerPayload(p, {fast:9000});
    }
    catch(e) { $('hintText').textContent='Next hand failed: '+e.message; playSound('error'); }
  });
}
async function resetTableFromUi() {
  return runMutation(async () => {
    try {
      prepareHandAdvance();
      const p = await api('/api/reset',{method:'POST',body:JSON.stringify({room_id:S.roomId,token:S.token,client_id:S.clientId})});
      await applyServerPayload(p,{fast:6500});
      playSound('allIn', .45);
    } catch(e) { $('hintText').textContent='Reset failed: '+e.message; playSound('error'); }
  });
}
async function closeCurrentLobby() {
  const roomId = S.lastState?.room?.room_id || S.roomId;
  if (!isRoomCreator(roomId)) { $('hintText').textContent = 'Only the host can close this lobby.'; playSound('error'); return; }
  await deleteRoom(roomId);
}
async function sendAction(a) {
  return runMutation(async () => {
    try {
      const body={room_id:S.roomId,token:S.token,client_id:S.clientId,action:a};
      if (a==='bet'||a==='raise') body.amount=Number($('betAmount').value||'0');
      const p = await api('/api/action',{method:'POST',body:JSON.stringify(body)});
      playActionSound(a);
      await applyServerPayload(p, {fast:9000});
    } catch(e) { $('hintText').textContent='Action failed: '+e.message; playSound('error'); }
  });
}
async function betOrRaise() {
  const action = $('betBtn')?.dataset?.action || (S.lastLegalActions.includes('raise') ? 'raise' : 'bet');
  await sendAction(action);
}
async function leaveSeat() {
  if (!S.token) return;
  return runMutation(async () => {
    try {
      const p = await api('/api/leave',{method:'POST',body:JSON.stringify({room_id:S.roomId,token:S.token,client_id:S.clientId})});
      rememberRoomToken(S.roomId, ''); S.token=''; save(); stopPresenceHeartbeat();
      await applyServerPayload(p, {rooms:true, fast:6000});
      connectWs(false, 'Left seat. Watching table.');
      playSound('fold');
    } catch(e) { $('hintText').textContent='Leave failed: '+e.message; playSound('error'); }
  });
}
async function kickSeat(seatIndex) {
  const roomId = S.lastState?.room?.room_id || S.roomId;
  const creatorToken = creatorTokenFor(roomId);
  if (!creatorToken) { $('hintText').textContent = 'Only the room creator can kick players.'; playSound('error'); return; }
  if (!Number.isFinite(Number(seatIndex))) return;
  const seat = Number(seatIndex);
  const target = S.lastState?.seats?.[seat];
  if (!target) { $('hintText').textContent = 'That seat is already empty.'; return; }
  if (!confirm(`Kick ${target.player_name || 'this player'} from seat ${seat + 1}?`)) return;
  return runMutation(async () => {
    try {
      const p = await api('/api/kick', {method:'POST', body:JSON.stringify({
        room_id:roomId,
        seat_index:seat,
        creator_token:creatorToken,
        token:S.token,
        client_id:S.clientId,
      })});
      await applyServerPayload(p, {rooms:true, fast:7000});
      $('hintText').textContent = `${target.player_name || 'Player'} was removed from seat ${seat + 1}.`;
      playSound('fold', .55);
    } catch(e) { $('hintText').textContent='Kick failed: '+e.message; playSound('error'); }
  });
}

async function varianceDemo() {
  const btn=$('varianceBtn'), box=$('varianceBox');
  btn.disabled=true; btn.textContent='Running...';
  box.innerHTML='<div class="muted">Simulating hands...</div>';
  try {
    const a=$('vrAgentA').value, b=$('vrAgentB').value, h=Number($('vrHands').value)||100, v=$('vrVariant').value;
    const q = new URLSearchParams({agent_a:a, agent_b:b, hands:String(h), variant:v});
    const p=await api(`/api/variance/demo?${q.toString()}`);
    const names={ai_easy:'Easy bot',ai_medium:'Medium bot',ai_hard:'Hard bot'};
    const nameA=names[p.agent_a]||p.agent_a, nameB=names[p.agent_b]||p.agent_b;
    function statBlock(d, label) {
      const e=d.mean_edge, se=d.stderr, lo=e-1.96*se, hi=e+1.96*se;
      const color=e>0?'#64d39b':'#ea7d7d';
      return `<div style="margin-bottom:6px"><div style="font-weight:700;font-size:.85rem;margin-bottom:4px">${label}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;font-size:.83rem">
          <span class="muted">${nameA}'s average edge</span><span style="text-align:right;color:${color};font-weight:700">${e>0?'+':''}${e.toFixed(2)}</span>
          <span class="muted">Estimate uncertainty</span><span style="text-align:right">${se.toFixed(3)}</span>
          <span class="muted">Likely true range (95%)</span><span style="text-align:right">[${lo.toFixed(1)}, ${hi.toFixed(1)}]</span>
        </div></div>`;
    }
    const factor = p.variance_reduction_factor;
    const improved = Number.isFinite(factor) && factor > 1;
    const factorLine = improved
      ? `<strong style="color:#64d39b">${factor}×</strong> lower uncertainty with variance reduction`
      : `No lower uncertainty for this selected run`;
    const detailLine = improved
      ? `Same ${p.hands} hands — seat-swap method gives a ${factor}× tighter estimate`
      : `Try a different matchup or more hands if you want a clearer reduction signal`;
    box.innerHTML=`
      <div class="log-item">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px">
          <strong>${nameA}</strong><span class="muted">vs</span><strong>${nameB}</strong>
        </div>
        ${statBlock(p.naive, '① Normal comparison')}
        ${statBlock(p.reduced, '② Same-seed + seat-swap comparison')}
        <div style="background:rgba(100,211,155,.1);border:1px solid rgba(100,211,155,.25);border-radius:8px;padding:8px;margin-top:4px">
          <div style="font-size:.85rem">${factorLine}</div>
          <div class="muted" style="font-size:.8rem;margin-top:2px">${detailLine}</div>
        </div>
      </div>`;
    playSound('turn', .45);
  } catch(e) { box.innerHTML=`<div class="muted">Error: ${e.message}</div>`; playSound('error'); }
  btn.disabled=false; btn.textContent='Run';
}

async function bootPokerApp() {
  checkBackendStorage();
  await loadRooms().catch(() => {});
  const invitedRoom = new URLSearchParams(location.search).get('room');
  if (invitedRoom && isRealRoomId(S.roomId) && !S.token) {
    await autoJoinRoom(S.roomId);
  } else if (isRealRoomId(S.roomId)) {
    connectWs();
  } else {
    showNoRoomSelected();
  }
  startPresenceHeartbeat(Boolean(S.token));
  // Vercel uses HTTP polling, so do not start a separate lobby poller/socket.
  // Rooms are refreshed on entry, manual Refresh, and after create/join/leave.
  if (CONFIG.transport !== 'polling') connectLobbyWs();
}

function hasSavedRejoinCandidate() {
  const invitedRoom = new URLSearchParams(location.search).get('room');
  return !invitedRoom && isRealRoomId(S.roomId) && Boolean(tokenForRoom(S.roomId) || S.token);
}
function openAppAndBoot() {
  $('nameGate').style.display = 'none';
  $('rejoinGate').hidden = true;
  $('appMain').style.display = '';
  // Paint the correct shell (lobby or table) on the first frame instead of
  // briefly showing the bare grid and then snapping into lobby mode once the
  // async room fetch resolves — that snap is what felt janky on load.
  syncPokerLayout(S.lastState);
  bootPokerApp();
}
function showRejoinPrompt() {
  $('nameGate').style.display = 'none';
  $('appMain').style.display = 'none';
  $('rejoinRoomLabel').textContent = S.roomId || 'SAVED TABLE';
  $('rejoinGate').hidden = false;
}
function clearSavedPokerSeat() {
  if (S.roomId) rememberRoomToken(S.roomId, '');
  S.roomId = '';
  S.token = '';
  localStorage.removeItem('poker.roomId');
  localStorage.removeItem('poker.token');
  save();
}
function continueAfterName() {
  if (hasSavedRejoinCandidate()) showRejoinPrompt();
  else openAppAndBoot();
}

setupAudioControls();
// name gate: enable button only when input non-empty
$('gateNameInput').oninput = () => { $('gateBtn').disabled = !$('gateNameInput').value.trim(); };
$('gateNameInput').onkeydown = e => { if (e.key==='Enter' && !$('gateBtn').disabled) $('gateBtn').click(); };
$('gateBtn').onclick = () => {
  unlockAudio();
  const name = $('gateNameInput').value.trim();
  if (!name) return;
  localStorage.setItem('poker.username', name);
  $('playerName').value = name;
  continueAfterName();
};
$('rejoinBtn').onclick = () => { unlockAudio(); openAppAndBoot(); };
$('clearSavedBtn').onclick = () => { unlockAudio(); clearSavedPokerSeat(); openAppAndBoot(); };
// auto-skip gate if name already saved
(function() {
  const saved = localStorage.getItem('poker.username');
  if (saved) {
    $('playerName').value = saved;
    continueAfterName();
  }
})();
$('createRoomBtn').onclick=createRoom; $('refreshRoomsBtn').onclick=loadRooms; $('copyRoomLinkBtn').onclick=()=>copyRoomLink(); $('copyTableBtn').onclick=()=>copyRoomLink(); $('copyInviteHeroBtn').onclick=()=>copyRoomLink();
$('joinSeatBtn').onclick=()=>{ if (isRealRoomId(S.roomId)) autoJoinRoom(S.roomId); else { $('hintText').textContent='Create or pick a room first.'; playSound('error', .45); } }; $('addAiBtn').onclick=addAi;
$('startHandBtn').onclick=startHand; $('nextHandBtn').onclick=nextHand;
$('resetBtn').onclick=resetTableFromUi;
$('restartGameBtn').onclick=resetTableFromUi;
$('closeLobbyBtn').onclick=closeCurrentLobby;
$('leaveSeatBtn').onclick=leaveSeat;
$('foldBtn').onclick=()=>sendAction('fold'); $('checkBtn').onclick=()=>sendAction('check');
$('callBtn').onclick=()=>sendAction('call'); $('betBtn').onclick=betOrRaise;
$('allInBtn').onclick=()=>sendAction('all_in'); $('varianceBtn').onclick=varianceDemo;
$('seatJoinSelect').onchange=()=>{S.selectedSeat=Number($('seatJoinSelect').value);};
$('aiKindSelect').onchange=()=>syncBotControls();
$('betAmount').addEventListener('input', syncBetSliderLabel);
