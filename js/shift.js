// 근무 계산 로직 (화면과 분리 — 나중에 Dart로 옮기기 쉽게)

// 8일 주기: 주주휴휴야야휴휴
export const PATTERN = ['D', 'D', 'O', 'O', 'N', 'N', 'O', 'O'];

// A조 위치 기준 각 조의 차이 (회사 전체 고정)
// A 주주휴휴야야휴휴 / B 휴휴주주휴휴야야 / C 휴휴야야휴휴주주 / D 야야휴휴주주휴휴
export const JO_OFFSET = { A: 0, B: 6, C: 2, D: 4 };
export const JOS = ['A', 'B', 'C', 'D'];

export const SHIFT_INFO = {
  D: { label: '주간', short: '주', time: '07:00~17:00', hours: 10, nightHours: 0 },
  N: { label: '야간', short: '야', time: '17:00~07:00', hours: 14, nightHours: 8 },
  O: { label: '휴무', short: '휴', time: '', hours: 0, nightHours: 0 },
  V: { label: '휴가', short: '휴가', time: '', hours: 0, nightHours: 0 },
};

// A조가 사이클 몇째 날인지 고를 때 쓰는 이름
export const POS_LABELS = [
  '주간 1일차', '주간 2일차', '휴무 1일차 (주간 후)', '휴무 2일차 (주간 후)',
  '야간 1일차', '야간 2일차', '휴무 1일차 (야간 후)', '휴무 2일차 (야간 후)',
];

const pad = (n) => String(n).padStart(2, '0');

/** 로컬 날짜 → 'YYYY-MM-DD' */
export function toISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DD' → 로컬 Date (자정) */
export function fromISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso, n) {
  const d = fromISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/** 두 날짜 사이 일수 (b - a). 서머타임 영향 없게 UTC로 계산 */
export function daysBetween(aIso, bIso) {
  const [ay, am, ad] = aIso.split('-').map(Number);
  const [by, bm, bd] = bIso.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

const mod = (n, m) => ((n % m) + m) % m;

/** 기본 근무 (패턴만으로 계산) */
export function baseShift(team, jo, iso) {
  const pos = mod(team.a_pos + JO_OFFSET[jo] + daysBetween(team.anchor_date, iso), 8);
  return PATTERN[pos];
}

/** 근무일 기준 '오늘' — 07시 전이면 전날 근무(야간 중)로 본다 */
export function workDateNow(now = new Date()) {
  const d = new Date(now.getTime() - 7 * 3600 * 1000);
  return toISO(d);
}

/** 월 달력 칸 (앞뒤 빈칸 포함, 일요일 시작) */
export function monthGrid(year, month /* 0-11 */) {
  const first = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(toISO(new Date(year, month, d)));
  while (cells.length % 7) cells.push(null);
  return cells;
}

export function monthRange(year, month) {
  return {
    start: toISO(new Date(year, month, 1)),
    end: toISO(new Date(year, month + 1, 0)),
  };
}

/**
 * 실제 근무 = 변경 기록이 있으면 그것, 없으면 기본 패턴
 * override: { shift, is_cover } | undefined
 */
export function effectiveShift(team, jo, iso, override) {
  if (override) return { shift: override.shift, isCover: !!override.is_cover, changed: true };
  return { shift: baseShift(team, jo, iso), isCover: false, changed: false };
}

/**
 * 기간 통계 (참고용)
 * overridesByDate: { 'YYYY-MM-DD': {shift, is_cover} }
 */
export function periodStats(team, jo, startIso, endIso, overridesByDate) {
  const s = { workHours: 0, workDays: 0, day: 0, night: 0, nightHours: 0, cover: 0, coverHours: 0, vacation: 0 };
  const n = daysBetween(startIso, endIso);
  for (let i = 0; i <= n; i++) {
    const iso = addDays(startIso, i);
    const { shift, isCover } = effectiveShift(team, jo, iso, overridesByDate[iso]);
    const info = SHIFT_INFO[shift];
    if (shift === 'D' || shift === 'N') {
      s.workDays++;
      s.workHours += info.hours;
      s.nightHours += info.nightHours;
      if (shift === 'D') s.day++; else s.night++;
      if (isCover) { s.cover++; s.coverHours += info.hours; }
    } else if (shift === 'V') {
      s.vacation++;
    }
  }
  return s;
}

/** 그날 4개 조 중 주간/야간 조 */
export function josOnDuty(team, iso) {
  const out = { D: [], N: [] };
  for (const jo of JOS) {
    const sh = baseShift(team, jo, iso);
    if (sh === 'D' || sh === 'N') out[sh].push(jo);
  }
  return out;
}

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
export function formatDay(iso) {
  const d = fromISO(iso);
  return `${d.getMonth() + 1}/${d.getDate()} (${WEEK[d.getDay()]})`;
}
