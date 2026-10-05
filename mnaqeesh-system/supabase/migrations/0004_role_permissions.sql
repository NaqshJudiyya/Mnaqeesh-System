-- =====================================================================
--  مناقيش — Migration 0004
--  ضبط صلاحيات الأدوار الأربعة
--
--  HOW TO RUN
--    Supabase Dashboard -> SQL Editor -> New query -> paste all -> Run.
--  Idempotent: safe to run more than once.
--
--  WHY THIS FILE EXISTS
--  --------------------
--  0001 already ran against a live database, so editing it would change
--  nothing. This file re-states the post policies with the role model
--  made explicit.
--
--  THE ROLE MODEL (mirrors lib/rbac.ts)
--  ------------------------------------
--
--   admin      full access and control over everything.
--
--   editor     edits posts AND TRANSLATIONS from inside the system, and
--              manages content. No permissions, no member list.
--
--   translator adds and edits TRANSLATIONS only. Explicitly NOT allowed
--              to control the original texts, even though they can read
--              every post (they must read it to translate it).
--
--   collector  saves posts through the extension and may edit ONLY the
--              posts they saved themselves, from either the extension or
--              the dashboard.
--
--  The behavioural change from 0001 is that a translator can no longer
--  UPDATE a post row. 0001 achieved that only implicitly, because the
--  `has_role('admin','editor')` branch happened to exclude them. Here it
--  is stated as a positive requirement for the collector branch, so the
--  intent cannot be lost by a later edit.
-- =====================================================================

-- Re-create the helpers this file relies on, so it also works if someone
-- applies it against a database whose 0001 came from an older revision.
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

-- ---------------------------------------------------------------------
-- posts
-- ---------------------------------------------------------------------
drop policy if exists posts_select_scope on public.posts;
drop policy if exists posts_insert_own   on public.posts;
drop policy if exists posts_update_scope on public.posts;
drop policy if exists posts_delete_scope on public.posts;

-- READ: a collector sees only their own rows; the editor, translator and
-- manager see the whole pool. Everyone must be active.
create policy posts_select_scope on public.posts
  for select to authenticated
  using (
    public.is_active_member()
    and (
      user_id = auth.uid()
      or public.has_role('admin', 'editor', 'translator')
    )
  );

-- CREATE: the extension never sends `user_id`, so the column default
-- supplies it and this check pins it to the caller.
create policy posts_insert_own on public.posts
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_active_member());

-- CONTENT EDITS: manager and editor on any post; a collector only on
-- their own rows. A translator appears in neither branch — that is the
-- point: they own translations, not originals.
create policy posts_update_scope on public.posts
  for update to authenticated
  using (user_id = auth.uid() or public.has_role('admin', 'editor'))
  with check (user_id = auth.uid() or public.has_role('admin', 'editor'));

-- DELETE: the extension's own delete filters on post_key alone with no
-- user filter, so `user_id = auth.uid()` here is the only thing stopping
-- one member from deleting another's posts.
create policy posts_delete_scope on public.posts
  for delete to authenticated
  using (
    public.is_active_member()
    and (user_id = auth.uid() or public.has_role('admin'))
  );

-- ---------------------------------------------------------------------
-- translations
--
-- Written by the translator, and also by the editor (editing
-- translations is part of the editor's remit) and the manager.
-- =====================================================================
drop policy if exists translations_select on public.translations;
drop policy if exists translations_write  on public.translations;

-- A translation is readable by anyone who may read the post it belongs
-- to. A collector must not read translations of other members' posts.
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

-- ---------------------------------------------------------------------
-- languages
--
-- Any of the three content roles may introduce a new language; only the
-- manager removes one, because that affects the whole system.
-- ---------------------------------------------------------------------
drop policy if exists languages_select on public.languages;
drop policy if exists languages_insert on public.languages;
drop policy if exists languages_delete on public.languages;

create policy languages_select on public.languages
  for select to authenticated using (true);

create policy languages_insert on public.languages
  for insert to authenticated
  with check (public.has_role('admin', 'editor', 'translator'));

create policy languages_delete on public.languages
  for delete to authenticated
  using (public.has_role('admin'));

-- ---------------------------------------------------------------------
-- profiles
--
-- Only the manager reads the member list. Everybody may read their own
-- row (needed to render the header). NOBODY may write through their own
-- JWT — role and status changes go through the service-role path only,
-- which is what stops a member from promoting themselves.
-- ---------------------------------------------------------------------
drop policy if exists profiles_select_self on public.profiles;
drop policy if exists profiles_select_admin on public.profiles;

create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy profiles_select_admin on public.profiles
  for select to authenticated
  using (public.has_role('admin'));

-- ---------------------------------------------------------------------
-- Verify the result by hand if you like:
--   select tablename, policyname, cmd from pg_policies
--    where schemaname = 'public' order by tablename, policyname;
-- ---------------------------------------------------------------------
comment on table public.posts is
  'منشورات فيسبوك المحفوظة. القراءة: المستخدم يرى منشوراته فقط، والمحرر/المترجم/المدير يرون الكل. التعديل: المدير والمحرر على أي منشور، والمستخدم على منشوراته فقط، والمترجم لا يعدّل النص الأصلي.';
