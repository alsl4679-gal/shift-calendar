import { createClient } from '../vendor/supabase.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import * as S from './shift.js';

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
  user: null, me: null, team: null, members: [], memberMap: new Map(),
  tab: 'mine', ym: nowYM(), infoYm: nowYM(),
  overrides: new Map(), requests: [], upcoming: [], volunteers: new Map(), notes: new Map(),
  yearOverrides: null, channel: null, openSheet: null, installPrompt: null,
};

const okey = (uid, iso) => `${uid}|${iso}`;
const memberName = (uid) => state.memberMap.get(uid)?.display_name ?? '(나간 사람)';
const isAdmin = () => state.me?.role === 'admin';
function shiftOf(member, iso) {
  return S.effectiveShift(state.team, member.jo, iso, state.overrides.get(okey(member.user_id, iso)));
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
    [/Invalid login credentials/i, '이메일 또는 비밀번호가 틀렸습니다'],
    [/User already registered/i, '이미 가입된 이메일입니다'],
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

function shiftBadge(shift, isCover = false, extra = '') {
  const info = S.SHIFT_INFO[shift];
  return `<span class="badge s-${shift}${isCover ? ' cover' : ''} ${extra}">${isCover ? '대근' : info.short}</span>`;
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
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.team) refresh({ team: true, quiet: true });
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
  await loadTeam();
  await loadMonth();
  subscribe();
  renderApp();
}

function teardown() {
  if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
  Object.assign(state, { me: null, team: null, members: [], memberMap: new Map(), yearOverrides: null });
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
  const [t, ms] = await Promise.all([
    sb.from('teams').select('*').eq('id', state.me.team_id).maybeSingle(),
    sb.from('members').select('*').eq('team_id', state.me.team_id).order('jo').order('display_name'),
  ]);
  if (t.error) throw t.error;
  if (ms.error) throw ms.error;
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
function subscribe() {
  if (state.channel) sb.removeChannel(state.channel);
  const ch = sb.channel(`team-${state.team.id}`);
  for (const table of ['day_overrides', 'cover_requests', 'cover_volunteers', 'members']) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table }, onRealtime);
  }
  ch.subscribe();
  state.channel = ch;
}
function onRealtime(p) {
  if (p.table === 'members') rtMembers = true;
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

// ---------- 로그인 ----------
function renderAuth(mode = 'login', msg = '') {
  $app.innerHTML = `<div class="auth">
    <div class="brand"><img src="icons/icon-192.png" alt=""><h1>교대달력</h1>
      <p class="muted">광고 없는 우리 반 교대 근무표</p></div>
    <div class="seg">
      <button class="${mode === 'login' ? 'on' : ''}" data-mode="login">로그인</button>
      <button class="${mode === 'signup' ? 'on' : ''}" data-mode="signup">회원가입</button>
    </div>
    <form id="auth-form" class="card form">
      <label>이메일<input name="email" type="email" autocomplete="email" required></label>
      <label>비밀번호<input name="password" type="password" minlength="6"
        autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required></label>
      ${mode === 'signup' ? '<label>비밀번호 확인<input name="password2" type="password" minlength="6" autocomplete="new-password" required></label>' : ''}
      ${msg ? `<p class="note">${esc(msg)}</p>` : ''}
      <button class="btn primary block" type="submit">${mode === 'login' ? '로그인' : '가입하기'}</button>
    </form></div>`;
  $app.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => renderAuth(b.dataset.mode); });
  $app.querySelector('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const email = f.get('email').trim();
    const password = f.get('password');
    if (mode === 'signup' && password !== f.get('password2')) return toast('비밀번호가 서로 다릅니다');
    await withBusy(async () => {
      try {
        if (mode === 'login') {
          const { data, error } = await sb.auth.signInWithPassword({ email, password });
          if (error) throw error;
          state.user = data.user;
          await afterLogin();
        } else {
          const { data, error } = await sb.auth.signUp({ email, password });
          if (error) throw error;
          if (!data.session) return renderAuth('login', '가입 확인 메일을 보냈어요. 메일의 링크를 누른 뒤 로그인해 주세요.');
          state.user = data.user;
          await afterLogin();
        }
      } catch (err) { toastErr(err); }
    });
  };
}

// ---------- 팀 만들기 / 참여 ----------
function posOptions(selected = 0) {
  return S.POS_LABELS.map((l, i) => `<option value="${i}" ${i === selected ? 'selected' : ''}>${l}</option>`).join('');
}
function previewText(aPos) {
  const t = todayISO();
  const duty = S.josOnDuty({ anchor_date: t, a_pos: aPos }, t);
  return `오늘 주간 <b>${duty.D.join('')}조</b> · 야간 <b>${duty.N.join('')}조</b>`;
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

function renderOnboarding(mode = 'join') {
  const t = todayISO();
  $app.innerHTML = `<div class="auth">
    <div class="brand small"><h1>팀 설정</h1><p class="muted">같은 공장·같은 반 사람들과 달력을 공유해요</p></div>
    <div class="seg">
      <button class="${mode === 'join' ? 'on' : ''}" data-mode="join">초대 코드로 참여</button>
      <button class="${mode === 'create' ? 'on' : ''}" data-mode="create">새 팀 만들기</button>
    </div>
    ${mode === 'join' ? `
    <form id="ob-form" class="card form">
      <label>초대 코드<input name="code" maxlength="6" autocapitalize="characters" placeholder="예: YX2LFP" required></label>
      <label>이름 (팀에 보이는 이름)<input name="name" maxlength="20" required></label>
      <div class="field"><span class="field-label">내 조</span>${joSelect('jo')}</div>
      <button class="btn primary block">참여하기</button>
    </form>` : `
    <form id="ob-form" class="card form">
      <label>공장 이름<input name="factory" maxlength="40" placeholder="예: 2선재공장" required></label>
      ${banField('압연')}
      <label>이름 (팀에 보이는 이름)<input name="name" maxlength="20" required></label>
      <div class="field"><span class="field-label">내 조</span>${joSelect('jo')}</div>
      <label>오늘(${S.formatDay(t)}) A조 근무는?<select name="apos">${posOptions(0)}</select></label>
      <p class="note preview">${previewText(0)} — 맞는지 확인해 주세요</p>
      <button class="btn primary block">팀 만들기</button>
    </form>`}
    <button class="link-btn" data-action="logout">로그아웃</button>
  </div>`;
  $app.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => renderOnboarding(b.dataset.mode); });
  $app.querySelector('[data-action=logout]').onclick = () => sb.auth.signOut();
  const form = $app.querySelector('#ob-form');
  if (mode === 'create') {
    wireBanField(form);
    const sel = form.querySelector('select[name=apos]');
    sel.onchange = () => { form.querySelector('.preview').innerHTML = `${previewText(+sel.value)} — 맞는지 확인해 주세요`; };
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    await withBusy(async () => {
      try {
        if (mode === 'join') {
          const { error } = await sb.rpc('join_team', { p_code: f.get('code'), p_display_name: f.get('name'), p_jo: f.get('jo') });
          if (error) throw error;
        } else {
          const ban = banValue(f);
          if (!ban) return toast('반 이름을 입력해 주세요');
          const { error } = await sb.rpc('create_team', {
            p_factory: f.get('factory'), p_ban: ban, p_display_name: f.get('name'),
            p_jo: f.get('jo'), p_anchor: t, p_a_pos: +f.get('apos'),
          });
          if (error) throw error;
        }
        await afterLogin();
        toast(mode === 'join' ? '팀에 참여했어요' : '팀을 만들었어요. 내 정보 탭에서 초대 코드를 공유하세요');
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
      <button class="${state.tab === 'info' ? 'on' : ''}" data-tab="info">${ICONS.me}<span>내 정보</span></button>
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
      <span class="dnum ${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}">${+iso.slice(8)}</span>
      ${shiftBadge(s.shift, s.isCover)}
      ${note?.memo ? '<i class="memo-dot" title="메모"></i>' : ''}
    </button>`;
  }).join('');
  const card = (label, s) => `<div class="today-item">
      <span class="muted">${label}</span>${shiftBadge(s.shift, s.isCover, 'lg')}
      <span class="t-time">${S.SHIFT_INFO[s.shift].time || (s.shift === 'V' ? '휴가' : '쉬는 날')}</span></div>`;
  return `<header class="top"><div><h1>${esc(state.me.display_name)} <small>${state.me.jo}조</small></h1>
      <p class="muted">${esc(state.team.factory_name)} · ${esc(state.team.ban_name)}반</p></div></header>
    <section class="today-card">${card(`오늘 ${S.formatDay(wd)}`, t0)}${card('내일', t1)}</section>
    ${monthNav(state.ym, 'month')}
    ${WEEK_HEAD}
    <div class="grid">${cells}</div>
    <p class="legend">${['D', 'N', 'O', 'V'].map((k) => shiftBadge(k)).join('')}${shiftBadge('D', true)}
      <span class="muted">테두리 = 바꾼 날 · 점 = 메모</span></p>`;
}

function openMineSheet(iso) {
  const me = state.me;
  const ov = state.overrides.get(okey(me.user_id, iso));
  const base = S.baseShift(state.team, me.jo, iso);
  const cur = ov ? ov.shift : base;
  const note = state.notes.get(iso) || null;
  let sel = cur;
  let vtype = note?.vacation_type || '';

  const draw = () => {
    const sh = openSheet(`
      <h3>${S.formatDay(iso)}</h3>
      <p class="muted">원래 근무: ${S.SHIFT_INFO[base].label}${ov ? ` → 지금: ${ov.is_cover ? '대근 ' : ''}${S.SHIFT_INFO[ov.shift].label}` : ''}</p>
      ${ov?.is_cover ? '<p class="note warn">대근이 확정된 날이에요. 근무를 바꾸면 대근이 취소되고 다시 "대근 필요"로 돌아갑니다.</p>' : ''}
      <div class="shift-pick">${['D', 'N', 'O', 'V'].map((k) => `<button class="s-${k} ${sel === k ? 'on' : ''}" data-s="${k}">
        ${S.SHIFT_INFO[k].label}<small>${S.SHIFT_INFO[k].time || (k === 'V' ? '대근 요청 생성' : '')}</small></button>`).join('')}</div>
      ${sel !== base ? `<button class="link-btn" data-s="${base}">원래 근무(${S.SHIFT_INFO[base].label})로 되돌리기</button>` : ''}
      ${sel === 'V' ? `<div class="field"><span class="field-label">휴가 종류 <em>나만 보기</em></span>
        <div class="chips">${VAC_TYPES.map((v) => `<button class="chip ${vtype === v ? 'on' : ''}" data-v="${v}">${v}</button>`).join('')}</div></div>` : ''}
      <label class="field"><span class="field-label">메모 <em>나만 보기</em></span>
        <textarea name="memo" rows="2" maxlength="500" placeholder="예: 병원 예약 10시">${esc(note?.memo || '')}</textarea></label>
      <p class="note">근무 변경은 팀 달력에 바로 공유됩니다.${sel === 'V' && base !== 'O' ? ' 휴가를 저장하면 팀에 "대근 필요"가 올라가요.' : ''}</p>
      <div class="row-btns"><button class="btn ghost" data-close>닫기</button><button class="btn primary" data-save>저장</button></div>
    `, { type: 'mine', iso });
    const memoEl = sh.querySelector('textarea');
    sh.querySelectorAll('[data-s]').forEach((b) => { b.onclick = () => { memoCache = memoEl.value; sel = b.dataset.s; draw(); }; });
    sh.querySelectorAll('[data-v]').forEach((b) => { b.onclick = () => { memoCache = memoEl.value; vtype = vtype === b.dataset.v ? '' : b.dataset.v; draw(); }; });
    if (memoCache !== null) memoEl.value = memoCache;
    sh.querySelector('[data-close]').onclick = closeSheet;
    sh.querySelector('[data-save]').onclick = () => saveMine({ iso, base, cur, ov, note, sel, vtype, memo: memoEl.value });
  };
  let memoCache = null;
  draw();
}

async function saveMine({ iso, base, cur, ov, note, sel, vtype, memo }) {
  const shiftChanged = sel !== cur;
  if (ov?.is_cover && shiftChanged && !(await confirmModal('확정된 대근이 취소됩니다. 계속할까요?', '계속'))) return;
  const newVt = sel === 'V' ? (vtype || null) : null;
  const newMemo = memo.trim() || null;
  const noteChanged = (note?.memo || null) !== newMemo || (note?.vacation_type || null) !== newVt;
  if (!shiftChanged && !noteChanged) return closeSheet();
  await withBusy(async () => {
    try {
      if (shiftChanged) {
        const { error } = await sb.rpc('set_my_shift', { p_date: iso, p_shift: sel === base ? null : sel });
        if (error) throw error;
      }
      if (noteChanged) await writeNote(iso, newMemo, newVt);
      closeSheet();
      await loadMonth();
      renderApp();
      const canUndo = shiftChanged && !ov?.is_cover;
      toast(shiftChanged ? `${S.formatDay(iso)} ${S.SHIFT_INFO[sel].label}(으)로 바꿨어요` : '메모를 저장했어요',
        canUndo ? { label: '되돌리기', fn: () => undoMine(iso, ov?.shift ?? null, note) } : null, 6000);
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

async function undoMine(iso, prevShift, prevNote) {
  await withBusy(async () => {
    try {
      const { error } = await sb.rpc('set_my_shift', { p_date: iso, p_shift: prevShift });
      if (error) throw error;
      await writeNote(iso, prevNote?.memo || null, prevNote?.vacation_type || null);
      await loadMonth();
      renderApp();
      toast('되돌렸어요');
    } catch (e) { toastErr(e); }
  });
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
    const vac = state.members.filter((mem) => shiftOf(mem, iso).shift === 'V').length;
    const mine = shiftOf(state.me, iso);
    const dow = S.fromISO(iso).getDay();
    return `<button class="cell tcell ${iso === today ? 'today' : ''}" data-action="team-day" data-iso="${iso}">
      <span class="dnum ${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}">${+iso.slice(8)}</span>
      <span class="duty"><i class="d">${duty.D.join('')}</i><i class="n">${duty.N.join('')}</i></span>
      ${open ? `<span class="pill open">대근${open}</span>` : filled ? `<span class="pill filled">확정${filled}</span>` : vac ? `<span class="pill vac">휴가${vac}</span>` : ''}
      ${mine.shift === 'D' || mine.shift === 'N' ? `<i class="me-dot s-${mine.shift}"></i>` : ''}
    </button>`;
  }).join('');
  const up = state.upcoming.slice(0, 8).map((r) => `<button class="req-chip" data-action="goto-req" data-iso="${r.work_date}">
      <b>${S.formatDay(r.work_date)}</b> ${S.SHIFT_INFO[r.shift].label} · ${esc(memberName(r.requester_id))}
      <span class="muted">지원 ${(state.volunteers.get(r.id) || []).length}</span></button>`).join('');
  return `<header class="top"><div><h1>팀 달력</h1>
      <p class="muted">${esc(state.team.factory_name)} · ${esc(state.team.ban_name)}반 · ${state.members.length}명</p></div>
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
  const groups = { D: [], N: [], O: [], V: [] };
  for (const mem of state.members) {
    const s = shiftOf(mem, iso);
    groups[s.shift].push({ mem, ...s });
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
      return `<li><span>${esc(mm?.display_name ?? '(나간 사람)')} <small>${mm?.jo ?? ''}조</small></span>${confirmBtn}</li>`;
    }).join('')}</ul>` : (r.status === 'open' ? '<p class="muted small-note">아직 지원자가 없어요</p>' : '');
    const req = state.memberMap.get(r.requester_id);
    return `<div class="req-card ${r.status}">
      <div class="req-head"><b>${esc(req?.display_name ?? '(나간 사람)')}</b> <small>${req?.jo ?? ''}조</small>
        <span class="tag s-${r.shift}">${S.SHIFT_INFO[r.shift].label} 휴가</span>
        ${r.status === 'open' ? '<span class="tag open">대근 필요</span>' : `<span class="tag filled">대근 확정 · ${esc(memberName(r.filled_by))}</span>`}</div>
      ${r.status === 'open' ? volList : ''}
      ${actions ? `<div class="req-actions">${actions}</div>` : ''}
    </div>`;
  };

  const byJo = (list) => S.JOS.map((jo) => {
    const ps = list.filter((x) => x.mem.jo === jo);
    if (!ps.length) return '';
    return `<div class="jo-row"><span class="jo-tag">${jo}조</span>${ps.map((x) => `<span class="person ${x.mem.user_id === state.user.id ? 'me' : ''}">
      ${esc(x.mem.display_name)}${x.isCover ? '<em class="cover-tag">대근</em>' : x.changed ? '<em>변경</em>' : ''}</span>`).join('')}</div>`;
  }).join('') || '<p class="muted small-note">없음</p>';

  const reqUserIds = new Set(reqs.map((r) => r.requester_id));
  const otherVac = groups.V.filter((x) => !reqUserIds.has(x.mem.user_id));
  const duty = S.josOnDuty(state.team, iso);

  const sh = openSheet(`
    <h3>${S.formatDay(iso)} <small class="muted">주간 ${duty.D.join('')}조 · 야간 ${duty.N.join('')}조</small></h3>
    ${reqs.length || otherVac.length ? `<section class="sec"><h4>휴가 · 대근</h4>
      ${reqs.map(reqCard).join('')}
      ${otherVac.map((x) => `<div class="req-card plain"><b>${esc(x.mem.display_name)}</b> <small>${x.mem.jo}조</small> <span class="tag">휴가 (쉬는 날)</span></div>`).join('')}
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
  const ms = S.periodStats(state.team, state.me.jo, start, end, map);
  const ys = S.periodStats(state.team, state.me.jo, `${y}-01-01`, `${y}-12-31`, map);
  const tile = (label, val, unit = '', sub = '') => `<div class="tile"><span class="muted">${label}</span><b>${val}<small>${unit}</small></b>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;

  const memberRows = S.JOS.map((jo) => {
    const ps = state.members.filter((mm) => mm.jo === jo);
    if (!ps.length) return '';
    return `<div class="jo-row"><span class="jo-tag">${jo}조</span>${ps.map((mm) => `<button class="person ${mm.user_id === state.user.id ? 'me' : ''}"
      ${isAdmin() && mm.user_id !== state.user.id ? `data-action="member" data-uid="${mm.user_id}"` : 'disabled'}>
      ${esc(mm.display_name)}${mm.role === 'admin' ? '<em>관리자</em>' : ''}</button>`).join('')}</div>`;
  }).join('');

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const install = standalone ? '' : state.installPrompt
    ? '<button class="btn ghost block" data-action="install">홈 화면에 앱 설치</button>'
    : isIOS ? '<p class="note">홈 화면에 추가하려면 Safari 하단 <b>공유</b> 버튼 → <b>홈 화면에 추가</b>를 누르세요.</p>' : '';

  root.innerHTML = `
    <header class="top"><div><h1>${esc(state.me.display_name)} <small>${state.me.jo}조</small></h1>
      <p class="muted">${esc(state.team.factory_name)} · ${esc(state.team.ban_name)}반 ${isAdmin() ? '· 관리자' : ''}</p></div>
      <button class="chip-btn" data-action="edit-profile">수정</button></header>
    ${monthNav(state.infoYm, 'info-month')}
    <div class="tiles">
      ${tile('총 근무', ms.workHours, '시간', `${ms.workDays}일`)}
      ${tile('주간 / 야간', `${ms.day} / ${ms.night}`, '회')}
      ${tile('야간 시간 (22~06시)', ms.nightHours, '시간')}
      ${tile('대근', ms.cover, '회', `${ms.coverHours}시간`)}
      ${tile('휴가', ms.vacation, '일')}
      ${tile(`${y}년 누적`, `휴가 ${ys.vacation}일`, '', `대근 ${ys.cover}회`)}
    </div>
    <p class="note">근무표 기준 <b>참고용</b> 계산입니다 (주간 10시간, 야간 14시간). 연장근무·실제 급여와 다를 수 있어요.</p>

    <section class="card">
      <h4>팀 초대 코드</h4>
      <div class="code-row"><code class="invite">${esc(state.team.invite_code)}</code>
        <button class="btn primary sm" data-action="copy-code">공유</button></div>
      <p class="muted small-note">같은 공장·같은 반 동료에게만 보내 주세요.</p>
    </section>
    <section class="card"><h4>팀원 ${state.members.length}명 ${isAdmin() ? '<small class="muted">이름을 누르면 관리</small>' : ''}</h4>${memberRows}</section>
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
      <div class="field"><span class="field-label">조</span>${joSelect('jo', state.me.jo)}</div>
      <p class="note">조를 바꾸면 기본 근무표가 새 조 기준으로 바뀝니다.</p>
      <div class="row-btns"><button type="button" class="btn ghost" data-close>취소</button><button class="btn primary">저장</button></div>
    </form>`, { type: 'profile' });
  sh.querySelector('[data-close]').onclick = closeSheet;
  sh.querySelector('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await withBusy(async () => {
      try {
        const { error } = await sb.rpc('update_my_profile', { p_display_name: f.get('name'), p_jo: f.get('jo') });
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
      <label>오늘(${S.formatDay(t)}) A조 근무<select name="apos">${posOptions(curPos)}</select></label>
      <p class="note preview">${previewText(curPos)}</p>
      <div class="row-btns"><button type="button" class="btn ghost" data-newcode>초대 코드 새로 만들기</button></div>
      <div class="row-btns"><button type="button" class="btn ghost" data-close>취소</button><button class="btn primary">저장</button></div>
    </form>`, { type: 'settings' });
  const form = sh.querySelector('#tf');
  wireBanField(form);
  const sel = form.querySelector('select[name=apos]');
  sel.onchange = () => { form.querySelector('.preview').innerHTML = previewText(+sel.value); };
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

function openMemberSheet(uid) {
  const mm = state.memberMap.get(uid);
  if (!mm) return;
  const sh = openSheet(`<h3>${esc(mm.display_name)} <small class="muted">${mm.jo}조</small></h3>
    <div class="stack">
      <button class="btn ghost block" data-role>${mm.role === 'admin' ? '관리자 해제' : '관리자로 지정 (주임 등)'}</button>
      <button class="btn danger-ghost block" data-remove>팀에서 내보내기</button>
      <button class="btn ghost block" data-close>닫기</button>
    </div>`, { type: 'member' });
  sh.querySelector('[data-close]').onclick = closeSheet;
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
