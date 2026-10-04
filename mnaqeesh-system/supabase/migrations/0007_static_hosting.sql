-- =====================================================================
--  مناقيش — Migration 0007
--  دعم الاستضافة الثابتة (GitHub Pages / Firebase Hosting)
--
--  HOW TO RUN
--    Supabase Dashboard -> SQL Editor -> New query -> paste all -> Run.
--  Idempotent: safe to run more than once.
--
--  WHY THIS FILE EXISTS
--  --------------------
--  The dashboard used to run on a Next.js server (Vercel) whose route
--  handlers wrote through the service-role key after app-level rbac
--  checks. Moving to static hosting (GitHub Pages / Firebase Hosting)
--  means the browser now talks to Supabase DIRECTLY with the member's
--  own JWT, so every rule the route handlers used to enforce must now be
--  enforced by the DATABASE itself:
--
--    1. site_settings  -> readable by anon (theme on the login page),
--                         writable ONLY by admins through their JWT.
--    2. profiles       -> admins update members through their JWT
--                         (policy profiles_admin_write already exists;
--                         this file adds the missing UPDATE grant).
--    3. log_activity() -> security-definer RPC that writes the audit log
--                         on behalf of an active member (no direct
--                         INSERT grant on activity_log is ever given).
--    4. posts.author   -> trigger: only admins may change صاحب البوست.
--    5. translations   -> trigger: the "translator may only delete their
--                         own unfinished draft" rule moves to the DB.
--    6. profiles       -> trigger: the last active admin can never be
--                         removed or demoted; nobody can disable or
--                         demote their own account.
--    7. posts_update   -> policy re-stated WITH is_active_member(), so a
--                         disabled member cannot keep editing their rows.
--
--  The service-role key itself moves OUT of the web app into a Supabase
--  Edge Function (supabase/functions/admin-members) — the only remaining
--  privileged operations are auth.admin.createUser and updateUserById,
--  which have no JWT-side equivalent.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) site_settings — public read (theme), admin-only write
-- ---------------------------------------------------------------------
drop policy if exists site_settings_select on public.site_settings;
create policy site_settings_select on public.site_settings
  for select to anon, authenticated
  using (true);

grant select on public.site_settings to anon;

grant update on public.site_settings to authenticated;
drop policy if exists site_settings_admin_update on public.site_settings;
create policy site_settings_admin_update on public.site_settings
  for update to authenticated
  using (public.has_role('admin'))
  with check (public.has_role('admin'));

-- ---------------------------------------------------------------------
-- 2) profiles — admins manage members through their own JWT.
--    The row-level policy `profiles_admin_write` (migration 0001) already
--    restricts every write to has_role('admin'); only the GRANT was
--    missing, because the server used to do this with the service key.
-- ---------------------------------------------------------------------
grant update on public.profiles to authenticated;

-- ---------------------------------------------------------------------
-- 3) log_activity() — the audit log's only member-side write path.
--    A security-definer RPC instead of a grant: the table itself stays
--    INSERT-locked for authenticated, and the RPC validates that the
--    caller is an active member, fills actor_id/email from the JWT, and
--    clamps lengths so a buggy client cannot flood the log.
-- ---------------------------------------------------------------------
create or replace function public.log_activity(
  p_action    text,
  p_entity    text,
  p_entity_id text default '',
  p_details   jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_email text;
begin
  if not public.is_active_member() then
    raise exception 'لا يمكن تسجيل النشاط لحساب غير مفعّل.' using errcode = '42501';
  end if;

  select coalesce(email, '') into v_actor_email from public.profiles where id = auth.uid();

  insert into public.activity_log (actor_id, actor_email, action, entity, entity_id, details)
  values (
    auth.uid(),
    left(coalesce(v_actor_email, coalesce(auth.jwt() ->> 'email', '')), 200),
    left(coalesce(p_action, ''), 80),
    left(coalesce(p_entity, ''), 80),
    left(coalesce(p_entity_id, ''), 80),
    coalesce(p_details, '{}'::jsonb)
  );
end $$;

revoke execute on function public.log_activity(text, text, text, jsonb) from public;
revoke execute on function public.log_activity(text, text, text, jsonb) from anon;
grant  execute on function public.log_activity(text, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 4) posts.author — only the manager may change صاحب البوست.
--    The rule used to live in the PATCH route handler; with the browser
--    writing directly, it belongs on the column. The service_role branch
--    keeps privileged server code (edge functions) working.
-- ---------------------------------------------------------------------
create or replace function public.prevent_non_admin_author_change()
returns trigger
language plpgsql
as $$
begin
  if current_user = 'service_role' then
    return new;
  end if;
  if new.author is distinct from old.author and not public.has_role('admin') then
    raise exception 'تغيير صاحب البوست (حساب فيسبوك) متاح لمدير النظام فقط.'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists posts_author_admin_guard on public.posts;
create trigger posts_author_admin_guard before update on public.posts
  for each row execute function public.prevent_non_admin_author_change();

-- ---------------------------------------------------------------------
-- 5) translations — move the delete rule to the database.
--    A translator may delete only their OWN unfinished draft; admins and
--    editors may delete anything. The pg_trigger_depth() branch lets the
--    ON DELETE CASCADE from a post delete pass through untouched — the
--    extension's own delete of a post must never fail because someone
--    else had translated it.
-- ---------------------------------------------------------------------
create or replace function public.guard_translation_delete()
returns trigger
language plpgsql
as $$
begin
  if current_user = 'service_role' then
    return old;
  end if;
  if pg_trigger_depth() > 1 then
    return old; -- cascaded from a posts delete; the post policy already ruled
  end if;
  if public.has_role('admin', 'editor') then
    return old;
  end if;
  if old.translator_id = auth.uid() and not old.is_complete then
    return old;
  end if;
  raise exception 'لا يمكن حذف ترجمة كتبها مترجم آخر أو ترجمة مكتملة.'
    using errcode = '42501';
end $$;

drop trigger if exists translations_delete_guard on public.translations;
create trigger translations_delete_guard before delete on public.translations
  for each row execute function public.guard_translation_delete();

-- ---------------------------------------------------------------------
-- 6) profiles — last-admin and self-demotion guards.
--    Used to be two guards inside the PATCH route; now they are triggers,
--    so they hold no matter which client sends the statement.
-- ---------------------------------------------------------------------
create or replace function public.guard_admin_privileges()
returns trigger
language plpgsql
as $$
declare
  v_other_admins int;
  v_losing boolean := false;
begin
  if current_user = 'service_role' then
    return coalesce(new, old);
  end if;

  if tg_op = 'UPDATE' then
    v_losing := old.role = 'admin' and old.status = 'active'
                and (new.role <> 'admin' or new.status <> 'active');

    -- An account can never demote or disable ITSELF through its own JWT.
    if v_losing and new.id = auth.uid() then
      raise exception 'لا يمكنك خفض دورك أو تعطيل حسابك بنفسك.'
        using errcode = 'P0001';
    end if;
  elsif tg_op = 'DELETE' then
    v_losing := old.role = 'admin' and old.status = 'active';
  end if;

  if v_losing then
    select count(*) into v_other_admins
      from public.profiles
     where role = 'admin' and status = 'active' and id <> old.id;
    if v_other_admins = 0 then
      raise exception 'لا يمكن إزالة آخر مدير نشط في النظام.'
        using errcode = 'P0001';
    end if;
  end if;

  return coalesce(new, old);
end $$;

drop trigger if exists profiles_admin_privileges on public.profiles;
create trigger profiles_admin_privileges before update or delete on public.profiles
  for each row execute function public.guard_admin_privileges();

-- ---------------------------------------------------------------------
-- 7) posts_update_scope — restate WITH the active-member requirement.
--    A member the manager just disabled must not keep editing even their
--    own rows through a still-valid token.
-- ---------------------------------------------------------------------
drop policy if exists posts_update_scope on public.posts;
create policy posts_update_scope on public.posts
  for update to authenticated
  using (
    public.is_active_member()
    and (user_id = auth.uid() or public.has_role('admin', 'editor'))
  )
  with check (
    public.is_active_member()
    and (user_id = auth.uid() or public.has_role('admin', 'editor'))
  );

-- ---------------------------------------------------------------------
-- 8) Redefine the extension-resync restore trigger WITHOUT touching
--    `author`. With the new admin-only author guard, a member re-saving
--    a soft-deleted post would otherwise fail to restore it whenever the
--    incoming author text differed. Preserving the stored author is also
--    the right behaviour now that the manager may have corrected it.
-- ---------------------------------------------------------------------
create or replace function public.restore_post_on_extension_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing public.posts%rowtype;
begin
  if NEW.user_id is null then
    NEW.user_id := auth.uid();
  end if;

  select * into existing
    from public.posts
   where user_id = NEW.user_id
     and post_key = NEW.post_key
   limit 1;

  if not found then
    return NEW;
  end if;

  if existing.deleted_at is not null then
    update public.posts
       set post_date         = coalesce(nullif(NEW.post_date, ''), existing.post_date),
           post_time         = coalesce(nullif(NEW.post_time, ''), existing.post_time),
           privacy           = coalesce(nullif(NEW.privacy, ''), existing.privacy),
           text              = case when coalesce(NEW.text, '') <> '' then NEW.text else existing.text end,
           markdown_text     = case
                                 when coalesce(NEW.markdown_text, '') <> '' then NEW.markdown_text
                                 else existing.markdown_text
                               end,
           image_urls        = case
                                 when NEW.image_urls is not null and NEW.image_urls <> '[]'::jsonb
                                 then NEW.image_urls
                                 else existing.image_urls
                               end,
           image_direct_urls = case
                                 when NEW.image_direct_urls is not null and NEW.image_direct_urls <> '[]'::jsonb
                                 then NEW.image_direct_urls
                                 else existing.image_direct_urls
                               end,
           video_url         = coalesce(nullif(NEW.video_url, ''), existing.video_url),
           video_direct_url  = coalesce(nullif(NEW.video_direct_url, ''), existing.video_direct_url),
           post_url          = coalesce(nullif(NEW.post_url, ''), existing.post_url),
           saved_at          = coalesce(NEW.saved_at, now()),
           deleted_at        = null,
           status            = 'new',
           updated_at        = now()
     where id = existing.id;
  end if;

  -- Skip the INSERT either way: restored above, or already live.
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- Verify by hand:
--   select tablename, policyname, cmd from pg_policies
--    where schemaname = 'public' order by tablename, policyname;
-- ---------------------------------------------------------------------

comment on function public.log_activity(text, text, text, jsonb) is
  'يكتب في سجل النشاط نيابة عن عضو مفعّل — المسار الوحيد للكتابة من المتصفح.';
comment on function public.prevent_non_admin_author_change() is
  'يمنع تغيير صاحب البوست (حساب فيسبوك) إلا لمدير النظام.';
