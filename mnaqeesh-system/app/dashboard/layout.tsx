'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '@/components/auth-gate';
import SignOutButton from '@/components/signout-button';
import DashboardNav from '@/components/dashboard-nav';
import { appPath } from '@/lib/client/paths';
import type { SessionUser } from '@/lib/client/session';

/**
 * Shared dashboard chrome — static-hosting version.
 *
 * The old server component gated access with describeAccess() before
 * rendering; now AuthProvider runs the same check in the browser through
 * RLS and this wrapper renders the chrome only once access is active.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardChrome>{children}</DashboardChrome>
    </AuthProvider>
  );
}

function DashboardChrome({ children }: { children: React.ReactNode }) {
  const { session, loading, blocked } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (blocked) {
      router.replace(appPath(`/not-authorized?reason=${blocked.state}`));
      return;
    }
    if (!session) {
      router.replace(appPath('/login?next=/dashboard'));
    }
  }, [loading, blocked, session, router]);

  if (loading || !session || blocked) {
    return (
      <main className="shell">
        <div className="container">
          <section className="card">
            <div className="empty">جارٍ التحقق من الجلسة…</div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <div className="container">
        <Header session={session} />
        <DashboardNav isManager={session.profile.role === 'admin'} />
        {children}
      </div>
    </main>
  );
}

function Header({ session }: { session: SessionUser }) {
  const { profile } = session;

  return (
    <header className="header">
      <Link className="brand" href="/dashboard" style={{ textDecoration: 'none' }}>
        <div className="logo">م</div>
        <div>
          <h1>مناقيش</h1>
          <p>نظام إدارة منشورات فيسبوك المحفوظة من الفريق</p>
        </div>
      </Link>

      <div className="user-box">
        {profile.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="avatar" src={profile.avatar_url} alt="" />
        ) : (
          <div className="avatar" />
        )}
        <div className="user-meta">
          <strong>{profile.full_name || profile.email}</strong>
          <span>{roleLabel(profile.role)} · {profile.email}</span>
        </div>
        <SignOutButton />
      </div>
    </header>
  );
}

function roleLabel(role: string): string {
  switch (role) {
    case 'admin':
      return 'مدير النظام';
    case 'editor':
      return 'محرر';
    case 'translator':
      return 'مترجم';
    default:
      return 'مستخدم (جامع منشورات)';
  }
}
