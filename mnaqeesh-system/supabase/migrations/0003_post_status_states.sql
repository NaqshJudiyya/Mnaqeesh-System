-- =====================================================================
--  مناقيش — Migration 0003
--  حالات المنشور: مشتقّة + يدوية
--
--  HOW TO RUN
--    Supabase Dashboard -> SQL Editor -> New query -> paste all -> Run.
--  Idempotent: safe to run more than once.
--
--  WHAT CHANGED AND WHY
--  --------------------
--  The status shown in the dashboard is now two things combined:
--
--    DERIVED (nobody sets it, it is computed from the row):
--      «جديد»    the post is only saved
--      «منسَّق»  its text was edited / a Markdown version exists   (amber)
--      «مترجَم»  it has at least one translation                    (blue)
--
--    MANUAL (the manager, or the member who saved the post):
--      «نهائي»          final                                     (green)
--      «يحتاج مراجعة»    needs review                              (red)
--
--  Only the MANUAL part lives in `posts.status`. The derived part is
--  computed in the application from `edited_markdown` / `markdown_text`
--  and the presence of translations, so it can never drift out of sync.
--
--  This migration only normalises `status` to the three values the UI
--  understands. Older rows may still carry states from the first draft
--  (`reviewed`, `published`, `archived`), which the dashboard no longer
--  knows how to render.
-- =====================================================================

-- 1) Map any legacy value onto the new vocabulary.
update public.posts set status = 'final'       where status = 'published';
update public.posts set status = 'final'       where status = 'archived';
update public.posts set status = 'needs_review' where status = 'reviewed';

-- 2) Anything unrecognised becomes the neutral state. This must run
--    before the constraint below, or adding it would fail.
update public.posts
   set status = 'new'
 where status is null
    or status not in ('new', 'final', 'needs_review');

-- 3) Guarantee the default for future inserts (the extension sends no
--    status field at all).
alter table public.posts alter column status set default 'new';

-- 4) Constrain the column so a bad value can never be stored again.
--    DROP-then-ADD keeps this file re-runnable.
alter table public.posts drop constraint if exists posts_status_check;
alter table public.posts
  add constraint posts_status_check
  check (status in ('new', 'final', 'needs_review'));

comment on column public.posts.status is
  'الحالة اليدوية للمنشور فقط: new (عادي) | final (نهائي) | needs_review (يحتاج مراجعة). الحالات المشتقّة (جديد/منسَّق/مترجَم) تُحسب في التطبيق ولا تُخزَّن هنا.';

-- 5) Speeds up the status filter in the dashboard header.
create index if not exists posts_status_filter_idx on public.posts (status)
  where deleted_at is null;
