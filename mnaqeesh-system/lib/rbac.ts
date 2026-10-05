/**
 * مناقيش — Roles and permissions.
 *
 * Every access decision in the system is expressed here, so the whole
 * model can be reviewed in one file. Route handlers and Server Components
 * must go through these helpers rather than testing `role === 'admin'`
 * inline.
 *
 * THE FOUR ROLES (as specified by the system owner)
 * ------------------------------------------------
 *
 *  admin — full access and control over everything: every post, every
 *          translation, every member, every role, the audit log, and
 *          impersonation through "switch account".
 *
 *  editor — edits posts AND translations from inside the system, and
 *          controls content generally. Does NOT touch permissions, does
 *          NOT add members, and does NOT see the member list in any way.
 *
 *  translator — adds and edits translations only. Does NOT control the
 *          original texts: no content editing, no member list, no
 *          permission control.
 *
 *  collector — adds posts through the extension. May edit the posts they
 *          saved, either from the extension or from the dashboard, and
 *          the two stay in sync. Sees only their own posts.
 *
 * The matching database-side enforcement lives in
 * `supabase/migrations/0001_mnaqeesh.sql` (and later files) as RLS
 * policies, so a leaked publishable key cannot bypass any of this.
 */

export const ROLES = ['admin', 'editor', 'collector', 'translator'] as const;
export type Role = (typeof ROLES)[number];

export const STATUSES = ['pending', 'active', 'disabled'] as const;
export type Status = (typeof STATUSES)[number];

export type Profile = {
  id: string;
  email: string;
  full_name: string;
  avatar_url: string;
  role: Role;
  status: Status;
  note?: string;
  created_at?: string;
  updated_at?: string;
};

/** The columns every permission check needs. */
type RoleCarrier = Pick<Profile, 'role'> | null | undefined;
type ActorCarrier = Pick<Profile, 'id' | 'role'> | null | undefined;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

/** Human-readable role names for the interface. */
export const ROLE_LABELS: Record<Role, string> = {
  admin: 'مدير النظام',
  editor: 'محرر',
  collector: 'مستخدم (جامع منشورات)',
  translator: 'مترجم'
};

export const ROLE_SHORT_LABELS: Record<Role, string> = {
  admin: 'مدير',
  editor: 'محرر',
  collector: 'مستخدم',
  translator: 'مترجم'
};

export const STATUS_LABELS: Record<Status, string> = {
  active: 'نشط',
  pending: 'بانتظار التفعيل',
  disabled: 'معطّل'
};

/** Roles that may be assigned to a member from the dashboard. */
export const ASSIGNABLE_ROLES: Role[] = ['admin', 'editor', 'collector', 'translator'];

/** A signed-in user whose account the manager has activated. */
export function isUsableAccount(profile: Pick<Profile, 'status'> | null | undefined): boolean {
  return Boolean(profile && profile.status === 'active');
}

// ---------------------------------------------------------------------
// Content capabilities
// ---------------------------------------------------------------------

/** Manager: full control over the whole system. */
export function isAdmin(profile: RoleCarrier): boolean {
  return Boolean(profile && profile.role === 'admin');
}

export function isEditor(profile: RoleCarrier): boolean {
  return Boolean(profile && profile.role === 'editor');
}

export function isTranslator(profile: RoleCarrier): boolean {
  return Boolean(profile && profile.role === 'translator');
}

export function isCollector(profile: RoleCarrier): boolean {
  return Boolean(profile && profile.role === 'collector');
}

/**
 * Who may shape ANY post's original content, regardless of who saved it:
 * the manager and the editor. A translator explicitly may not — the
 * original texts are out of their scope.
 */
export function canManageAllContent(profile: RoleCarrier): boolean {
  return Boolean(profile && (profile.role === 'admin' || profile.role === 'editor'));
}

/**
 * Who may see posts they did not save themselves.
 *
 * A collector sees only their own rows. Every other role needs the wider
 * pool: the editor to manage content, the translator to translate it, and
 * the manager to oversee it.
 */
export function canSeeAllPosts(profile: RoleCarrier): boolean {
  return Boolean(profile && profile.role !== 'collector');
}

/**
 * Who may edit a given post's original content.
 *
 *   admin / editor -> any post
 *   collector      -> only the posts they saved themselves
 *   translator     -> never (they work on translations)
 */
export function canEditPost(profile: ActorCarrier, post: { user_id: string }): boolean {
  if (!profile) return false;
  if (canManageAllContent(profile)) return true;
  return profile.role === 'collector' && post.user_id === profile.id;
}

/** Who may remove a post. Same rule as editing it. */
export function canDeletePost(profile: ActorCarrier, post: { user_id: string }): boolean {
  return canEditPost(profile, post);
}

/** Who may bring a soft-deleted post back from the trash. Same rule as deleting it. */
export function canRestorePost(profile: ActorCarrier, post: { user_id: string }): boolean {
  return canDeletePost(profile, post);
}

/**
 * Who may change صاحب البوست — the Facebook account a post is attributed
 * to (the `author` column). This is a data-correction power over the
 * archive's metadata, so it belongs to the manager alone.
 *
 * NOTE: the SYSTEM member who saved the post (`user_id`) is a different
 * thing and is immutable for everyone — the database trigger
 * `posts_owner_immutable` (migration 0001) rejects any change, and no
 * dashboard route accepts it.
 */
export function canChangePostAuthor(profile: RoleCarrier): boolean {
  return isAdmin(profile);
}

/**
 * Who may create and change translations.
 *
 * Includes the editor: editing translations from inside the system is
 * part of the editor's remit. The translator is the specialist, the
 * manager oversees, and a collector never translates.
 */
export function canTranslate(profile: RoleCarrier): boolean {
  return Boolean(
    profile &&
      (profile.role === 'admin' || profile.role === 'editor' || profile.role === 'translator')
  );
}

/** Who may introduce a brand-new language to the system. */
export function canAddLanguage(profile: RoleCarrier): boolean {
  return canTranslate(profile);
}

/** Who may trigger an export of the archive. */
export function canExport(profile: Profile | null | undefined): boolean {
  return Boolean(profile && isUsableAccount(profile));
}

// ---------------------------------------------------------------------
// Administration capabilities — manager only
// ---------------------------------------------------------------------

/**
 * Who may manage members: create them by hand, activate, disable, change
 * roles. Editors and translators are explicitly excluded.
 */
export function canManageMembers(profile: RoleCarrier): boolean {
  return isAdmin(profile);
}

/**
 * Who may see the member list at all.
 * Editors and translators must never see other members of any kind.
 */
export function canSeeMembers(profile: RoleCarrier): boolean {
  return isAdmin(profile);
}

/** Who may read the audit log. */
export function canSeeActivityLog(profile: RoleCarrier): boolean {
  return isAdmin(profile);
}

/**
 * Who may switch into another member's account.
 *
 * Deliberately limited to adding a prefix rather than being a general
 * capability: the route additionally requires the caller to be the
 * account that originally started the switch.
 */
export function canSwitchAccount(profile: RoleCarrier): boolean {
  return isAdmin(profile);
}
