import type { NextConfig } from 'next';

/**
 * Static export — the app ships as plain files for GitHub Pages and
 * Firebase Hosting (see HOSTING.md). Everything runs in the browser
 * against Supabase (RLS + triggers enforce the rules); there is no
 * Node server, no API routes, and no middleware in this build.
 *
 * NEXT_PUBLIC_BASE_PATH is only needed for GitHub Pages PROJECT sites
 * served under https://<user>.github.io/<repo>/ — set it to /<repo-name>
 * at build time. User/organization sites and custom domains leave it
 * empty.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.replace(/\/+$/, '') || undefined;

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  reactStrictMode: true
};

export default nextConfig;
