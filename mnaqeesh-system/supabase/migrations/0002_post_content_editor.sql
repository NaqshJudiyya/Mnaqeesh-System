-- =====================================================================
--  مناقيش — Migration 0002
--  محرّر Markdown داخل النظام
--
--  HOW TO RUN
--    Supabase Dashboard -> SQL Editor -> New query -> paste all -> Run.
--  Idempotent: safe to run more than once.
--
--  WHY THIS EXISTS
--  ---------------
--  The extension ships its own Markdown editor and writes the result to
--  `markdown_text` locally. On its very first sync it does send that
--  value, but every later sync is sent with
--  `Prefer: resolution=ignore-duplicates`, i.e. ON CONFLICT DO NOTHING.
--  So an edit made in the extension never updates the server row.
--
--  The server therefore needs its OWN edited copy, which is what these
--  two columns hold. They are system-owned: the extension never sends
--  them and can never overwrite them.
--
--  Precedence used by the dashboard and every export:
--    1. edited_markdown      (edited inside مناقيش)
--    2. markdown_text        (Markdown the extension saved)
--    3. text                 (raw scraped text)
-- =====================================================================

alter table public.posts
  add column if not exists edited_markdown text,
  add column if not exists edited_text     text,
  add column if not exists edited_at       timestamptz,
  add column if not exists edited_by       uuid references public.profiles (id) on delete set null;

comment on column public.posts.edited_markdown is 'نص Markdown بعد التعديل من داخل نظام مناقيش (له الأولوية على markdown_text).';
comment on column public.posts.edited_text     is 'النص الأصلي بعد التعديل من داخل النظام.';
comment on column public.posts.edited_by       is 'من قام بآخر تعديل على المحتوى داخل النظام.';

-- Speeds up "which posts have been edited?" filters.
create index if not exists posts_edited_idx on public.posts (edited_at desc)
  where edited_at is not null;

-- ---------------------------------------------------------------------
-- The verifier the policies below rely on.
-- `is_active_member()` was added by migration 0001; re-create it here so
-- 0002 also works if someone runs it against a database where 0001 was
-- applied from an older revision of the file.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- Grants: the dashboard never writes content columns through the user's
-- own JWT (it uses the service-role client after an rbac check), but the
-- SELECT grant must include the new columns. Nothing to change for
-- INSERT because the extension cannot send these fields.
-- ---------------------------------------------------------------------
grant select on public.posts to authenticated;
grant all    on public.posts to service_role;
