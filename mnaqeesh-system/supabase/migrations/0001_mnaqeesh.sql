-- =====================================================================
--  مناقيش — Mnaqeesh central system
--  Migration 0001 — schema, roles, RLS, RPCs
--
--  HOW TO RUN
--    Supabase Dashboard -> SQL Editor -> New query -> paste all -> Run.
--  This file is idempotent; re-running it is safe.
--
--  ARCHITECTURE NOTE (read this before changing the schema)
--  -------------------------------------------------------
--  The extension (Facebook Post Saver v2.13.0) does NOT call a Next.js
--  API. Its service worker talks straight to Supabase:
--
--    POST   {api}/auth/v1/token?grant_type=refresh_token
--    POST   {api}/rest/v1/posts?on_conflict=user_id,post_key
--    DELETE {api}/rest/v1/posts?post_key=eq.<key>
--
--  Therefore this schema is a public contract with the extension and
--  MUST keep these exact column names:
--
--    user_id, post_key, author, post_date, post_time, privacy, text,
--    markdown_text, image_urls, image_direct_urls, video_url,
--    video_direct_url, post_url, saved_at
--
--  Two traps this schema deliberately defends against:
--    1. The client never sends `user_id`, yet it is the conflict
--       target. So `user_id` defaults to auth.uid() and RLS pins it.
--    2. The client's DELETE filters on post_key ALONE, with no user
--       filter. RLS is the only thing stopping one member's extension
--       from deleting another member's posts. See saved_posts_delete.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- 1) Enums
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'mnaqeesh_role') then
    create type public.mnaqeesh_role as enum ('admin', 'editor', 'collector', 'translator');
  end if;
  if not exists (select 1 from pg_type where typname = 'mnaqeesh_status') then
    create type public.mnaqeesh_status as enum ('pending', 'active', 'disabled');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2) profiles — one row per user, role set ONLY by the manager
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key,
  email       text        not null default '',
  full_name   text        not null default '',
  avatar_url  text        not null default '',
  role        public.mnaqeesh_role   not null default 'collector',
  status      public.mnaqeesh_status not null default 'pending',
  note        text        not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists profiles_role_idx   on public.profiles (role);
create index if not exists profiles_status_idx on public.profiles (status);

-- ---------------------------------------------------------------------
-- 3) posts — EXACT extension contract + system extras
--
--    Columns up to `saved_at` are the extension's 13 keys; `user_id` is
--    the 14th and is defaulted from the JWT because the client omits it.
--    Everything below `saved_at` is system-only and never sent by the
--    extension, so it must all be nullable or defaulted.
--
--    Note on `resolution=ignore-duplicates`: the extension asks for
--    ON CONFLICT DO NOTHING. Server-side re-saves therefore never
--    clobber a row, which is why in-app edits live in `editor_note`,
--    `status`, and the `translations` table instead of here.
-- ---------------------------------------------------------------------
create table if not exists public.posts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid()
                       references public.profiles (id) on delete cascade,
  post_key           text not null,
  author             text not null default '',
  post_date          text not null default '',
  post_time          text not null default '',
  privacy            text not null default 'unknown',
  text               text not null default '',
  markdown_text      text not null default '',
  image_urls         jsonb not null default '[]'::jsonb,
  image_direct_urls  jsonb not null default '[]'::jsonb,
  video_url          text not null default '',
  video_direct_url   text not null default '',
  post_url           text not null default '',
  saved_at           timestamptz not null default now(),
  -- system extras -----------------------------------------------------
  status             text not null default 'new',
  editor_note        text not null default '',
  deleted_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Required by PostgREST's on_conflict=user_id,post_key
create unique index if not exists posts_user_id_post_key_key
  on public.posts (user_id, post_key);

create index if not exists posts_user_idx    on public.posts (user_id);
create index if not exists posts_saved_idx   on public.posts (saved_at desc);
create index if not exists posts_live_idx    on public.posts (deleted_at);
create index if not exists posts_author_idx  on public.posts (author);
create index if not exists posts_status_idx  on public.posts (status);

-- ---------------------------------------------------------------------
-- 4) languages + translations
--    Languages are added incrementally from inside the system: pressing
--    "إضافة ترجمة" lets the translator name a new language, and that
--    language becomes available for every post.
-- ---------------------------------------------------------------------
create table if not exists public.languages (
  code        text primary key,
  name_ar     text not null default '',
  name_en     text not null default '',
  is_default  boolean not null default false,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.translations (
  id              uuid primary key default gen_random_uuid(),
  post_id         uuid not null references public.posts (id) on delete cascade,
  language_code   text not null references public.languages (code) on delete restrict,
  title           text not null default '',
  translated_text text not null default '',
  body_markdown   text not null default '',
  translator_id   uuid references public.profiles (id) on delete set null,
  is_complete     boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists translations_post_language_key
  on public.translations (post_id, language_code);
create index if not exists translations_language_idx on public.translations (language_code);
create index if not exists translations_post_idx     on public.translations (post_id);

insert into public.languages (code, name_ar, name_en, is_default) values
  ('en', 'الإنجليزية',  'English',    true),
  ('fr', 'الفرنسية',   'French',     false),
  ('tr', 'التركية',    'Turkish',    false),
  ('ur', 'الأردية',    'Urdu',       false),
  ('id', 'الإندونيسية', 'Indonesian', false),
  ('es', 'الإسبانية',  'Spanish',    false),
  ('de', 'الألمانية',  'German',     false)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- 5) audit log — admin-only visibility over who changed what
-- ---------------------------------------------------------------------
create table if not exists public.activity_log (
  id          bigserial primary key,
  actor_id    uuid references public.profiles (id) on delete set null,
  actor_email text not null default '',
  action      text not null default '',
  entity      text not null default '',
  entity_id   text not null default '',
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists activity_log_created_idx on public.activity_log (created_at desc);

-- ---------------------------------------------------------------------
-- 6) updated_at maintenance
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists posts_touch on public.posts;
create trigger posts_touch before update on public.posts
  for each row execute function public.touch_updated_at();

-- Ownership must never move after insert.
--
-- Without this, `posts_update_scope`'s WITH CHECK would happily accept an
-- UPDATE that rewrites `user_id`: the new row still satisfies "the row is
-- mine" only if the value is mine, but a member could instead hand their
-- post to somebody else (or claim one from a member whose id they guess).
-- The check belongs on the column, because RLS evaluates rows, not deltas.
create or replace function public.prevent_post_owner_change()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'لا يمكن تغيير صاحب المنشور بعد حفظه.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists posts_owner_immutable on public.posts;
create trigger posts_owner_immutable before update on public.posts
  for each row execute function public.prevent_post_owner_change();

drop trigger if exists translations_touch on public.translations;
create trigger translations_touch before update on public.translations
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 7) Auto-provision a profile on signup.
--    New accounts start as collector + pending, so a random Google
--    account CANNOT read or write anything until the manager activates
--    it and assigns a role.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url, role, status)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', ''),
    'collector',
    'pending'
  )
  on conflict (id) do update
    set email      = excluded.email,
        full_name  = case when public.profiles.full_name = '' then excluded.full_name else public.profiles.full_name end,
        avatar_url = case when public.profiles.avatar_url = '' then excluded.avatar_url else public.profiles.avatar_url end;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for accounts that already exist in auth
insert into public.profiles (id, email, full_name, avatar_url, role, status)
select
  u.id,
  coalesce(u.email, ''),
  coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', ''),
  coalesce(u.raw_user_meta_data ->> 'avatar_url', ''),
  'collector',
  'pending'
from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 8) Bootstrap the manager.
--    Sign in once with Google, then run in the SQL editor:
--      select public.promote_admin('you@gmail.com');
-- ---------------------------------------------------------------------
create or replace function public.promote_admin(p_email text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.profiles where lower(email) = lower(trim(p_email)) limit 1;
  if v_id is null then
    return 'لا يوجد حساب بهذا البريد. سجّل الدخول بالموقع أولًا ثم أعد المحاولة.';
  end if;
  update public.profiles set role = 'admin', status = 'active' where id = v_id;
  return 'تم ترقية ' || p_email || ' إلى مدير نظام مفعّل.';
end $$;

-- SECURITY: lock the bootstrap helper down.
--
-- Postgres grants EXECUTE on a new function to PUBLIC, and PostgREST
-- exposes every function in the exposed schema at /rest/v1/rpc/<name>.
-- Left alone, `promote_admin` would be callable by ANYONE holding the
-- publishable key — which ships inside the extension — letting an
-- attacker promote their own fresh account to manager without even
-- logging in. `security definer` runs it as the table owner, so RLS is
-- bypassed inside it.
--
-- Revoking from PUBLIC is not enough on its own, because `anon` and
-- `authenticated` are siblings that receive their own grants; revoke
-- from each of them explicitly.
revoke execute on function public.promote_admin(text) from public;
revoke execute on function public.promote_admin(text) from anon;
revoke execute on function public.promote_admin(text) from authenticated;

-- It stays callable from the Supabase SQL editor (postgres) and by the
-- server-side service role, which is where bootstrapping belongs.

-- =====================================================================
-- 9) ROW LEVEL SECURITY
--
--    The extension holds a real Supabase JWT (role `authenticated`), so
--    these policies are ENFORCED against it, not merely advisory.
--    The Next.js dashboard uses the service-role key for admin
--    operations and enforces role rules in lib/rbac.ts; these policies
--    are the outer wall.
-- =====================================================================

alter table public.profiles     enable row level security;
alter table public.posts        enable row level security;
alter table public.languages    enable row level security;
alter table public.translations enable row level security;
alter table public.activity_log enable row level security;

-- Helper used by the policies below.
create or replace function public.has_role(variadic p_roles public.mnaqeesh_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.status = 'active'
       and p.role = any (p_roles)
  );
$$;

-- Helper: is the caller a member the manager has actually activated?
--
-- `has_role()` already implies active, but the "own row" branches below
-- need the same guarantee: without this, a `pending` or `disabled`
-- account still holding a refresh token could keep writing to (and
-- deleting from) the archive through the extension.
create or replace function public.is_active_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.status = 'active'
  );
$$;

drop policy if exists profiles_select_self   on public.profiles;
drop policy if exists profiles_select_admin  on public.profiles;
drop policy if exists profiles_admin_write   on public.profiles;

-- Defensive: remove the guard trigger from any earlier revision of this
-- file that installed it, so the migration is safe to re-run.
drop trigger if exists profiles_guard_privileges on public.profiles;
drop function if exists public.prevent_self_privilege_escalation();

drop policy if exists saved_posts_select       on public.posts;
drop policy if exists saved_posts_insert_own   on public.posts;
drop policy if exists saved_posts_update_scope on public.posts;
drop policy if exists saved_posts_delete_scope on public.posts;
drop policy if exists posts_select_scope       on public.posts;
drop policy if exists posts_insert_own         on public.posts;
drop policy if exists posts_update_scope       on public.posts;
drop policy if exists posts_delete_scope       on public.posts;

drop policy if exists languages_select on public.languages;
drop policy if exists languages_insert on public.languages;
drop policy if exists languages_delete on public.languages;

drop policy if exists translations_select on public.translations;
drop policy if exists translations_write  on public.translations;

drop policy if exists activity_log_select_admin on public.activity_log;

-- profiles ------------------------------------------------------------
-- A user reads only their own profile. This is what enforces the
-- Editor/Translator rule "cannot see the other members" at DB level.
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

-- The manager reads everyone.
create policy profiles_select_admin on public.profiles
  for select to authenticated
  using (public.has_role('admin'));

-- NOTE: there is deliberately NO update policy for `authenticated` here,
-- and NO update grant either (see the grants section below).
--
-- SECURITY: an earlier revision of this file had a
-- `profiles_update_self ... using (id = auth.uid())` policy together with
-- `grant update on public.profiles to authenticated`. That combination is
-- a full privilege-escalation hole: RLS constrains ROWS, not COLUMNS, so
-- any member (including a brand-new `pending` account) could run
--
--   PATCH /rest/v1/profiles?id=eq.<own-uid>   {"role":"admin","status":"active"}
--
-- and promote themselves, voiding the whole "the manager activates
-- accounts by hand" model. A `with check` subquery on the same table is
-- not a valid fix either, because it re-enters RLS on `profiles`.
-- The safe design is to have no member-writable path to this table at
-- all: role and status changes go exclusively through the dashboard's
-- service-role client, which enforces `canManageMembers()` in lib/rbac.ts.
drop policy if exists profiles_update_self on public.profiles;

create policy profiles_admin_write on public.profiles
  for all to authenticated
  using (public.has_role('admin'))
  with check (public.has_role('admin'));

-- posts ---------------------------------------------------------------
-- Read scope:
--   collector  -> own rows only
--   translator -> all rows (needs the source text to translate)
--   editor     -> all rows
--   admin      -> all rows
-- Every branch also requires an ACTIVE account, so a disabled member
-- stops seeing even their own archive immediately.
create policy posts_select_scope on public.posts
  for select to authenticated
  using (
    public.is_active_member()
    and (
      user_id = auth.uid()
      or public.has_role('admin', 'editor', 'translator')
    )
  );

-- The extension sends no user_id, so the DEFAULT auth.uid() supplies it
-- and this check makes sure it can only ever be the caller's own id.
-- The active check is what actually enforces "the manager activates
-- accounts by hand": a pending account's extension cannot write.
create policy posts_insert_own on public.posts
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_active_member());

create policy posts_update_scope on public.posts
  for update to authenticated
  using (user_id = auth.uid() or public.has_role('admin', 'editor'))
  with check (user_id = auth.uid() or public.has_role('admin', 'editor'));

-- CRITICAL: the extension's DELETE is
--   DELETE /rest/v1/posts?post_key=eq.<key>
-- with no user filter. Without `user_id = auth.uid()` here, any member
-- could delete any other member's posts; without the active check, a
-- member the manager just disabled could still wipe their archive.
create policy posts_delete_scope on public.posts
  for delete to authenticated
  using (
    public.is_active_member()
    and (user_id = auth.uid() or public.has_role('admin'))
  );

-- languages -----------------------------------------------------------
create policy languages_select on public.languages
  for select to authenticated using (true);

create policy languages_insert on public.languages
  for insert to authenticated
  with check (public.has_role('admin', 'editor', 'translator'));

-- Adding a language is a translator action, but removing one is a
-- system-level act. Without this policy the DELETE grant below would be
-- inert: RLS denies by returning zero rows, which the dashboard reports
-- as a silent no-op rather than an error.
create policy languages_delete on public.languages
  for delete to authenticated
  using (public.has_role('admin'));

-- translations --------------------------------------------------------
-- A translation must not be readable through the REST API by someone who
-- cannot see the post it belongs to. `using (true)` would have let a
-- collector read the translations of other members' posts.
create policy translations_select on public.translations
  for select to authenticated
  using (
    public.has_role('admin', 'editor', 'translator')
    or exists (
      select 1 from public.posts p
       where p.id = translations.post_id
         and p.user_id = auth.uid()
    )
  );

create policy translations_write on public.translations
  for all to authenticated
  using (public.has_role('admin', 'editor', 'translator'))
  with check (public.has_role('admin', 'editor', 'translator'));

-- activity_log --------------------------------------------------------
create policy activity_log_select_admin on public.activity_log
  for select to authenticated
  using (public.has_role('admin'));

-- ---------------------------------------------------------------------
-- 10) Grants for the Data API.
--
--  WHY THIS SECTION IS EXPLICIT
--  ----------------------------
--  Supabase used to auto-grant table access to the Data API roles
--  (`anon`, `authenticated`, `service_role`). That implicit behaviour is
--  being removed — for existing projects on 2026-10-30 — after which a
--  table without explicit GRANTs returns PostgREST error 42501 even
--  though RLS is satisfied. So every grant this system needs is spelled
--  out below, which also makes the intended access model auditable.
--
--  Role map:
--    anon          -> the publishable key shipped inside the extension.
--                     NOTHING. It must be powerless because it is public.
--    authenticated -> a signed-in member's own JWT. The extension writes
--                     posts with this role; the dashboard reads with it.
--                     RLS decides which rows, the grants decide which verbs.
--    service_role  -> the server-side key used by the Next.js dashboard.
--                     Full access (it also bypasses RLS).
-- ---------------------------------------------------------------------

-- The public key must never reach these tables.
revoke all on public.profiles     from anon;
revoke all on public.posts        from anon;
revoke all on public.languages    from anon;
revoke all on public.translations from anon;
revoke all on public.activity_log from anon;

-- Only the server touches the audit log's writer side.
revoke all on public.activity_log from authenticated;

-- The member dashboard (server components + route handlers) reads with
-- the member's own JWT, so `authenticated` needs SELECT where RLS allows.
-- The extension needs INSERT (save), UPDATE (re-save), DELETE (remove).
--
-- Note the absence of any write grant on `profiles`: members can never
-- change their own role or status.
grant select                         on public.profiles     to authenticated;
grant select, insert, update, delete on public.posts        to authenticated;
grant select, insert, update, delete on public.translations to authenticated;
grant select, insert                on public.languages    to authenticated;
grant delete                        on public.languages    to authenticated;
grant select                        on public.activity_log to authenticated;

-- The server-side dashboard key needs everything.
grant all on public.profiles     to service_role;
grant all on public.posts        to service_role;
grant all on public.languages    to service_role;
grant all on public.translations to service_role;
grant all on public.activity_log to service_role;

-- Sequences backing the audit log's bigserial id.
grant usage, select on all sequences in schema public to service_role, authenticated;

-- ---------------------------------------------------------------------
-- 11) Useful indexes for the dashboard's text search
-- ---------------------------------------------------------------------
create index if not exists posts_text_search_idx on public.posts
  using gin (to_tsvector('simple',
    coalesce(text, '') || ' ' || coalesce(markdown_text, '') || ' ' || coalesce(author, '')));

comment on table public.posts        is 'منشورات فيسبوك المحفوظة المرفوعة من إضافة Facebook Post Saver.';
comment on table public.translations is 'ترجمات المنشورات — ترجمة واحدة لكل لغة لكل منشور.';
comment on table public.languages    is 'اللغات المتاحة للترجمة، تُضاف تدريجيًا من داخل النظام.';
comment on table public.profiles     is 'حسابات النظام. الدور والحالة يحددهما المدير فقط.';
