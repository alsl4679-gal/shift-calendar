import { createClient } from '../vendor/supabase.js';
import { SUPABASE_URL, SUPABASE_KEY, LOGIN_DOMAIN, COMPANY_ANCHOR, DEFAULT_FACTORY } from './config.js';
import * as S from './shift.js';
import { HOLIDAYS } from './holidays.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet-root');
const $toast = document.getElementById('toast-root');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayISO = () => S.toISO(new Date());
const nowYM = () => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; };
const BANS = ['가열', '압연', '냉각', '시험'];
const VAC_TYPES = ['연차', '병가', '경조', '공가', '기타'];

const state = {
  user: null, me: null, team: null, isOperator: false, members: [], memberMap: new Map(), joHist: new Map(), customTypes: new Map(),
  tab: 'mine', ym: nowYM(), infoYm: nowYM(),
  overrides: new Map(), requests: [], upcoming: [], volunteers: new Map(), notes: new Map(),
  yearOverrides: null, channel: null, openSheet: null, installPrompt: null,
};

const okey = (uid, iso) => `${uid}|${iso}`;
const memberName = (uid) => state.memberMap.get(uid)?.display_name ?? '(나간 사람)';
const isAdmin = () => state.me?.role === 'admin';
const joAt = (uid, iso) => S.joOn(state.joHist.get(uid), iso);
const curJo = (member) => (member ? joAt(member.user_id, todayISO()) : null);
const joLabel = (jo) => (jo ? `${jo}조` : '조 미설정');
const activeMembers = () => state.members.filter((m) => m.status !== 'pending');
const pendingMembers = () => state.members.filter((m) => m.status === 'pending');
/** 칸 머리: 날짜(왼쪽) + 공휴일 이름(오른쪽) */
function cellHead(iso, dow) {
  const h = HOLIDAYS[iso];
  return `<span class="cell-head"><span class="dnum ${h || dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}">${+iso.slice(8)}</span>${
    h ? `<span class="hname">${h}</span>` : ''}</span>`;
}
const holidayTag = (iso) => (HOLIDAYS[iso] ? ` <span class="holiday-tag">${HOLIDAYS[iso]}</span>` : '');
function shiftOf(member, iso) {
  const jo = joAt(member.user_id, iso);
  return { ...S.effectiveShift(state.team, jo, iso, state.overrides.get(okey(member.user_id, iso))), jo };
}

// ---------- 공통 UI ----------
const ICONS = {
  cal: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  team: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.2c3 .2 5.5 2.6 5.5 5.8"/></svg>',
  me: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
};

let toastTimer = null;
function toast(msg, action = null, ms = 4000) {
  clearTimeout(toastTimer);
  $toast.innerHTML = `<div class="toast" role="status"><span>${esc(msg)}</span>${
    action ? `<button class="toast-btn">${esc(action.label)}</button>` : ''}</div>`;
  if (action) $toast.querySelector('.toast-btn').onclick = () => { $toast.innerHTML = ''; action.fn(); };
  toastTimer = setTimeout(() => { $toast.innerHTML = ''; }, ms);
}
function toastErr(e) {
  console.error(e);
  toast(translateErr(e?.message || String(e)), null, 5000);
}
function translateErr(m) {
  const map = [
    [/Invalid login credentials/i, '직번 또는 비밀번호가 틀렸습니다'],
    [/User already registered|already been registered/i, '이미 가입된 직번입니다. 로그인해 주세요'],
    [/Password should be at least/i, '비밀번호는 6자 이상이어야 합니다'],
    [/Email not confirmed/i, '이메일 인증이 아직 안 됐습니다. 메일함을 확인해 주세요'],
    [/rate limit|too many/i, '요청이 많습니다. 잠시 후 다시 시도해 주세요'],
    [/Failed to fetch|NetworkError|Load failed/i, '인터넷 연결을 확인해 주세요'],
    [/valid email/i, '이메일 형식을 확인해 주세요'],
  ];
  for (const [re, t] of map) if (re.test(m)) return t;
  return m;
}

function confirmModal(text, okLabel = '확인') {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-back';
    wrap.innerHTML = `<div class="modal"><p>${esc(text)}</p><div class="row-btns">
      <button class="btn ghost" data-r="0">취소</button><button class="btn primary" data-r="1">${esc(okLabel)}</button></div></div>`;
    wrap.onclick = (e) => {
      const r = e.target.closest('[data-r]');
      if (r || e.target === wrap) { wrap.remove(); resolve(r?.dataset.r === '1'); }
    };
    document.body.appendChild(wrap);
  });
}

function openSheet(html, meta) {
  state.openSheet = meta;
  $sheet.innerHTML = `<div class="sheet-back"></div><div class="sheet" role="dialog"><div class="grab"></div>${html}</div>`;
  $sheet.querySelector('.sheet-back').onclick = closeSheet;
  requestAnimationFrame(() => $sheet.classList.add('open'));
  return $sheet.querySelector('.sheet');
}
function closeSheet() {
  state.openSheet = null;
  $sheet.classList.remove('open');
  $sheet.innerHTML = '';
}

function busy(on) {
  document.body.classList.toggle('busy', on);
}
async function withBusy(fn) {
  busy(true);
  try { return await fn(); } finally { busy(false); }
}

function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? '#2d2d2d' : '#ffffff';
}
function shiftBadge(shift, isCover = false, extra = '', custom = null) {
  if (custom) return `<span class="badge ${extra}" style="background:${custom.color};color:${textOn(custom.color)}">${esc(custom.name)}</span>`;
  if (!shift) return `<span class="badge s-O ${extra}">-</span>`;
  const info = S.SHIFT_INFO[shift];
  return `<span class="badge s-${shift}${isCover ? ' cover' : ''} ${extra}">${isCover ? '대근' : info.short}</span>`;
}
const baseLabel = (b) => (b === 'AUTO' ? '자동 (앞뒤 근무)' : S.SHIFT_INFO[b].label);
const baseShort = (b) => (b === 'AUTO' ? '자동' : S.SHIFT_INFO[b].short);
/** 내 달력용: 그날 내 커스텀 타입 (팀 달력에는 쓰지 않음) */
function myCustom(iso) {
  const ov = state.overrides.get(okey(state.user.id, iso));
  return ov?.custom_type_id ? state.customTypes.get(ov.custom_type_id) || null : null;
}
function monthNav(ym, action) {
  return `<div class="month-nav">
    <button class="icon-btn" data-action="${action}" data-d="-1" aria-label="이전 달">${ICONS.prev}</button>
    <h2>${ym.y}년 ${ym.m + 1}월</h2>
    <button class="icon-btn" data-action="${action}" data-d="1" aria-label="다음 달">${ICONS.next}</button>
    <button class="chip-btn" data-action="${action}" data-d="0">오늘</button>
  </div>`;
}
const WEEK_HEAD = '<div class="week-head">' + ['일', '월', '화', '수', '목', '금', '토']
  .map((d, i) => `<span class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${d}</span>`).join('') + '</div>';

// ---------- 시작 ----------
async function boot() {
  registerSW();
  try { navigator.storage?.persist?.(); } catch { /* 지원 안 하면 무시 */ }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.team) return;
    if (state.me?.status === 'pending') afterLogin().catch(() => {});
    else refresh({ team: true, quiet: true });
  });
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') { teardown(); state.user = null; renderAuth(); }
  });
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return renderAuth();
    state.user = session.user;
    await afterLogin();
  } catch (e) {
    renderFatal(e);
  }
}

async function afterLogin() {
  const { data: me, error } = await sb.from('members').select('*').eq('user_id', state.user.id).maybeSingle();
  if (error) throw error;
  if (!me) return renderOnboarding();
  state.me = me;
  try { const op = await sb.rpc('is_operator'); state.isOperator = !!op.data; } catch { state.isOperator = false; }
  await loadTeam();
  if (!state.me) return renderOnboarding();
  if (state.me.status === 'pending') return renderPending();
  if (!curJo(state.me)) return renderJoSetup();
  await loadMonth();
  subscribe();
  renderApp();
}

function teardown() {
  if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
  Object.assign(state, { me: null, team: null, members: [], memberMap: new Map(), joHist: new Map(), yearOverrides: null });
  closeSheet();
}

function renderFatal(e) {
  console.error(e);
  $app.innerHTML = `<div class="center-screen"><h1>불러오지 못했어요</h1>
    <p class="muted">${esc(translateErr(e?.message || String(e)))}</p>
    <button class="btn primary" onclick="location.reload()">다시 시도</button></div>`;
}

// ---------- 데이터 ----------
async function loadTeam() {
  const [t, ms, jh, ct] = await Promise.all([
    sb.from('teams').select('*').eq('id', state.me.team_id).maybeSingle(),
    sb.from('members').select('*').eq('team_id', state.me.team_id).order('display_name'),
    sb.from('member_jo_history').select('user_id,jo,effective_from').eq('team_id', state.me.team_id).order('effective_from'),
    sb.from('custom_types').select('*').eq('user_id', state.user.id).order('sort').order('created_at'),
  ]);
  for (const r of [t, ms, jh, ct]) if (r.error) throw r.error;
  state.customTypes = new Map(ct.data.map((c) => [c.id, c]));
  state.joHist = new Map();
  for (const h of jh.data) {
    if (!state.joHist.has(h.user_id)) state.joHist.set(h.user_id, []);
    state.joHist.get(h.user_id).push(h);
  }
  state.team = t.data;
  state.members = ms.data;
  state.memberMap = new Map(ms.data.map((m) => [m.user_id, m]));
  state.me = state.memberMap.get(state.user.id) || null;
}

async function loadMonth() {
  const { y, m } = state.ym;
  const { start, end } = S.monthRange(y, m);
  const from = S.addDays(start, -1);
  const to = S.addDays(end, 1);
  const tid = state.team.id;
  const wd = S.workDateNow();
  const [ov, mine, rq, nt, up] = await Promise.all([
    sb.from('day_overrides').select('*').eq('team_id', tid).gte('work_date', from).lte('work_date', to),
    sb.from('day_overrides').select('*').eq('user_id', state.user.id).gte('work_date', wd).lte('work_date', S.addDays(wd, 1)),
    sb.from('cover_requests').select('*').eq('team_id', tid).neq('status', 'cancelled')
      .gte('work_date', from).lte('work_date', to),
    sb.from('personal_notes').select('*').eq('user_id', state.user.id).gte('work_date', from).lte('work_date', to),
    sb.from('cover_requests').select('*').eq('team_id', tid).eq('status', 'open')
      .gte('work_date', todayISO()).order('work_date').limit(30),
  ]);
  for (const r of [ov, mine, rq, nt, up]) if (r.error) throw r.error;
  state.overrides = new Map([...ov.data, ...mine.data].map((o) => [okey(o.user_id, o.work_date), o]));
  state.requests = rq.data;
  state.upcoming = up.data;
  state.notes = new Map(nt.data.map((n) => [n.work_date, n]));
  const ids = [...new Set([...rq.data, ...up.data].map((r) => r.id))];
  state.volunteers = new Map();
  if (ids.length) {
    const { data, error } = await sb.from('cover_volunteers').select('*').in('request_id', ids);
    if (error) throw error;
    for (const v of data) {
      if (!state.volunteers.has(v.request_id)) state.volunteers.set(v.request_id, []);
      state.volunteers.get(v.request_id).push(v);
    }
  }
}

async function loadYear(y) {
  const { data, error } = await sb.from('day_overrides').select('work_date,shift,is_cover')
    .eq('user_id', state.user.id).gte('work_date', `${y}-01-01`).lte('work_date', `${y}-12-31`);
  if (error) throw error;
  state.yearOverrides = { year: y, map: Object.fromEntries(data.map((o) => [o.work_date, o])) };
}

async function refresh({ team = false, quiet = false } = {}) {
  try {
    if (team) await loadTeam();
    if (!state.me) {
      teardown();
      toast('팀에서 나와졌습니다');
      return renderOnboarding();
    }
    if (state.me.status === 'pending') { teardown(); return afterLogin(); }
    if (!curJo(state.me)) return renderJoSetup();
    await loadMonth();
    state.yearOverrides = null;
    renderApp();
    if (state.openSheet?.type === 'team') openTeamSheet(state.openSheet.iso);
  } catch (e) {
    if (!quiet) toastErr(e);
  }
}

// ---------- 실시간 ----------
let rtTimer = null;
let rtMembers = false;
let rtToasts = [];
let rtPending = null;
function subscribe() {
  if (state.channel) sb.removeChannel(state.channel);
  const ch = sb.channel(`team-${state.team.id}`);
  for (const table of ['day_overrides', 'cover_requests', 'cover_volunteers', 'members', 'member_jo_history']) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table }, onRealtime);
  }
  ch.subscribe();
  state.channel = ch;
}
function onRealtime(p) {
  if (p.table === 'members' || p.table === 'member_jo_history') rtMembers = true;
  if (p.table === 'members' && p.eventType === 'INSERT' && p.new?.status === 'pending' && isAdmin()) rtPending = p.new;
  const n = p.new;
  if (p.table === 'cover_requests' && n && n.team_id === state.team?.id && n.status === 'open'
      && n.requester_id !== state.user.id
      && (p.eventType === 'INSERT' || (p.eventType === 'UPDATE' && n.created_at === n.updated_at))) {
    rtToasts.push(n);
  }
  clearTimeout(rtTimer);
  rtTimer = setTimeout(async () => {
    const team = rtMembers; rtMembers = false;
    const toasts = rtToasts; rtToasts = [];
    await refresh({ team, quiet: true });
    if (rtPending) {
      const pm = rtPending; rtPending = null;
      toast(`${pm.display_name}님이 가입 승인을 기다려요`, { label: '보기', fn: () => { state.tab = 'info'; closeSheet(); renderApp(); } }, 8000);
      return;
    }
    const r = toasts[toasts.length - 1];
    if (r) {
      toast(`${memberName(r.requester_id)}님 ${S.formatDay(r.work_date)} ${S.SHIFT_INFO[r.shift].label} 휴가 — 대근 필요`,
        { label: '보기', fn: () => goTeamDay(r.work_date) }, 7000);
    }
  }, 400);
}

async function goTeamDay(iso) {
  const d = S.fromISO(iso);
  state.tab = 'team';
  if (d.getFullYear() !== state.ym.y || d.getMonth() !== state.ym.m) {
    state.ym = { y: d.getFullYear(), m: d.getMonth() };
    await withBusy(loadMonth).catch(toastErr);
  }
  renderApp();
  openTeamSheet(iso);
}

// ---------- 로그인 · 가입 (직번 + 비밀번호) ----------
function posOptions(selected = 0) {
  return S.POS_LABELS.map((l, i) => `<option value="${i}" ${i === selected ? 'selected' : ''}>${l}</option>`).join('');
}
const EMP_RE = /^[A-Za-z0-9]{3,20}$/;
const empEmail = (emp) => `${emp.trim().toLowerCase()}@${LOGIN_DOMAIN}`;
const empOf = (user) => (user?.email || '').split('@')[0];

function previewFor(team) {
  const t = todayISO();
  const duty = S.josOnDuty(team, t);
  return `오늘(${S.formatDay(t)}) 주간 <b>${duty.D.join('')}조</b> · 야간 <b>${duty.N.join('')}조</b>`;
}
function joSelect(name, selected = 'A') {
  return `<div class="jo-pick">${S.JOS.map((j) => `<label><input type="radio" name="${name}" value="${j}" ${j === selected ? 'checked' : ''}><span>${j}조</span></label>`).join('')}</div>`;
}
function banField(value = '') {
  const isCustom = value && !BANS.includes(value);
  return `<label>반<select name="ban">${BANS.map((b) => `<option ${b === value ? 'selected' : ''}>${b}</option>`).join('')}
      <option value="__custom" ${isCustom ? 'selected' : ''}>직접 입력</option></select></label>
    <label class="ban-custom ${isCustom ? '' : 'hidden'}">반 이름<input name="ban_custom" maxlength="20" value="${isCustom ? esc(value) : ''}"></label>`;
}
function wireBanField(root) {
  const sel = root.querySelector('select[name=ban]');
  sel.onchange = () => root.querySelector('.ban-custom').classList.toggle('hidden', sel.value !== '__custom');
}
const banValue = (f) => (f.get('ban') === '__custom' ? (f.get('ban_custom') || '').trim() : f.get('ban'));

const empFields = `
  <label>직번<input name="emp" maxlength="20" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="사번(직번)" required></label>`;
const pwFields = `
  <label>비밀번호 <small class="muted">6자 이상</small><input name="password" type="password" minlength="6" autocomplete="new-password" required></label>
  <label>비밀번호 확인<input name="password2" type="password" minlength="6" autocomplete="new-password" required></label>`;
const teamFields = (factory = DEFAULT_FACTORY, ban = '압연') => `
  <label>공장<input name="factory" maxlength="40" value="${esc(factory)}" required></label>
  ${banField(ban)}`;

function authShell(inner, small = false) {
  return `<div class="auth">
    <div class="brand ${small ? 'small' : ''}"><img src="icons/icon-192.png" alt=""><h1>교대달력</h1>
      <p class="muted">광고 없는 우리 반 교대 근무표</p></div>${inner}</div>`;
}

/** 새 계정 만들기 (직번 → 내부 주소) */
async function signUpEmp(f) {
  const emp = (f.get('emp') || '').trim();
  if (!EMP_RE.test(emp)) throw new Error('직번은 영문·숫자 3~20자로 입력해 주세요');
  if (f.get('password') !== f.get('password2')) throw new Error('비밀번호가 서로 다릅니다');
  const { data, error } = await sb.auth.signUp({
    email: empEmail(emp), password: f.get('password'),
    options: { data: { emp_no: emp, display_name: (f.get('name') || '').trim() } },
  });
  if (error) throw error;
  try { localStorage.setItem('lastEmp', emp); } catch { /* 무시 */ }
  if (!data.session) throw new Error('가입은 됐지만 로그인되지 않았습니다. 관리자에게 Supabase 이메일 인증 설정을 확인해 달라고 해 주세요');
  state.user = data.user;
}

function renderAuth(mode = 'login', ctx = {}) {
  if (mode === 'login') {
    $app.innerHTML = authShell(`
      <form id="f" class="card form">
        ${empFields}
        <label>비밀번호<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary block">로그인</button>
      </form>
      <button class="btn ghost block" data-go="join">처음이에요 · 초대 코드로 가입</button>
      <p class="muted center small-note">비밀번호를 잊으면 팀 관리자에게 문의하세요.</p>`);
  } else if (mode === 'join') {
    $app.innerHTML = authShell(`
      <h3 class="step">1/2 · 초대 코드 확인</h3>
      <form id="f" class="card form">
        <label>초대 코드 <small class="muted">팀 관리자에게 받은 6자리</small>
          <input name="code" maxlength="6" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="예: YX2LFP" value="${esc(ctx.code || '')}" required></label>
        <button class="btn primary block">다음</button>
      </form>
      <button class="link-btn" data-go="login">← 로그인으로</button>`, true);
  } else if (mode === 'join2') {
    $app.innerHTML = authShell(`
      <h3 class="step">2/2 · 내 정보</h3>
      <div class="team-badge">${esc(ctx.team.factory)} · ${esc(ctx.team.ban)}반${ctx.team.kind === 'admin' ? ' · 관리자' : ''}</div>
      ${ctx.team.kind === 'admin' ? '<p class="note">관리자 초대 코드예요. 가입하면 승인 없이 바로 이 반의 관리자가 됩니다. (1회용)</p>' : ''}
      <form id="f" class="card form">
        ${empFields}
        <label>이름 <small class="muted">팀원에게 보이는 이름</small><input name="name" maxlength="20" required></label>
        ${pwFields}
        <p class="note">조는 가입 후 앱 안에서 설정해요. 인사이동 때도 언제든 바꿀 수 있습니다.</p>
        <button class="btn primary block">가입하기</button>
      </form>
      <button class="link-btn" data-go="join">← 초대 코드 다시 입력</button>`, true);
  } else if (mode === 'create') {
    $app.innerHTML = authShell(`
      <h3 class="step">새 팀 만들기</h3>
      <p class="note">팀을 만든 사람이 관리자가 되고, 초대 코드를 받아 동료들에게 나눠 줍니다. 한 반에 한 번만 만들면 돼요. 나중에 관리자를 주임에게 넘길 수 있어요.</p>
      <form id="f" class="card form">
        <label>팀 개설 코드 <small class="muted">앱 관리자에게 받은 코드</small>
          <input name="ccode" maxlength="12" autocapitalize="characters" autocomplete="off" spellcheck="false" required></label>
        ${teamFields()}
        ${empFields}
        <label>이름<input name="name" maxlength="20" required></label>
        ${pwFields}
        <p class="note">근무 기준: ${previewFor(COMPANY_ANCHOR)} (회사 공통)</p>
        <button class="btn primary block">팀 만들고 가입하기</button>
      </form>
      <button class="link-btn" data-go="login">← 로그인으로</button>`, true);
    wireBanField($app.querySelector('#f'));
  }
  $app.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => renderAuth(b.dataset.go, ctx); });
  if (mode === 'login') { try { const last = localStorage.getItem('lastEmp'); if (last) $app.querySelector('input[name=emp]').value = last; } catch { /* 무시 */ } }

  const form = $app.querySelector('#f');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    await withBusy(async () => {
      try {
        if (mode === 'login') {
          const emp = (f.get('emp') || '').trim();
          const { data, error } = await sb.auth.signInWithPassword({ email: empEmail(emp), password: f.get('password') });
          if (error) throw error;
          try { localStorage.setItem('lastEmp', emp); } catch { /* 무시 */ }
          state.user = data.user;
          await afterLogin();
        } else if (mode === 'join') {
          const code = (f.get('code') || '').trim().toUpperCase();
          const { data, error } = await sb.rpc('check_invite_code', { p_code: code });
          if (error) throw error;
          if (!data) return toast('초대 코드를 찾을 수 없습니다. 다시 확인해 주세요');
          renderAuth('join2', { code, team: data });
        } else if (mode === 'join2') {
          await signUpEmp(f);
          const { error } = await sb.rpc('join_team', { p_code: ctx.code, p_display_name: f.get('name'), p_jo: null });
          if (error) throw error;
          await afterLogin();
          toast(ctx.team.kind === 'admin' ? '관리자로 가입했어요' : '가입 신청을 보냈어요. 관리자 승인을 기다려 주세요', null, 6000);
        } else if (mode === 'create') {
          const ban = banValue(f);
          if (!ban) return toast('반 이름을 입력해 주세요');
          const ok = await sb.rpc('check_create_code', { p_code: f.get('ccode') });
          if (ok.error) throw ok.error;
          if (!ok.data) return toast('팀 개설 코드가 맞지 않습니다');
          await signUpEmp(f);
          const { error } = await sb.rpc('create_team', {
            p_factory: f.get('factory'), p_ban: ban, p_display_name: f.get('name'), p_jo: null,
            p_anchor: COMPANY_ANCHOR.anchor_date, p_a_pos: COMPANY_ANCHOR.a_pos, p_create_code: f.get('ccode'),
          });
          if (error) throw error;
          await afterLogin();
          toast('팀을 만들었어요. 내 정보 탭에서 초대 코드를 공유하세요', null, 6000);
        }
      } catch (err) {
        toastErr(err);
        // 가입은 됐는데 팀 참여에서 실패한 경우 → 로그인 상태이므로 팀 설정 화면으로
        if (state.user && (mode === 'join2' || mode === 'create')) {
          try { await afterLogin(); } catch { /* 화면 유지 */ }
        }
      }
    });
  };
}

// ---------- 승인 대기 ----------
function renderPending() {
  $app.innerHTML = authShell(`
    <h3 class="step">가입 승인 대기 중</h3>
    <div class="team-badge">${esc(state.team?.factory_name || '')} · ${esc(state.team?.ban_name || '')}반</div>
    <div class="card form">
      <p>관리자(주임)가 승인하면 바로 쓸 수 있어요.<br><span class="muted">직번 ${esc(empOf(state.user))} · ${esc(state.me.display_name)}</span></p>
      <button class="btn primary block" data-recheck>승인됐는지 다시 확인</button>
    </div>
    <button class="link-btn" data-cancel>가입 신청 취소</button>
    <button class="link-btn" data-action="logout">로그아웃</button>`, true);
  $app.querySelector('[data-action=logout]').onclick = () => sb.auth.signOut();
  $app.querySelector('[data-recheck]').onclick = () => withBusy(async () => {
    try {
      await afterLogin();
      if (state.me?.status === 'pending') toast('아직 승인 전이에요');
    } catch (e) { toastErr(e); }
  });
  $app.querySelector('[data-cancel]').onclick = async () => {
    if (!(await confirmModal('가입 신청을 취소할까요?', '취소하기'))) return;
    await withBusy(async () => {
      try {
        const { error } = await sb.rpc('leave_team');
        if (error) throw error;
        teardown(); renderOnboarding(); toast('가입 신청을 취소했어요');
      } catch (e) { toastErr(e); }
    });
  };
}

// ---------- 조 첫 설정 ----------
function renderJoSetup() {
  const t = todayISO();
  $app.innerHTML = authShell(`
    <h3 class="step">내 조 설정</h3>
    <div class="team-badge">${esc(state.team.factory_name)} · ${esc(state.team.ban_name)}반</div>
    <form id="f" class="card form">
      <div class="field"><span class="field-label">지금 내 조</span>${joSelect('jo', '')}</div>
      <p class="note">${previewFor(state.team)}<br>인사이동이 생기면 <b>내 정보 → 조 변경</b>에서 "언제부터"와 함께 바꾸면 돼요. 이전 근무 기록은 그대로 남습니다.</p>
      <button class="btn primary block">시작하기</button>
    </form>
    <button class="link-btn" data-action="logout">로그아웃</button>`, true);
  $app.querySelector('[data-action=logout]').onclick = () => sb.auth.signOut();
  const form = $app.querySelector('#f');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const jo = new FormData(form).get('jo');
    if (!jo) return toast('조를 선택해 주세요');
    await withBusy(async () => {
      try {
        const { error } = await sb.rpc('set_member_jo', { p_user: null, p_jo: jo, p_from: t });
        if (error) throw error;
        await afterLogin();
        toast(`${jo}조로 설정했어요`);
      } catch (err) { toastErr(err); }
    });
  };
}

// ---------- 로그인은 됐는데 팀이 없을 때 (팀을 나갔거나 가입 도중 끊긴 경우) ----------
function renderOnboarding(mode = 'join') {
  const meta = state.user?.user_metadata || {};
  $app.innerHTML = `<div class="auth">
    <div class="brand small"><h1>팀 설정</h1><p class="muted">직번 ${esc(empOf(state.user))} · 아직 소속된 팀이 없어요</p></div>
    <div class="seg">
      <button class="${mode === 'join' ? 'on' : ''}" data-mode="join">초대 코드로 참여</button>
    </div>
    <form id="ob-form" class="card form">
      ${mode === 'join' ? `<label>초대 코드<input name="code" maxlength="6" autocapitalize="characters" placeholder="예: YX2LFP" required></label>` : `<label>팀 개설 코드 <small class="muted">앱 관리자에게 받은 코드</small>
          <input name="ccode" maxlength="12" autocapitalize="characters" autocomplete="off" spellcheck="false" required></label>${teamFields()}`}
      <label>이름 (팀에 보이는 이름)<input name="name" maxlength="20" value="${esc(meta.display_name || '')}" required></label>
      ${mode === 'create' ? `<p class="note">근무 기준: ${previewFor(COMPANY_ANCHOR)} (회사 공통)</p>` : ''}
      <button class="btn primary block">${mode === 'join' ? '참여하기' : '팀 만들기'}</button>
    </form>
    <button class="link-btn" data-action="logout">로그아웃</button>
  </div>`;
  $app.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => renderOnboarding(b.dataset.mode); });
  $app.querySelector('[data-action=logout]').onclick = () => sb.auth.signOut();
  const form = $app.querySelector('#ob-form');
  if (mode === 'create') wireBanField(form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    await withBusy(async () => {
      try {
        if (mode === 'join') {
          const { error } = await sb.rpc('join_team', { p_code: f.get('code'), p_display_name: f.get('name'), p_jo: null });
          if (error) throw error;
        } else {
          const ban = banValue(f);
          if (!ban) return toast('반 이름을 입력해 주세요');
          const { error } = await sb.rpc('create_team', {
            p_factory: f.get('factory'), p_ban: ban, p_display_name: f.get('name'), p_jo: null,
            p_anchor: COMPANY_ANCHOR.anchor_date, p_a_pos: COMPANY_ANCHOR.a_pos, p_create_code: f.get('ccode'),
          });
          if (error) throw error;
        }
        await afterLogin();
        toast(mode === 'join' ? '가입 신청을 보냈어요. 관리자 승인을 기다려 주세요' : '팀을 만들었어요. 내 정보 탭에서 초대 코드를 공유하세요');
      } catch (err) { toastErr(err); }
    });
  };
}

// ---------- 앱 화면 ----------
function renderApp() {
  if (!state.team || !state.me) return;
  const openCount = state.upcoming.length;
  const body = state.tab === 'mine' ? viewMine() : state.tab === 'team' ? viewTeam() : viewInfoShell();
  $app.innerHTML = `<main class="view">${body}</main>
    <nav class="tabbar">
      <button class="${state.tab === 'mine' ? 'on' : ''}" data-tab="mine">${ICONS.cal}<span>내 달력</span></button>
      <button class="${state.tab === 'team' ? 'on' : ''}" data-tab="team">${ICONS.team}<span>팀 달력</span>
        ${openCount ? `<i class="dot-count">${openCount}</i>` : ''}</button>
      <button class="${state.tab === 'info' ? 'on' : ''}" data-tab="info">${ICONS.me}<span>내 정보</span>
        ${isAdmin() && pendingMembers().length ? `<i class="dot-count">${pendingMembers().length}</i>` : ''}</button>
    </nav>`;
  if (state.tab === 'info') fillInfo();
}

$app.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) {
    state.tab = tabBtn.dataset.tab;
    closeSheet();
    renderApp();
    window.scrollTo(0, 0);
    return;
  }
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const act = a.dataset.action;
  if (act === 'month' || act === 'info-month') {
    const key = act === 'month' ? 'ym' : 'infoYm';
    const d = +a.dataset.d;
    if (d === 0) state[key] = nowYM();
    else {
      const dt = new Date(state[key].y, state[key].m + d, 1);
      state[key] = { y: dt.getFullYear(), m: dt.getMonth() };
    }
    if (act === 'month') await withBusy(loadMonth).catch(toastErr);
    renderApp();
  } else if (act === 'mine-day') openMineSheet(a.dataset.iso);
  else if (act === 'team-day') openTeamSheet(a.dataset.iso);
  else if (act === 'goto-req') goTeamDay(a.dataset.iso);
  else if (act === 'copy-code') shareCode();
  else if (act === 'edit-profile') openProfileSheet();
  else if (act === 'change-jo') openJoSheet(a.dataset.uid);
  else if (act === 'custom-types') openCustomTypesSheet(null);
  else if (act === 'operator') openOperatorSheet();
  else if (act === 'approve' || act === 'reject') {
    const mm = state.memberMap.get(a.dataset.uid);
    if (act === 'reject' && !(await confirmModal(`${mm?.display_name}님의 가입 신청을 거절할까요?`, '거절'))) return;
    await withBusy(async () => {
      try {
        const { error } = act === 'approve'
          ? await sb.rpc('approve_member', { p_user: a.dataset.uid })
          : await sb.rpc('remove_member', { p_user: a.dataset.uid });
        if (error) throw error;
        await refresh({ team: true });
        toast(act === 'approve' ? `${mm?.display_name}님을 승인했어요` : '거절했어요');
      } catch (e) { toastErr(e); }
    });
  }
  else if (act === 'team-settings') openTeamSettingsSheet();
  else if (act === 'member') openMemberSheet(a.dataset.uid);
  else if (act === 'install') installApp();
  else if (act === 'logout') { if (await confirmModal('로그아웃할까요?', '로그아웃')) sb.auth.signOut(); }
  else if (act === 'leave') leaveTeam();
});

// ---------- 탭 1: 내 달력 ----------
function viewMine() {
  const { y, m } = state.ym;
  const wd = S.workDateNow();
  const t0 = shiftOf(state.me, wd);
  const t1 = shiftOf(state.me, S.addDays(wd, 1));
  const today = todayISO();
  const cells = S.monthGrid(y, m).map((iso) => {
    if (!iso) return '<span class="cell empty"></span>';
    const s = shiftOf(state.me, iso);
    const note = state.notes.get(iso);
    const dow = S.fromISO(iso).getDay();
    return `<button class="cell ${iso === today ? 'today' : ''} ${s.changed ? 'changed' : ''}" data-action="mine-day" data-iso="${iso}">
      ${cellHead(iso, dow)}
      ${shiftBadge(s.shift, s.isCover, '', myCustom(iso))}
      ${note?.memo ? `<span class="memo-bar">${esc(note.memo.split('\n')[0])}</span>` : ''}
    </button>`;
  }).join('');
  const card = (label, s, iso) => `<div class="today-item">
      <span class="muted">${label}</span>${shiftBadge(s.shift, s.isCover, 'lg', myCustom(iso))}
      <span class="t-time">${s.shift ? (S.SHIFT_INFO[s.shift].time || (S.ABSENCE.has(s.shift) ? S.SHIFT_INFO[s.shift].label : '쉬는 날')) : ''}</span></div>`;
  return `<header class="top"><div><h1>${esc(state.me.display_name)} <small>${joLabel(curJo(state.me))}</small></h1>
      <p class="muted">${esc(state.team.factory_name)} · ${esc(state.team.ban_name)}반</p></div></header>
    <section class="today-card">${card(`오늘 ${S.formatDay(wd)}`, t0, wd)}${card('내일', t1, S.addDays(wd, 1))}</section>
    ${monthNav(state.ym, 'month')}
    ${WEEK_HEAD}
    <div class="grid mine rows-${S.monthGrid(y, m).length / 7}">${cells}</div>`;
}

function openMineSheet(iso) {
  const me = state.me;
  const ov = state.overrides.get(okey(me.user_id, iso));
  const jo = joAt(me.user_id, iso);
  const base = S.baseShift(state.team, jo, iso);
  const cur = { shift: ov ? ov.shift : base, custom: ov?.custom_type_id || null };
  const note = state.notes.get(iso) || null;
  let sel = { ...cur };
  let vtype = note?.vacation_type || '';
  let memoCache = null;

  const draw = () => {
    const customs = [...state.customTypes.values()];
    const selCustom = sel.custom ? state.customTypes.get(sel.custom) : null;
    const isBase = sel.shift === base && !sel.custom;
    const needsCover = S.ABSENCE.has(sel.shift) && (base === 'D' || base === 'N');
    const noteText = (selCustom
      ? `"${esc(selCustom.name)}"은 내 달력에만 보이고, 팀 달력에는 "${S.SHIFT_INFO[sel.shift].label}"(으)로 표시돼요.`
      : '근무 변경은 팀 달력에 바로 공유됩니다.')
      + (needsCover ? ' 저장하면 팀에 "대근 필요"가 올라가요.' : '');
    const sh = openSheet(`
      <h3>${S.formatDay(iso)}${holidayTag(iso)}</h3>
      <p class="muted">${jo}조 · 원래 근무: ${S.SHIFT_INFO[base].label}${ov ? ` → 지금: ${ov.is_cover ? '대근 ' : ''}${S.SHIFT_INFO[ov.shift].label}` : ''}</p>
      ${ov?.is_cover ? '<p class="note warn">대근이 확정된 날이에요. 근무를 바꾸면 대근이 취소되고 다시 "대근 필요"로 돌아갑니다.</p>' : ''}
      <div class="sub-label">근무 <em>고정 타입 · 팀에 그대로 공유</em></div>
      <div class="shift-pick">${S.FIXED_TYPES.map((k) => `<button class="s-${k} ${!sel.custom && sel.shift === k ? 'on' : ''}" data-s="${k}">
        ${S.SHIFT_INFO[k].label}${k === base ? '<small>원래</small>' : ''}</button>`).join('')}</div>
      <div class="sub-label">내 근무 타입 <em>나만 보는 이름표</em><button class="link-btn inline" data-edit-types>편집</button></div>
      <div class="chips">${customs.length ? customs.map((c) => `<button class="chip custom ${sel.custom === c.id ? 'on' : ''}" data-c="${c.id}"
          style="--c:${c.color};--cf:${textOn(c.color)}">${esc(c.name)} <small>${baseShort(c.base_shift)}</small></button>`).join('')
        : '<span class="muted small-note">아직 없어요. 편집에서 만들 수 있어요 (예: 압대, 냉대).</span>'}</div>
      ${selCustom && selCustom.base_shift === 'AUTO' && base === 'O' ? `<p class="auto-line">→ 앞뒤 근무 기준으로 <b>${S.SHIFT_INFO[sel.shift].label}</b>에 들어가요
        <button class="link-btn inline2" data-flip>${sel.shift === 'D' ? '야간' : '주간'}으로 바꾸기</button></p>` : ''}
      ${!isBase ? `<button class="link-btn" data-reset>원래 근무(${S.SHIFT_INFO[base].label})로 되돌리기</button>` : ''}
      ${sel.shift === 'V' ? `<div class="field"><span class="field-label">휴가 종류 <em>나만 보기</em></span>
        <div class="chips">${VAC_TYPES.map((v) => `<button class="chip ${vtype === v ? 'on' : ''}" data-v="${v}">${v}</button>`).join('')}</div></div>` : ''}
      <label class="field"><span class="field-label">메모 <em>나만 보기</em></span>
        <textarea name="memo" rows="2" maxlength="500" placeholder="예: 병원 예약 10시">${esc(note?.memo || '')}</textarea></label>
      <p class="note">${noteText}</p>
      <div class="row-btns"><button class="btn ghost" data-close>닫기</button><button class="btn primary" data-save>저장</button></div>
    `, { type: 'mine', iso });
    const memoEl = sh.querySelector('textarea');
    if (memoCache !== null) memoEl.value = memoCache;
    const keep = () => { memoCache = memoEl.value; };
    sh.querySelectorAll('[data-s]').forEach((b) => { b.onclick = () => { keep(); sel = { shift: b.dataset.s, custom: null }; draw(); }; });
    sh.querySelectorAll('[data-c]').forEach((b) => {
      b.onclick = () => {
        keep();
        const c = state.customTypes.get(b.dataset.c);
        const sh2 = c.base_shift === 'AUTO' ? S.autoShift(state.team, jo, iso) : c.base_shift;
        sel = sel.custom === c.id ? { shift: base, custom: null } : { shift: sh2, custom: c.id };
        draw();
      };
    });
    sh.querySelectorAll('[data-v]').forEach((b) => { b.onclick = () => { keep(); vtype = vtype === b.dataset.v ? '' : b.dataset.v; draw(); }; });
    sh.querySelector('[data-reset]')?.addEventListener('click', () => { keep(); sel = { shift: base, custom: null }; draw(); });
    sh.querySelector('[data-flip]')?.addEventListener('click', () => { keep(); sel = { ...sel, shift: sel.shift === 'D' ? 'N' : 'D' }; draw(); });
    sh.querySelector('[data-edit-types]').onclick = () => openCustomTypesSheet(iso);
    sh.querySelector('[data-close]').onclick = closeSheet;
    sh.querySelector('[data-save]').onclick = () => saveMine({ iso, base, cur, ov, note, sel, vtype, memo: memoEl.value });
  };
  draw();
}

async function saveMine({ iso, base, cur, ov, note, sel, vtype, memo }) {
  const shiftChanged = sel.shift !== cur.shift || (sel.custom || null) !== (cur.custom || null);
  if (ov?.is_cover && shiftChanged && !(await confirmModal('확정된 대근이 취소됩니다. 계속할까요?', '계속'))) return;
  const newVt = sel.shift === 'V' ? (vtype || null) : null;
  const newMemo = memo.trim() || null;
  const noteChanged = (note?.memo || null) !== newMemo || (note?.vacation_type || null) !== newVt;
  if (!shiftChanged && !noteChanged) return closeSheet();
  await withBusy(async () => {
    try {
      if (shiftChanged) {
        const { error } = await sb.rpc('set_my_shift', {
          p_date: iso, p_shift: sel.shift === base && !sel.custom ? null : sel.shift, p_custom: sel.custom || null,
        });
        if (error) throw error;
      }
      if (noteChanged) await writeNote(iso, newMemo, newVt);
      closeSheet();
      await loadMonth();
      renderApp();
      const label = sel.custom ? state.customTypes.get(sel.custom)?.name : S.SHIFT_INFO[sel.shift].label;
      const canUndo = shiftChanged && !ov?.is_cover;
      toast(shiftChanged ? `${S.formatDay(iso)} ${label}(으)로 바꿨어요` : '메모를 저장했어요',
        canUndo ? { label: '되돌리기', fn: () => undoMine(iso, { shift: ov?.shift ?? null, custom: ov?.custom_type_id ?? null }, note) } : null, 6000);
    } catch (e) { toastErr(e); }
  });
}

async function writeNote(iso, memo, vt) {
  if (memo || vt) {
    const { error } = await sb.from('personal_notes').upsert(
      { user_id: state.user.id, work_date: iso, memo, vacation_type: vt, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,work_date' });
    if (error) throw error;
  } else {
    const { error } = await sb.from('personal_notes').delete().eq('user_id', state.user.id).eq('work_date', iso);
    if (error) throw error;
  }
}

async function undoMine(iso, prev, prevNote) {
  await withBusy(async () => {
    try {
      const custom = prev.custom && state.customTypes.has(prev.custom) ? prev.custom : null;
      const { error } = await sb.rpc('set_my_shift', { p_date: iso, p_shift: prev.shift, p_custom: custom });
      if (error) throw error;
      await writeNote(iso, prevNote?.memo || null, prevNote?.vacation_type || null);
      await loadMonth();
      renderApp();
      toast('되돌렸어요');
    } catch (e) { toastErr(e); }
  });
}

// ---------- 내 근무 타입 (커스텀) ----------
const PALETTE = ['#e8590c', '#ff9f80', '#b05fd6', '#f06595', '#20c997', '#748ffc', '#fab005', '#82c91e', '#868e96', '#495057'];

async function reloadCustomTypes() {
  const { data, error } = await sb.from('custom_types').select('*').eq('user_id', state.user.id).order('sort').order('created_at');
  if (error) throw error;
  state.customTypes = new Map(data.map((c) => [c.id, c]));
}

function openCustomTypesSheet(returnIso, editId = null) {
  const list = [...state.customTypes.values()];
  const editing = editId ? state.customTypes.get(editId) : null;
  const color0 = editing?.color || PALETTE[list.length % PALETTE.length];
  const sh = openSheet(`
    <h3>내 근무 타입</h3>
    <p class="muted small-note">내 달력에서만 보이는 이름표예요. 팀 달력과 대근 계산에는 고른 <b>기준 근무</b>로 들어갑니다.
      대근용 타입은 <b>자동</b>을 고르면 쉬는 날 앞뒤 근무에 맞춰 주간/야간이 정해져요.</p>
    ${list.length ? `<ul class="ctype-list">${list.map((c) => `<li>
      ${shiftBadge(null, false, '', c)} <span class="muted">기준: ${baseLabel(c.base_shift)}</span>
      <span class="ctype-actions"><button class="btn ghost sm" data-edit="${c.id}">수정</button>
      <button class="btn danger-ghost sm" data-del="${c.id}">삭제</button></span></li>`).join('')}</ul>` : ''}
    <form id="ctf" class="form ctype-form">
      <h4>${editing ? `"${esc(editing.name)}" 수정` : '새 타입 추가'}</h4>
      <label>이름 <small class="muted">최대 6자</small><input name="name" maxlength="6" value="${esc(editing?.name || '')}" placeholder="예: 압대" required></label>
      <label>기준 근무 <small class="muted">팀 달력에 이렇게 보여요</small><select name="base">
        <option value="AUTO" ${(editing?.base_shift || 'AUTO') === 'AUTO' ? 'selected' : ''}>자동 — 근무일은 그 근무, 쉬는 날은 앞뒤 근무(주/야) · 대근용</option>
        ${S.FIXED_TYPES.map((k) => `<option value="${k}" ${editing?.base_shift === k ? 'selected' : ''}>${S.SHIFT_INFO[k].label}</option>`).join('')}
      </select></label>
      <div class="field"><span class="field-label">색</span><div class="swatches">${PALETTE.map((c) => `<label>
        <input type="radio" name="color" value="${c}" ${c === color0 ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div></div>
      ${editing ? '<p class="note">기준 근무를 바꾸면 앞으로 고르는 날부터 적용돼요. 이미 지정한 날은 그대로예요.</p>' : ''}
      <div class="row-btns"><button type="button" class="btn ghost" data-back>${returnIso ? '돌아가기' : '닫기'}</button>
        <button class="btn primary">${editing ? '수정 저장' : '추가'}</button></div>
    </form>`, { type: 'custom' });
  const back = () => { if (returnIso) openMineSheet(returnIso); else closeSheet(); };
  sh.querySelector('[data-back]').onclick = back;
  sh.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => openCustomTypesSheet(returnIso, b.dataset.edit); });
  sh.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const c = state.customTypes.get(b.dataset.del);
      if (!(await confirmModal(`"${c.name}" 타입을 삭제할까요? 이 타입을 쓴 날은 그날 들어간 근무(주간·야간 등)로 남아요.`, '삭제'))) return;
      await withBusy(async () => {
        try {
          const { error } = await sb.from('custom_types').delete().eq('id', c.id);
          if (error) throw error;
          await reloadCustomTypes();
          await loadMonth();
          renderApp();
          openCustomTypesSheet(returnIso);
        } catch (e) { toastErr(e); }
      });
    };
  });
  sh.querySelector('#ctf').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const row = { name: f.get('name').trim(), base_shift: f.get('base'), color: f.get('color') };
    if (!row.name) return toast('이름을 입력해 주세요');
    await withBusy(async () => {
      try {
        const { error } = editing
          ? await sb.from('custom_types').update(row).eq('id', editing.id)
          : await sb.from('custom_types').insert({ ...row, user_id: state.user.id, sort: list.length });
        if (error) throw error;
        await reloadCustomTypes();
        renderApp();
        toast(editing ? '수정했어요' : `"${row.name}" 타입을 만들었어요`);
        openCustomTypesSheet(returnIso);
      } catch (err) { toastErr(err); }
    });
  };
}

// ---------- 탭 2: 팀 달력 ----------
function dayRequests(iso) {
  return state.requests.filter((r) => r.work_date === iso);
}

function viewTeam() {
  const { y, m } = state.ym;
  const today = todayISO();
  const cells = S.monthGrid(y, m).map((iso) => {
    if (!iso) return '<span class="cell empty"></span>';
    const duty = S.josOnDuty(state.team, iso);
    const reqs = dayRequests(iso);
    const open = reqs.filter((r) => r.status === 'open').length;
    const filled = reqs.filter((r) => r.status === 'filled').length;
    const vac = activeMembers().filter((mem) => S.ABSENCE.has(shiftOf(mem, iso).shift)).length;
    const mine = shiftOf(state.me, iso);
    const dow = S.fromISO(iso).getDay();
    return `<button class="cell tcell ${iso === today ? 'today' : ''}" data-action="team-day" data-iso="${iso}">
      ${cellHead(iso, dow)}
      <span class="duty"><i class="d">${duty.D.join('')}</i><i class="n">${duty.N.join('')}</i></span>
      ${open ? `<span class="pill open">대근${open}</span>` : filled ? `<span class="pill filled">확정${filled}</span>` : vac ? `<span class="pill vac">부재${vac}</span>` : ''}
      ${mine.shift === 'D' || mine.shift === 'N' ? `<i class="me-dot s-${mine.shift}"></i>` : ''}
    </button>`;
  }).join('');
  const up = state.upcoming.slice(0, 8).map((r) => `<button class="req-chip" data-action="goto-req" data-iso="${r.work_date}">
      <b>${S.formatDay(r.work_date)}</b> ${S.SHIFT_INFO[r.shift].label} · ${esc(memberName(r.requester_id))}
      <span class="muted">지원 ${(state.volunteers.get(r.id) || []).length}</span></button>`).join('');
  return `<header class="top"><div><h1>팀 달력</h1>
      <p class="muted">${esc(state.team.factory_name)} · ${esc(state.team.ban_name)}반 · ${activeMembers().length}명</p></div>
      <span class="live" title="실시간 연결">● 실시간</span></header>
    <section class="upcoming">${up ? `<h4>대근 필요 ${state.upcoming.length}건</h4><div class="req-list">${up}</div>`
      : '<p class="muted small-note">대근이 필요한 휴가가 없어요</p>'}</section>
    ${monthNav(state.ym, 'month')}
    ${WEEK_HEAD}
    <div class="grid">${cells}</div>
    <p class="legend"><span class="duty inline"><i class="d">A</i></span>주간 조 <span class="duty inline"><i class="n">D</i></span>야간 조
      <span class="pill open">대근</span>필요 <span class="pill filled">확정</span>완료 <i class="me-dot s-D inline"></i>내 근무</p>`;
}

function openTeamSheet(iso) {
  const groups = { D: [], N: [], O: [], A: [] };
  for (const mem of activeMembers()) {
    const s = shiftOf(mem, iso);
    if (!s.shift) continue;
    groups[S.ABSENCE.has(s.shift) ? 'A' : s.shift].push({ mem, ...s });
  }
  const reqs = dayRequests(iso);
  const myShift = shiftOf(state.me, iso).shift;
  const prevMine = shiftOf(state.me, S.addDays(iso, -1)).shift;
  const nextMine = shiftOf(state.me, S.addDays(iso, 1)).shift;

  const reqCard = (r) => {
    const vols = state.volunteers.get(r.id) || [];
    const mineReq = r.requester_id === state.user.id;
    const canManage = mineReq || isAdmin();
    const iVol = vols.some((v) => v.user_id === state.user.id);
    let actions = '';
    if (r.status === 'open') {
      if (!mineReq) {
        if (iVol) actions += `<button class="btn ghost sm" data-req="unvol" data-id="${r.id}">지원 취소</button>`;
        else if (myShift === 'O') {
          const warn = (r.shift === 'D' && prevMine === 'N') ? '전날 야간 근무 직후예요'
            : (r.shift === 'N' && nextMine === 'D') ? '다음 날 주간 근무가 이어져요' : '';
          actions += `<button class="btn primary sm" data-req="vol" data-id="${r.id}">대근 지원</button>${warn ? `<span class="warn-text">${warn}</span>` : ''}`;
        } else actions += '<span class="muted">그날 근무가 있어 지원할 수 없어요</span>';
      }
    } else if (r.status === 'filled' && (canManage || r.filled_by === state.user.id)) {
      actions += `<button class="btn ghost sm" data-req="unconfirm" data-id="${r.id}">확정 취소</button>`;
    }
    const volList = vols.length ? `<ul class="vols">${vols.map((v) => {
      const mm = state.memberMap.get(v.user_id);
      const confirmBtn = r.status === 'open' && canManage
        ? `<button class="btn primary sm" data-req="confirm" data-id="${r.id}" data-uid="${v.user_id}">확정</button>` : '';
      return `<li><span>${esc(mm?.display_name ?? '(나간 사람)')} <small>${joAt(v.user_id, iso) ?? ''}조</small></span>${confirmBtn}</li>`;
    }).join('')}</ul>` : (r.status === 'open' ? '<p class="muted small-note">아직 지원자가 없어요</p>' : '');
    const req = state.memberMap.get(r.requester_id);
    const absShift = state.overrides.get(okey(r.requester_id, iso))?.shift;
    const absLabel = S.ABSENCE.has(absShift) ? S.SHIFT_INFO[absShift].label : '휴가';
    return `<div class="req-card ${r.status}">
      <div class="req-head"><b>${esc(req?.display_name ?? '(나간 사람)')}</b> <small>${joAt(r.requester_id, iso) ?? ''}조</small>
        <span class="tag s-${r.shift}">${S.SHIFT_INFO[r.shift].label}</span><span class="tag s-${S.ABSENCE.has(absShift) ? absShift : 'V'}">${absLabel}</span>
        ${r.status === 'open' ? '<span class="tag open">대근 필요</span>' : `<span class="tag filled">대근 확정 · ${esc(memberName(r.filled_by))}</span>`}</div>
      ${r.status === 'open' ? volList : ''}
      ${actions ? `<div class="req-actions">${actions}</div>` : ''}
    </div>`;
  };

  const byJo = (list) => S.JOS.map((jo) => {
    const ps = list.filter((x) => x.jo === jo);
    if (!ps.length) return '';
    return `<div class="jo-row"><span class="jo-tag">${jo}조</span>${ps.map((x) => `<span class="person ${x.mem.user_id === state.user.id ? 'me' : ''}">
      ${esc(x.mem.display_name)}${x.isCover ? '<em class="cover-tag">대근</em>' : x.changed ? '<em>변경</em>' : ''}</span>`).join('')}</div>`;
  }).join('') || '<p class="muted small-note">없음</p>';

  const reqUserIds = new Set(reqs.map((r) => r.requester_id));
  const otherVac = groups.A.filter((x) => !reqUserIds.has(x.mem.user_id));
  const duty = S.josOnDuty(state.team, iso);

  const sh = openSheet(`
    <h3>${S.formatDay(iso)}${holidayTag(iso)} <small class="muted">주간 ${duty.D.join('')}조 · 야간 ${duty.N.join('')}조</small></h3>
    ${reqs.length || otherVac.length ? `<section class="sec"><h4>자리 비움 · 대근</h4>
      ${reqs.map(reqCard).join('')}
      ${otherVac.map((x) => `<div class="req-card plain"><b>${esc(x.mem.display_name)}</b> <small>${x.jo ?? ''}조</small> <span class="tag s-${x.shift}">${S.SHIFT_INFO[x.shift].label}</span> <span class="muted">쉬는 날이라 대근 불필요</span></div>`).join('')}
    </section>` : ''}
    <section class="sec"><h4>${shiftBadge('D')} 주간 07~17 <small class="muted">${groups.D.length}명</small></h4>${byJo(groups.D)}</section>
    <section class="sec"><h4>${shiftBadge('N')} 야간 17~07 <small class="muted">${groups.N.length}명</small></h4>${byJo(groups.N)}</section>
    <details class="sec"><summary><h4>${shiftBadge('O')} 휴무 <small class="muted">${groups.O.length}명</small></h4></summary>${byJo(groups.O)}</details>
    <div class="row-btns"><button class="btn ghost block" data-close>닫기</button></div>
  `, { type: 'team', iso });
  sh.querySelector('[data-close]').onclick = closeSheet;
  sh.querySelectorAll('[data-req]').forEach((b) => { b.onclick = () => reqAction(b.dataset.req, b.dataset.id, b.dataset.uid, iso); });
}

async function reqAction(kind, id, uid, iso) {
  if (kind === 'unconfirm' && !(await confirmModal('대근 확정을 취소할까요? 다시 "대근 필요"로 바뀝니다.', '확정 취소'))) return;
  if (kind === 'confirm' && !(await confirmModal(`${memberName(uid)}님으로 대근을 확정할까요? 그분 달력에도 바로 "대근"으로 들어갑니다.`, '확정'))) return;
  const call = {
    vol: () => sb.rpc('volunteer_cover', { p_request: id }),
    unvol: () => sb.rpc('unvolunteer_cover', { p_request: id }),
    confirm: () => sb.rpc('confirm_cover', { p_request: id, p_user: uid }),
    unconfirm: () => sb.rpc('unconfirm_cover', { p_request: id }),
  }[kind];
  await withBusy(async () => {
    try {
      const { error } = await call();
      if (error) throw error;
      await loadMonth();
      renderApp();
      openTeamSheet(iso);
      toast({ vol: '대근 지원했어요', unvol: '지원을 취소했어요', confirm: '대근을 확정했어요', unconfirm: '확정을 취소했어요' }[kind]);
    } catch (e) { toastErr(e); }
  });
}

// ---------- 탭 3: 내 정보 ----------
function viewInfoShell() {
  return '<div id="info-root"><div class="loading">불러오는 중…</div></div>';
}

async function fillInfo() {
  const root = document.getElementById('info-root');
  const { y, m } = state.infoYm;
  try {
    if (!state.yearOverrides || state.yearOverrides.year !== y) await loadYear(y);
  } catch (e) { root.innerHTML = `<p class="muted">${esc(translateErr(e.message))}</p>`; return; }
  if (state.tab !== 'info') return;
  const map = state.yearOverrides.map;
  const { start, end } = S.monthRange(y, m);
  const myJoAt = (iso) => joAt(state.user.id, iso);
  const ms = S.periodStats(state.team, myJoAt, start, end, map);
  const ys = S.periodStats(state.team, myJoAt, `${y}-01-01`, `${y}-12-31`, map);
  const tile = (label, val, unit = '', sub = '') => `<div class="tile"><span class="muted">${label}</span><b>${val}<small>${unit}</small></b>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;

  const memberRows = [...S.JOS, null].map((jo) => {
    const ps = activeMembers().filter((mm) => curJo(mm) === jo);
    if (!ps.length) return '';
    return `<div class="jo-row"><span class="jo-tag">${jo ? `${jo}조` : '미설정'}</span>${ps.map((mm) => `<button class="person ${mm.user_id === state.user.id ? 'me' : ''}"
      ${isAdmin() && mm.user_id !== state.user.id ? `data-action="member" data-uid="${mm.user_id}"` : 'disabled'}>
      ${esc(mm.display_name)}${mm.role === 'admin' ? '<em>관리자</em>' : ''}</button>`).join('')}</div>`;
  }).join('');

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const install = standalone ? '' : state.installPrompt
    ? '<button class="btn ghost block" data-action="install">홈 화면에 앱 설치</button>'
    : isIOS ? '<p class="note">홈 화면에 추가하려면 Safari 하단 <b>공유</b> 버튼 → <b>홈 화면에 추가</b>를 누르세요.</p>' : '';

  root.innerHTML = `
    <header class="top"><div><h1>${esc(state.me.display_name)} <small>${joLabel(curJo(state.me))}</small></h1>
      <p class="muted">직번 ${esc(empOf(state.user))} · ${esc(state.team.factory_name)} · ${esc(state.team.ban_name)}반 ${isAdmin() ? '· 관리자' : ''}</p></div>
      <button class="chip-btn" data-action="edit-profile">수정</button></header>
    <section class="card jo-card">
      <div><h4>내 조 · ${joLabel(curJo(state.me))}</h4><p class="muted small-note">${joHistoryText(state.user.id)}</p></div>
      <button class="btn ghost sm" data-action="change-jo" data-uid="${state.user.id}">조 변경</button>
    </section>
    ${monthNav(state.infoYm, 'info-month')}
    <div class="tiles">
      ${tile('총 근무', ms.workHours, '시간', `${ms.workDays}일`)}
      ${tile('주간 / 야간', `${ms.day} / ${ms.night}`, '회')}
      ${tile('야간 시간 (22~06시)', ms.nightHours, '시간')}
      ${tile('대근', ms.cover, '회', `${ms.coverHours}시간`)}
      ${tile('휴가', ms.abs.V, '일', ['E', 'H', 'T', 'R'].filter((k) => ms.abs[k]).map((k) => `${S.SHIFT_INFO[k].label} ${ms.abs[k]}`).join(' · '))}
      ${tile(`${y}년 누적`, `휴가 ${ys.vacation}일`, '', `대근 ${ys.cover}회`)}
    </div>
    <p class="note">근무표 기준 <b>참고용</b> 계산입니다 (주간 10시간, 야간 14시간). 연장근무·실제 급여와 다를 수 있어요.</p>

    <section class="card">
      <h4>팀 초대 코드</h4>
      <div class="code-row"><code class="invite">${esc(state.team.invite_code)}</code>
        <button class="btn primary sm" data-action="copy-code">공유</button></div>
      <p class="muted small-note">같은 공장·같은 반 동료에게만 보내 주세요.</p>
    </section>
    ${isAdmin() && pendingMembers().length ? `<section class="card pending-card"><h4>가입 승인 대기 ${pendingMembers().length}명</h4>
      <p class="muted small-note">같은 반 동료가 맞는지 이름을 확인하고 승인해 주세요.</p>
      ${pendingMembers().map((mm) => `<div class="pending-row"><span><b>${esc(mm.display_name)}</b>
        <small class="muted">신청 ${S.formatDay(S.toISO(new Date(mm.created_at)))}</small></span>
        <span><button class="btn ghost sm" data-action="reject" data-uid="${mm.user_id}">거절</button>
        <button class="btn primary sm" data-action="approve" data-uid="${mm.user_id}">승인</button></span></div>`).join('')}
    </section>` : ''}
    <section class="card"><h4>팀원 ${activeMembers().length}명 ${isAdmin() ? '<small class="muted">이름을 누르면 관리</small>' : ''}</h4>${memberRows}</section>
    ${state.isOperator ? '<button class="btn primary block" data-action="operator">운영자 메뉴 (전체 팀 · 관리자 초대)</button>' : ''}
    <button class="btn ghost block" data-action="custom-types">내 근무 타입 관리 (커스텀)</button>
    ${isAdmin() ? '<button class="btn ghost block" data-action="team-settings">팀 설정 (공장·반·근무 기준)</button>' : ''}
    ${install}
    <div class="row-btns"><button class="btn ghost" data-action="logout">로그아웃</button>
      <button class="btn danger-ghost" data-action="leave">팀 나가기</button></div>
    <p class="muted center small-note">교대달력 · 광고 없음</p>`;
}

async function shareCode() {
  const text = `교대달력 ${state.team.factory_name} ${state.team.ban_name}반 초대 코드: ${state.team.invite_code}\n${location.origin}${location.pathname}`;
  try {
    if (navigator.share) await navigator.share({ title: '교대달력 초대', text });
    else { await navigator.clipboard.writeText(text); toast('초대 문구를 복사했어요'); }
  } catch (e) { if (e?.name !== 'AbortError') toast('복사하지 못했어요. 코드를 직접 알려 주세요'); }
}

async function installApp() {
  const p = state.installPrompt;
  if (!p) return;
  p.prompt();
  await p.userChoice.catch(() => null);
  state.installPrompt = null;
  renderApp();
}

function openProfileSheet() {
  const sh = openSheet(`<h3>내 정보 수정</h3>
    <form class="form" id="pf">
      <label>이름<input name="name" maxlength="20" value="${esc(state.me.display_name)}" required></label>
      <p class="note">조는 <b>조 변경</b>에서 바꿔 주세요 (적용 시작일과 함께 기록돼요).</p>
      <div class="row-btns"><button type="button" class="btn ghost" data-close>취소</button><button class="btn primary">저장</button></div>
    </form>`, { type: 'profile' });
  sh.querySelector('[data-close]').onclick = closeSheet;
  sh.querySelector('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await withBusy(async () => {
      try {
        const { error } = await sb.rpc('update_my_profile', { p_display_name: f.get('name') });
        if (error) throw error;
        closeSheet();
        await refresh({ team: true });
        toast('저장했어요');
      } catch (err) { toastErr(err); }
    });
  };
}

function openTeamSettingsSheet() {
  const t = todayISO();
  const curPos = ((state.team.a_pos + S.daysBetween(state.team.anchor_date, t)) % 8 + 8) % 8;
  const sh = openSheet(`<h3>팀 설정</h3>
    <form class="form" id="tf">
      <label>공장 이름<input name="factory" maxlength="40" value="${esc(state.team.factory_name)}" required></label>
      ${banField(state.team.ban_name)}
      <label>근무 기준 보정 <small class="muted">평소엔 바꿀 필요 없음 · 오늘 A조 근무</small><select name="apos">${posOptions(curPos)}</select></label>
      <p class="note preview">${previewFor({ anchor_date: t, a_pos: curPos })}</p>
      <div class="row-btns"><button type="button" class="btn ghost" data-newcode>초대 코드 새로 만들기</button></div>
      <div class="row-btns"><button type="button" class="btn ghost" data-close>취소</button><button class="btn primary">저장</button></div>
    </form>`, { type: 'settings' });
  const form = sh.querySelector('#tf');
  wireBanField(form);
  const sel = form.querySelector('select[name=apos]');
  sel.onchange = () => { form.querySelector('.preview').innerHTML = previewFor({ anchor_date: t, a_pos: +sel.value }); };
  sh.querySelector('[data-close]').onclick = closeSheet;
  sh.querySelector('[data-newcode]').onclick = async () => {
    if (!(await confirmModal('초대 코드를 새로 만들까요? 기존 코드로는 더 이상 참여할 수 없어요.', '새로 만들기'))) return;
    await withBusy(async () => {
      try {
        const { error } = await sb.rpc('regenerate_invite_code');
        if (error) throw error;
        closeSheet();
        await refresh({ team: true });
        toast('새 초대 코드를 만들었어요');
      } catch (err) { toastErr(err); }
    });
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const ban = banValue(f);
    if (!ban) return toast('반 이름을 입력해 주세요');
    if (+f.get('apos') !== curPos && !(await confirmModal('근무 기준을 바꾸면 팀 전체 근무표가 바뀝니다. 계속할까요?', '변경'))) return;
    await withBusy(async () => {
      try {
        const { error } = await sb.rpc('update_team_settings', {
          p_factory: f.get('factory'), p_ban: ban, p_anchor: t, p_a_pos: +f.get('apos'),
        });
        if (error) throw error;
        closeSheet();
        await refresh({ team: true });
        toast('팀 설정을 저장했어요');
      } catch (err) { toastErr(err); }
    });
  };
}

function joHistoryText(uid) {
  const h = state.joHist.get(uid) || [];
  if (!h.length) return '조가 아직 설정되지 않았어요';
  return h.map((x, i) => {
    const from = x.effective_from <= '2000-01-01' ? '처음' : S.formatDay(x.effective_from).split(' ')[0];
    const next = h[i + 1];
    const to = next ? `~${S.formatDay(S.addDays(next.effective_from, -1)).split(' ')[0]}` : '~현재';
    return `${x.jo}조 ${from}${to}`;
  }).join(' → ');
}

function openJoSheet(uid) {
  const mm = state.memberMap.get(uid);
  if (!mm) return;
  const self = uid === state.user.id;
  const t = todayISO();
  const cur = curJo(mm);
  const sh = openSheet(`<h3>${self ? '내 조 변경' : `${esc(mm.display_name)} 조 변경`}</h3>
    <p class="muted small-note">지금: ${joLabel(cur)} · ${joHistoryText(uid)}</p>
    <form class="form" id="jf">
      <div class="field"><span class="field-label">새 조</span>${joSelect('jo', '')}</div>
      <label>언제부터<input type="date" name="from" value="${t}" required></label>
      <p class="note">이 날부터 새 조 근무표가 적용돼요. <b>이전 근무 기록은 그대로</b> 남습니다.
        이 날 이후의 휴가·대근은 새 근무에 맞게 자동 정리돼요 (예: 새 조로 근무일이 된 날의 대근은 해제).</p>
      <div class="row-btns"><button type="button" class="btn ghost" data-close>취소</button><button class="btn primary">변경</button></div>
    </form>`, { type: 'jo' });
  sh.querySelector('[data-close]').onclick = closeSheet;
  sh.querySelector('#jf').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const jo = f.get('jo');
    const from = f.get('from');
    if (!jo) return toast('새 조를 선택해 주세요');
    if (!(await confirmModal(`${S.formatDay(from)}부터 ${jo}조로 바꿀까요?`, '변경'))) return;
    await withBusy(async () => {
      try {
        const { error } = await sb.rpc('set_member_jo', { p_user: self ? null : uid, p_jo: jo, p_from: from });
        if (error) throw error;
        closeSheet();
        await refresh({ team: true });
        toast(`${S.formatDay(from)}부터 ${jo}조로 바꿨어요`);
      } catch (err) { toastErr(err); }
    });
  };
}

// ---------- 운영자 메뉴 ----------
async function openOperatorSheet() {
  let teams = [];
  try {
    const { data, error } = await sb.rpc('op_teams');
    if (error) throw error;
    teams = data || [];
  } catch (e) { return toastErr(e); }
  const appUrl = `${location.origin}${location.pathname}`;
  const sh = openSheet(`
    <h3>운영자 메뉴</h3>
    <p class="muted small-note">관리자 초대 코드는 <b>1회용</b>이에요. 받은 사람이 가입하면 바로 그 반의 관리자가 되고, 코드는 사라집니다.</p>
    ${teams.map((t) => `<div class="op-team">
      <div class="op-head"><b>${esc(t.factory_name)} · ${esc(t.ban_name)}반</b>
        <span class="muted">${t.active_count}명${t.pending_count ? ` · 대기 ${t.pending_count}` : ''}</span></div>
      <p class="muted small-note">관리자: ${esc(t.admins || '없음')}</p>
      <div class="op-codes">
        <span>일반 초대 <code>${esc(t.invite_code)}</code></span>
        <span>관리자 초대 ${t.admin_invite_code ? `<code class="admin">${esc(t.admin_invite_code)}</code>` : '<em class="muted">없음</em>'}</span>
      </div>
      <div class="row-btns">
        <button class="btn ghost sm" data-newadmin="${t.id}">${t.admin_invite_code ? '관리자 코드 재발급' : '관리자 코드 발급'}</button>
        ${t.admin_invite_code ? `<button class="btn primary sm" data-shareadmin="${t.id}">관리자 코드 공유</button>` : ''}
      </div></div>`).join('')}
    <form id="opf" class="form ctype-form">
      <h4>새 팀(반) 만들기</h4>
      <p class="muted small-note">운영자는 새 팀에 들어가지 않아요. 만든 뒤 관리자 초대 코드를 그 반 주임에게 보내 주세요.</p>
      ${teamFields()}
      <div class="row-btns"><button type="button" class="btn ghost" data-close>닫기</button><button class="btn primary">팀 만들기</button></div>
    </form>`, { type: 'operator' });
  sh.querySelector('[data-close]').onclick = closeSheet;
  wireBanField(sh.querySelector('#opf'));
  const share = async (t, code) => {
    const text = `교대달력 ${t.factory_name} ${t.ban_name}반 관리자 초대 코드: ${code}\n(1회용 · 이 코드로 가입하면 바로 관리자가 됩니다)\n${appUrl}`;
    try {
      if (navigator.share) await navigator.share({ title: '교대달력 관리자 초대', text });
      else { await navigator.clipboard.writeText(text); toast('관리자 초대 문구를 복사했어요'); }
    } catch (e) { if (e?.name !== 'AbortError') toast('복사하지 못했어요. 코드를 직접 알려 주세요'); }
  };
  sh.querySelectorAll('[data-shareadmin]').forEach((b) => {
    b.onclick = () => { const t = teams.find((x) => x.id === b.dataset.shareadmin); share(t, t.admin_invite_code); };
  });
  sh.querySelectorAll('[data-newadmin]').forEach((b) => {
    b.onclick = async () => {
      const t = teams.find((x) => x.id === b.dataset.newadmin);
      if (t.admin_invite_code && !(await confirmModal('새로 발급하면 이전 관리자 코드는 쓸 수 없게 돼요. 계속할까요?', '재발급'))) return;
      await withBusy(async () => {
        try {
          const { error } = await sb.rpc('op_new_admin_code', { p_team: t.id });
          if (error) throw error;
          await openOperatorSheet();
          toast('관리자 초대 코드를 발급했어요');
        } catch (e) { toastErr(e); }
      });
    };
  });
  sh.querySelector('#opf').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const ban = banValue(f);
    if (!ban) return toast('반 이름을 입력해 주세요');
    await withBusy(async () => {
      try {
        const { error } = await sb.rpc('op_create_team', {
          p_factory: f.get('factory'), p_ban: ban, p_anchor: COMPANY_ANCHOR.anchor_date, p_a_pos: COMPANY_ANCHOR.a_pos,
        });
        if (error) throw error;
        await openOperatorSheet();
        toast(`${ban}반을 만들었어요. 관리자 코드를 주임에게 보내 주세요`, null, 6000);
      } catch (err) { toastErr(err); }
    });
  };
}

function openMemberSheet(uid) {
  const mm = state.memberMap.get(uid);
  if (!mm) return;
  const sh = openSheet(`<h3>${esc(mm.display_name)} <small class="muted">${joLabel(curJo(mm))}</small></h3>
    <p class="muted small-note">${joHistoryText(uid)}</p>
    <div class="stack">
      <button class="btn ghost block" data-jo>조 변경 (인사이동)</button>
      ${mm.role !== 'admin' ? '<button class="btn primary block" data-transfer>관리자 넘기기 (나는 일반 팀원이 됨)</button>' : ''}
      <button class="btn ghost block" data-role>${mm.role === 'admin' ? '관리자 해제' : '관리자 추가 지정 (나도 관리자 유지)'}</button>
      <button class="btn danger-ghost block" data-remove>팀에서 내보내기</button>
      <button class="btn ghost block" data-close>닫기</button>
    </div>`, { type: 'member' });
  sh.querySelector('[data-close]').onclick = closeSheet;
  sh.querySelector('[data-jo]').onclick = () => openJoSheet(uid);
  sh.querySelector('[data-transfer]')?.addEventListener('click', async () => {
    if (!(await confirmModal(`${mm.display_name}님에게 관리자를 넘길까요? 나는 일반 팀원이 되고, 되돌리려면 새 관리자가 다시 지정해 줘야 해요.`, '넘기기'))) return;
    await withBusy(async () => {
      try {
        const { error } = await sb.rpc('transfer_admin', { p_user: uid });
        if (error) throw error;
        closeSheet(); await refresh({ team: true }); toast(`${mm.display_name}님이 관리자가 됐어요`);
      } catch (e) { toastErr(e); }
    });
  });
  sh.querySelector('[data-role]').onclick = () => withBusy(async () => {
    try {
      const { error } = await sb.rpc('set_member_role', { p_user: uid, p_role: mm.role === 'admin' ? 'member' : 'admin' });
      if (error) throw error;
      closeSheet(); await refresh({ team: true }); toast('권한을 바꿨어요');
    } catch (e) { toastErr(e); }
  });
  sh.querySelector('[data-remove]').onclick = async () => {
    if (!(await confirmModal(`${mm.display_name}님을 내보낼까요? 그분이 맡은 대근은 다시 "대근 필요"로 바뀝니다.`, '내보내기'))) return;
    await withBusy(async () => {
      try {
        const { error } = await sb.rpc('remove_member', { p_user: uid });
        if (error) throw error;
        closeSheet(); await refresh({ team: true }); toast('내보냈어요');
      } catch (e) { toastErr(e); }
    });
  };
}

async function leaveTeam() {
  if (!(await confirmModal('팀에서 나갈까요? 내 근무 변경·휴가 기록이 모두 삭제됩니다.', '나가기'))) return;
  await withBusy(async () => {
    try {
      const { error } = await sb.rpc('leave_team');
      if (error) throw error;
      teardown();
      renderOnboarding();
      toast('팀에서 나왔어요');
    } catch (e) { toastErr(e); }
  });
}

// ---------- PWA ----------
function registerSW() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW 등록 실패', e));
  }
}

boot();
