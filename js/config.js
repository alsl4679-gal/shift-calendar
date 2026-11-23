// Supabase 연결 정보 (publishable 키는 공개돼도 되는 키 — 데이터는 RLS로 보호됨)
export const SUPABASE_URL = 'https://iamwciscebbqhsuauitz.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_UkjaHm7355Blx5kvLUAE1g_Bdtk5QDw';

// 직번 로그인용 내부 주소: "직번@이 도메인" 으로 계정을 만든다 (메일은 보내지 않음)
export const LOGIN_DOMAIN = 'iamwciscebbqhsuauitz.supabase.co';

// 회사 공통 근무 기준 (A~D조 고정)
// 2026-11-23 = C조 주간 1일차 → A조는 8일 주기의 7번째 날(위치 6, 야간 후 휴무 1일차)
export const COMPANY_ANCHOR = { anchor_date: '2026-11-23', a_pos: 6 };

export const DEFAULT_FACTORY = '3선재공장';
