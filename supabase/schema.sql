-- 교대달력 DB 구조 (Supabase 프로젝트 shift-calendar 에 이미 적용됨)
-- 새 프로젝트에 다시 만들 때만 SQL Editor에서 실행하세요.
-- 적용 이력: init_shift_schema, lock_internal_functions (대시보드 Database > Migrations 에서도 확인 가능)

-- ===== Tables =====
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  factory_name text not null check (char_length(factory_name) between 1 and 40),
  ban_name text not null check (char_length(ban_name) between 1 and 20),
  invite_code text not null unique,
  anchor_date date not null,
  a_pos smallint not null check (a_pos between 0 and 7),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 20),
  jo text not null check (jo in ('A','B','C','D')),
  role text not null default 'member' check (role in ('admin','member')),
  created_at timestamptz not null default now()
);
create index members_team_idx on public.members(team_id);

create table public.cover_requests (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  requester_id uuid not null references public.members(user_id) on delete cascade,
  work_date date not null,
  shift text not null check (shift in ('D','N')),
  status text not null default 'open' check (status in ('open','filled','cancelled')),
  filled_by uuid references public.members(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (requester_id, work_date)
);
create index cover_requests_team_date_idx on public.cover_requests(team_id, work_date);

create table public.day_overrides (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.members(user_id) on delete cascade,
  work_date date not null,
  shift text not null check (shift in ('D','N','O','V')),
  is_cover boolean not null default false,
  cover_request_id uuid references public.cover_requests(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (user_id, work_date)
);
create index day_overrides_team_date_idx on public.day_overrides(team_id, work_date);

create table public.cover_volunteers (
  request_id uuid not null references public.cover_requests(id) on delete cascade,
  user_id uuid not null references public.members(user_id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (request_id, user_id)
);
create index cover_volunteers_team_idx on public.cover_volunteers(team_id);

-- 개인 메모·휴가 사유: 본인만 보임
create table public.personal_notes (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  work_date date not null,
  memo text check (memo is null or char_length(memo) <= 500),
  vacation_type text check (vacation_type is null or char_length(vacation_type) <= 20),
  updated_at timestamptz not null default now(),
  primary key (user_id, work_date)
);

-- ===== Helpers =====
create or replace function public.my_team_id() returns uuid
language sql stable security definer set search_path = public as $$
  select team_id from public.members where user_id = auth.uid()
$$;

create or replace function public.base_shift(p_team uuid, p_jo text, p_date date) returns text
language sql stable security definer set search_path = public as $$
  -- 8일 주기: 주주휴휴야야휴휴 / A=0, B=6, C=2, D=4 (A조 기준 위치 차이)
  select (array['D','D','O','O','N','N','O','O'])[
    ((( t.a_pos
        + case p_jo when 'A' then 0 when 'B' then 6 when 'C' then 2 when 'D' then 4 end
        + (p_date - t.anchor_date)) % 8) + 8) % 8 + 1 ]
  from public.teams t where t.id = p_team
$$;

create or replace function public.effective_shift(p_user uuid, p_date date) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select o.shift from public.day_overrides o where o.user_id = p_user and o.work_date = p_date),
    (select public.base_shift(m.team_id, m.jo, p_date) from public.members m where m.user_id = p_user))
$$;

create or replace function public._gen_invite_code() returns text
language plpgsql security definer set search_path = public as $$
declare
  c text;
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i int;
begin
  loop
    c := '';
    for i in 1..6 loop
      c := c || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    end loop;
    exit when not exists (select 1 from public.teams where invite_code = c);
  end loop;
  return c;
end $$;

create or replace function public._me() returns public.members
language plpgsql stable security definer set search_path = public as $$
declare m public.members;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
  select * into m from public.members where user_id = auth.uid();
  if not found then raise exception '팀에 먼저 참여해 주세요'; end if;
  return m;
end $$;

create or replace function public._cancel_request(p_req uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.day_overrides where cover_request_id = p_req and is_cover;
  delete from public.cover_volunteers where request_id = p_req;
  update public.cover_requests
     set status = 'cancelled', filled_by = null, updated_at = now()
   where id = p_req;
end $$;

create or replace function public._on_member_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.cover_requests
     set status = 'open', filled_by = null, updated_at = now()
   where filled_by = old.user_id and status = 'filled';
  return old;
end $$;
create trigger members_before_delete before delete on public.members
  for each row execute function public._on_member_delete();

-- ===== RLS =====
alter table public.teams enable row level security;
alter table public.members enable row level security;
alter table public.cover_requests enable row level security;
alter table public.day_overrides enable row level security;
alter table public.cover_volunteers enable row level security;
alter table public.personal_notes enable row level security;

create policy teams_select on public.teams for select to authenticated using (id = public.my_team_id());
create policy members_select on public.members for select to authenticated using (team_id = public.my_team_id());
create policy cover_requests_select on public.cover_requests for select to authenticated using (team_id = public.my_team_id());
create policy day_overrides_select on public.day_overrides for select to authenticated using (team_id = public.my_team_id());
create policy cover_volunteers_select on public.cover_volunteers for select to authenticated using (team_id = public.my_team_id());
create policy notes_all on public.personal_notes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke insert, update, delete on public.teams, public.members, public.cover_requests,
  public.day_overrides, public.cover_volunteers from anon, authenticated;
revoke all on public.personal_notes from anon;

-- ===== RPC: 팀 =====
create or replace function public.create_team(
  p_factory text, p_ban text, p_display_name text, p_jo text, p_anchor date, p_a_pos int
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_team uuid;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception '이미 팀에 소속되어 있습니다';
  end if;
  insert into public.teams (factory_name, ban_name, invite_code, anchor_date, a_pos, created_by)
  values (trim(p_factory), trim(p_ban), public._gen_invite_code(), p_anchor, p_a_pos, auth.uid())
  returning id into v_team;
  insert into public.members (user_id, team_id, display_name, jo, role)
  values (auth.uid(), v_team, trim(p_display_name), p_jo, 'admin');
  return v_team;
end $$;

create or replace function public.join_team(p_code text, p_display_name text, p_jo text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_team uuid;
begin
  if auth.uid() is null then raise exception '로그인이 필요합니다'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception '이미 팀에 소속되어 있습니다';
  end if;
  select id into v_team from public.teams where invite_code = upper(trim(p_code));
  if v_team is null then raise exception '초대 코드를 찾을 수 없습니다'; end if;
  insert into public.members (user_id, team_id, display_name, jo, role)
  values (auth.uid(), v_team, trim(p_display_name), p_jo, 'member');
  return v_team;
end $$;

create or replace function public.update_my_profile(p_display_name text, p_jo text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.members := public._me();
begin
  update public.members set display_name = trim(p_display_name), jo = p_jo where user_id = m.user_id;
end $$;

create or replace function public.leave_team() returns void
language plpgsql security definer set search_path = public as $$
declare m public.members := public._me();
begin
  if m.role = 'admin'
     and (select count(*) from public.members where team_id = m.team_id and role = 'admin') = 1
     and (select count(*) from public.members where team_id = m.team_id) > 1 then
    raise exception '다른 사람을 관리자로 지정한 뒤 나갈 수 있습니다';
  end if;
  delete from public.members where user_id = m.user_id;
  if not exists (select 1 from public.members where team_id = m.team_id) then
    delete from public.teams where id = m.team_id;
  end if;
end $$;

create or replace function public.set_member_role(p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.members := public._me();
begin
  if m.role <> 'admin' then raise exception '관리자만 할 수 있습니다'; end if;
  if p_role not in ('admin','member') then raise exception '잘못된 권한'; end if;
  if not exists (select 1 from public.members where user_id = p_user and team_id = m.team_id) then
    raise exception '같은 팀 멤버가 아닙니다';
  end if;
  if p_user = m.user_id and p_role = 'member'
     and (select count(*) from public.members where team_id = m.team_id and role = 'admin') = 1 then
    raise exception '마지막 관리자는 해제할 수 없습니다';
  end if;
  update public.members set role = p_role where user_id = p_user;
end $$;

create or replace function public.remove_member(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.members := public._me();
begin
  if m.role <> 'admin' then raise exception '관리자만 할 수 있습니다'; end if;
  if p_user = m.user_id then raise exception '본인은 내보낼 수 없습니다 (팀 나가기 사용)'; end if;
  delete from public.members where user_id = p_user and team_id = m.team_id;
end $$;

create or replace function public.update_team_settings(
  p_factory text, p_ban text, p_anchor date, p_a_pos int
) returns void
language plpgsql security definer set search_path = public as $$
declare m public.members := public._me();
begin
  if m.role <> 'admin' then raise exception '관리자만 할 수 있습니다'; end if;
  update public.teams
     set factory_name = trim(p_factory), ban_name = trim(p_ban), anchor_date = p_anchor, a_pos = p_a_pos
   where id = m.team_id;
end $$;

create or replace function public.regenerate_invite_code() returns text
language plpgsql security definer set search_path = public as $$
declare m public.members := public._me(); v_code text;
begin
  if m.role <> 'admin' then raise exception '관리자만 할 수 있습니다'; end if;
  v_code := public._gen_invite_code();
  update public.teams set invite_code = v_code where id = m.team_id;
  return v_code;
end $$;

-- ===== RPC: 근무 변경 (개인 달력 → 공유 달력 자동 반영) =====
create or replace function public.set_my_shift(p_date date, p_shift text) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.members := public._me();
  v_base text;
  v_prev public.day_overrides;
  v_new_eff text;
  v_req public.cover_requests;
begin
  if p_shift is not null and p_shift not in ('D','N','O','V') then
    raise exception '잘못된 근무 형태입니다';
  end if;
  v_base := public.base_shift(m.team_id, m.jo, p_date);
  select * into v_prev from public.day_overrides where user_id = m.user_id and work_date = p_date;

  if v_prev.id is not null and v_prev.is_cover then
    if p_shift = v_prev.shift then return; end if;
    update public.cover_requests set status = 'open', filled_by = null, updated_at = now()
     where id = v_prev.cover_request_id and status = 'filled';
    delete from public.cover_volunteers where request_id = v_prev.cover_request_id and user_id = m.user_id;
    delete from public.day_overrides where id = v_prev.id;
  end if;

  if p_shift is null or p_shift = v_base then
    delete from public.day_overrides where user_id = m.user_id and work_date = p_date;
  else
    insert into public.day_overrides (team_id, user_id, work_date, shift, is_cover, cover_request_id, updated_at)
    values (m.team_id, m.user_id, p_date, p_shift, false, null, now())
    on conflict (user_id, work_date) do update
      set shift = excluded.shift, is_cover = false, cover_request_id = null, updated_at = now();
  end if;

  v_new_eff := coalesce(p_shift, v_base);
  select * into v_req from public.cover_requests where requester_id = m.user_id and work_date = p_date;

  if v_new_eff = 'V' and v_base in ('D','N') then
    if v_req.id is null then
      insert into public.cover_requests (team_id, requester_id, work_date, shift)
      values (m.team_id, m.user_id, p_date, v_base);
    elsif v_req.status = 'cancelled' then
      update public.cover_requests
         set status = 'open', shift = v_base, filled_by = null, created_at = now(), updated_at = now()
       where id = v_req.id;
    end if;
  elsif v_req.id is not null and v_req.status in ('open','filled') then
    perform public._cancel_request(v_req.id);
  end if;
end $$;

-- ===== RPC: 대근 =====
create or replace function public.volunteer_cover(p_request uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.members := public._me(); r public.cover_requests;
begin
  select * into r from public.cover_requests where id = p_request for update;
  if r.id is null or r.team_id <> m.team_id then raise exception '요청을 찾을 수 없습니다'; end if;
  if r.status <> 'open' then raise exception '이미 마감된 요청입니다'; end if;
  if r.requester_id = m.user_id then raise exception '본인 휴가에는 지원할 수 없습니다'; end if;
  if public.effective_shift(m.user_id, r.work_date) <> 'O' then
    raise exception '그날 근무가 있어 대근 지원이 어렵습니다';
  end if;
  insert into public.cover_volunteers (request_id, user_id, team_id)
  values (r.id, m.user_id, m.team_id) on conflict do nothing;
end $$;

create or replace function public.unvolunteer_cover(p_request uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.members := public._me(); r public.cover_requests;
begin
  select * into r from public.cover_requests where id = p_request for update;
  if r.id is null or r.team_id <> m.team_id then raise exception '요청을 찾을 수 없습니다'; end if;
  if r.filled_by = m.user_id then
    delete from public.day_overrides where cover_request_id = r.id and is_cover;
    update public.cover_requests set status = 'open', filled_by = null, updated_at = now() where id = r.id;
  end if;
  delete from public.cover_volunteers where request_id = r.id and user_id = m.user_id;
end $$;

create or replace function public.confirm_cover(p_request uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.members := public._me(); r public.cover_requests;
begin
  select * into r from public.cover_requests where id = p_request for update;
  if r.id is null or r.team_id <> m.team_id then raise exception '요청을 찾을 수 없습니다'; end if;
  if r.requester_id <> m.user_id and m.role <> 'admin' then
    raise exception '휴가 등록자나 관리자만 확정할 수 있습니다';
  end if;
  if r.status <> 'open' then raise exception '이미 마감된 요청입니다'; end if;
  if not exists (select 1 from public.cover_volunteers where request_id = r.id and user_id = p_user) then
    raise exception '지원자가 아닙니다';
  end if;
  if public.effective_shift(p_user, r.work_date) <> 'O' then
    raise exception '해당 지원자는 그날 근무가 있습니다';
  end if;
  update public.cover_requests set status = 'filled', filled_by = p_user, updated_at = now() where id = r.id;
  insert into public.day_overrides (team_id, user_id, work_date, shift, is_cover, cover_request_id, updated_at)
  values (r.team_id, p_user, r.work_date, r.shift, true, r.id, now())
  on conflict (user_id, work_date) do update
    set shift = excluded.shift, is_cover = true, cover_request_id = excluded.cover_request_id, updated_at = now();
end $$;

create or replace function public.unconfirm_cover(p_request uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.members := public._me(); r public.cover_requests;
begin
  select * into r from public.cover_requests where id = p_request for update;
  if r.id is null or r.team_id <> m.team_id then raise exception '요청을 찾을 수 없습니다'; end if;
  if r.status <> 'filled' then raise exception '확정된 요청이 아닙니다'; end if;
  if r.requester_id <> m.user_id and m.role <> 'admin' and r.filled_by <> m.user_id then
    raise exception '권한이 없습니다';
  end if;
  delete from public.day_overrides where cover_request_id = r.id and is_cover;
  update public.cover_requests set status = 'open', filled_by = null, updated_at = now() where id = r.id;
end $$;

-- ===== 실행 권한 =====
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.my_team_id(),
  public.create_team(text, text, text, text, date, int),
  public.join_team(text, text, text),
  public.update_my_profile(text, text),
  public.leave_team(),
  public.set_member_role(uuid, text),
  public.remove_member(uuid),
  public.update_team_settings(text, text, date, int),
  public.regenerate_invite_code(),
  public.set_my_shift(date, text),
  public.volunteer_cover(uuid),
  public.unvolunteer_cover(uuid),
  public.confirm_cover(uuid, uuid),
  public.unconfirm_cover(uuid)
to authenticated;

-- 내부용 함수는 앱에서 직접 호출 금지 (lock_internal_functions)
revoke execute on function
  public._cancel_request(uuid), public._gen_invite_code(), public._me(), public._on_member_delete(),
  public.base_shift(uuid, text, date), public.effective_shift(uuid, date)
from authenticated, anon, public;

-- ===== Realtime =====
alter publication supabase_realtime add table
  public.members, public.cover_requests, public.day_overrides, public.cover_volunteers;
