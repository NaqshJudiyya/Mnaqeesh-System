/**
 * Client-side base-path helper.
 *
 * GitHub Pages project sites serve the app under `/<repo-name>/`, which is
 * configured through NEXT_PUBLIC_BASE_PATH (see next.config.ts and
 * HOSTING.md). Next's <Link> and router respect it automatically, but
 * raw `window.location` assignments and the Supabase OAuth redirect do
 * not — they must go through appPath().
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function appPath(path: string): string {
  return `${BASE_PATH}${path}`;
}
