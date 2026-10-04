-- =====================================================================
--  مناقيش — Migration 0006
--  إعدادات مظهر النظام (الألوان والخطوط وأبعاد الجدول)
--
--  HOW TO RUN
--    Supabase Dashboard -> SQL Editor -> New query -> paste all -> Run.
--  Idempotent: safe to run more than once.
--
--  WHY
--  ---
--  The manager can tune the site's colours, fonts, and table geometry
--  from a settings page instead of editing CSS. All of it lives in ONE
--  row of ONE table as a JSON document, read by the root layout on every
--  request and validated in lib/appearance.ts before it reaches CSS.
--
--  There is deliberately no member-facing write path: the table has no
--  INSERT/UPDATE policy for `authenticated`, so even the manager's own
--  JWT cannot write it — saves go through the dashboard's service-role
--  client after `canChangePostAuthor`-style rbac checks (admin only).
-- =====================================================================

create table if not exists public.site_settings (
  id         integer primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.site_settings enable row level security;

drop policy if exists site_settings_select on public.site_settings;

-- Every signed-in member's browser needs the values (the root layout is
-- server-rendered from the service client, but keep the read policy so
-- the Data API stays consistent with the other tables).
create policy site_settings_select on public.site_settings
  for select to authenticated
  using (true);

-- ---------------------------------------------------------------------
-- Grants. Explicit, matching the 2026-10-30 Data API change documented
-- in 0001: no member-writable path, service role does everything.
-- ---------------------------------------------------------------------
revoke all on public.site_settings from anon;
grant select on public.site_settings to authenticated;
grant all    on public.site_settings to service_role;

-- Seed the row so a later UPDATE (not only upsert) always has a target.
insert into public.site_settings (id, data)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

comment on table public.site_settings is
  'إعدادات مظهر النظام في صف واحد: الألوان والخطوط وأبعاد خلايا الجدول. الكتابة عبر مفتاح الخدمة فقط من قبل المدير.';
