import { redirect } from 'next/navigation';
import { describeAccess } from '@/lib/session';
import ConnectClient from '@/components/connect-client';

export const dynamic = 'force-dynamic';

/**
 * /connect — the page the extension opens to sign in.
 *
 * The extension's popup runs `chrome.tabs.create({ url: `${siteUrl}/connect` })`.
 * This page performs the Google sign-in, then hands the resulting
 * Supabase session to the extension through the bridge content script.
 */
export default async function ConnectPage() {
  const access = await describeAccess();

  // Nobody signed in yet: start the Google flow, returning here after.
  if (access.state === 'anonymous') {
    redirect('/login?next=/connect');
  }

  if (access.state === 'no_profile') {
    redirect('/not-authorized?reason=no_profile');
  }
  if (access.state === 'pending') {
    redirect('/not-authorized?reason=pending');
  }
  if (access.state === 'disabled') {
    redirect('/not-authorized?reason=disabled');
  }

  return (
    <main className="login-shell">
      <section className="card connect-card">
        <div className="row" style={{ gap: 12 }}>
          <div className="logo">م</div>
          <div>
            <h1 style={{ fontSize: 20 }}>ربط الإضافة بحسابك</h1>
            <p className="muted" style={{ margin: 0 }}>
              {access.session.profile.full_name || access.session.email}
            </p>
          </div>
        </div>

        <ConnectClient />
      </section>
    </main>
  );
}
