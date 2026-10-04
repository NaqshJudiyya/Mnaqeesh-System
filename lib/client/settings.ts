/**
 * Site appearance settings — browser side.
 *
 * Read: every signed-in member AND anonymous visitors (the login page)
 * can read site_settings through RLS (migration 0007), so the theme
 * applies everywhere.
 * Write: admins only — RLS policy `site_settings_admin_update` plus the
 * admin-only UPDATE grant enforce it; the app-level check just gives a
 * friendlier error.
 */

import { createClient } from '@/lib/supabase/client';
import { isAdmin } from '@/lib/rbac';
import { mergeAppearance, normalizeAppearance, type AppearanceSettings } from '@/lib/appearance';
import { logActivity } from '@/lib/client/session';

/** Reads the stored appearance, merged over the defaults. */
export async function fetchAppearance(): Promise<AppearanceSettings> {
  try {
    const supabase = createClient();
    const { data } = await supabase.from('site_settings').select('data').eq('id', 1).maybeSingle();
    return mergeAppearance((data as { data: unknown } | null)?.data ?? null);
  } catch {
    return mergeAppearance(null);
  }
}

/** Validates and saves the appearance. Admin only. */
export async function saveAppearance(
  viewer: ProfileLike,
  input: unknown
): Promise<AppearanceSettings> {
  if (!isAdmin(viewer)) {
    throw new Error('إعدادات تنسيق الموقع متاحة لمدير النظام فقط.');
  }

  const normalized = normalizeAppearance(input);
  if (!normalized.ok) throw new Error(normalized.error);

  const supabase = createClient();
  const { data, error } = await supabase
    .from('site_settings')
    .update({
      data: normalized.value,
      updated_by: viewer.id,
      updated_at: new Date().toISOString()
    })
    .eq('id', 1)
    .select('data')
    .single();

  if (error) {
    throw new Error(
      /row-level security|permission denied/i.test(error.message)
        ? 'إعدادات تنسيق الموقع متاحة لمدير النظام فقط.'
        : 'تعذر حفظ الإعدادات: ' + error.message
    );
  }

  await logActivity({
    action: 'settings.update',
    entity: 'site_settings',
    entityId: '1',
    details: { fields: Object.keys(normalized.value) }
  });

  return mergeAppearance((data as { data: unknown } | null)?.data ?? normalized.value);
}

type ProfileLike = Pick<import('@/lib/rbac').Profile, 'id' | 'role'>;
