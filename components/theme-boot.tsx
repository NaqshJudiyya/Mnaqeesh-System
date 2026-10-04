'use client';

import { useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { appearanceCssVars, mergeAppearance } from '@/lib/appearance';

const CACHE_KEY = 'mnq-appearance';

/**
 * Applies the manager's appearance settings from the BROWSER.
 *
 * The old server layout injected these vars into <html> at render time;
 * a static build has no server, so the stylesheet defaults apply first,
 * the last-known settings come from localStorage instantly (no flash),
 * and the live values are then fetched from site_settings — readable by
 * anonymous visitors too (migration 0007) so the login page is themed.
 */
export default function ThemeBoot() {
  useEffect(() => {
    const root = document.documentElement;

    function apply(settings: ReturnType<typeof mergeAppearance>) {
      const vars = appearanceCssVars(settings);
      for (const [name, value] of Object.entries(vars)) {
        root.style.setProperty(name, value);
      }
    }

    // 1) Instantly restore the last-known settings.
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) apply(mergeAppearance(JSON.parse(cached)));
    } catch {
      // Corrupt cache — fall through and let the fetch fix it.
    }

    // 2) Fetch the fresh values (works signed-out as well).
    (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase.from('site_settings').select('data').eq('id', 1).maybeSingle();
        const settings = mergeAppearance((data as { data: unknown } | null)?.data ?? null);
        apply(settings);
        localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
      } catch {
        // Offline or table missing — the defaults stay in effect.
      }
    })();
  }, []);

  return null;
}
