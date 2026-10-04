'use client';

import { useEffect, useState } from 'react';
import { appPath } from '@/lib/client/paths';
import { describeAccess } from '@/lib/client/session';
import ConnectClient from '@/components/connect-client';

/**
 * /connect — the page the extension opens to sign in (static-hosting
 * version: the session check that used to be a server component now runs
 * in the browser through RLS).
 */
export default function ConnectPage() {
  const [state, setState] = useState<'loading' | 'blocked' | 'ready'>('loading');
  const [identity, setIdentity] = useState<{ name: string; email: string }>({ name: '', email: '' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const access = await describeAccess();
      if (cancelled) return;

      switch (access.state) {
        case 'anonymous':
          // Nobody signed in yet: start the login flow, returning here.
          window.location.replace(appPath('/login?next=/connect'));
          return;
        case 'no_profile':
          window.location.replace(appPath('/not-authorized?reason=no_profile'));
          return;
        case 'pending':
          window.location.replace(appPath('/not-authorized?reason=pending'));
          return;
        case 'disabled':
          window.location.replace(appPath('/not-authorized?reason=disabled'));
          return;
        case 'active':
          setIdentity({
            name: access.session.profile.full_name || access.session.email,
            email: access.session.email
          });
          setState('ready');
          return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state !== 'ready') {
    return (
      <main className="login-shell">
        <section className="card connect-card">
          <p className="muted" style={{ textAlign: 'center' }}>جارٍ التحقق من الجلسة…</p>
        </section>
      </main>
    );
  }

  return (
    <main className="login-shell">
      <section className="card connect-card">
        <div className="row" style={{ gap: 12 }}>
          <div className="logo">م</div>
          <div>
            <h1 style={{ fontSize: 20 }}>ربط الإضافة بحسابك</h1>
            <p className="muted" style={{ margin: 0 }}>
              {identity.name}
            </p>
          </div>
        </div>

        <ConnectClient />
      </section>
    </main>
  );
}
