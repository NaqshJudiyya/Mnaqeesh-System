-- =====================================================================
--  مناقيش — Migration 0005
--  إعادة ظهور المنشور بعد حذفه من النظام عند «إرسال منشوراتي»
--
--  HOW TO RUN
--    Supabase Dashboard -> SQL Editor -> New query -> paste all -> Run.
--  Idempotent: safe to run more than once.
--
--  WHY
--  ---
--  Dashboard delete is a SOFT delete (`deleted_at` is set). The row stays
--  in the table, so the unique index on (user_id, post_key) still matches.
--
--  The extension then POSTs with
--    Prefer: resolution=ignore-duplicates
--  i.e. ON CONFLICT DO NOTHING. A re-send of a deleted post is therefore
--  silently dropped and the post never reappears.
--
--  This trigger runs BEFORE INSERT. If the same member already has that
--  post_key and it is soft-deleted, we restore the row (and refresh the
--  scraped fields from the incoming payload) then cancel the INSERT.
--  If the row is still live, we cancel the INSERT with no change — the
--  same as ignore-duplicates, so in-app edits are not overwritten.
-- =====================================================================

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
       set author            = coalesce(nullif(NEW.author, ''), existing.author),
           post_date         = coalesce(nullif(NEW.post_date, ''), existing.post_date),
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

drop trigger if exists posts_restore_on_extension_insert on public.posts;
create trigger posts_restore_on_extension_insert
  before insert on public.posts
  for each row
  execute function public.restore_post_on_extension_insert();

revoke all on function public.restore_post_on_extension_insert() from public;
revoke all on function public.restore_post_on_extension_insert() from anon;
revoke all on function public.restore_post_on_extension_insert() from authenticated;

comment on function public.restore_post_on_extension_insert() is
  'عند إعادة إرسال منشور محذوف من الإضافة: يستعيد الصف ويُلغي الإدراج المكرر.';
