import { redirect } from 'next/navigation';
import { describeAccess } from '@/lib/session';
import SignOutButton from '@/components/signout-button';
import DashboardNav from '@/components/dashboard-nav';

export const dynamic = 'force-dynamic';

/**
 * Shared dashboard chrome.
 *
 * The navigation is role-aware: the "الأعضاء" and "السجل" tabs are only
 * rendered for the manager, so editors and translators have no route
 * into the member list at all.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const access = await describeAccess();

  if (access.state === 'anonymous') redirect('/login');
  if (access.state === 'no_profile') redirect('/not-authorized?reason=no_profile');
  if (access.state === 'pending') redirect('/not-authorized?reason=pending');
  if (access.state === 'disabled') redirect('/not-authorized?reason=disabled');

  const { profile } = access.session;
  const isManager = profile.role === 'admin';

  return (
    <main className="shell">
      <div className="container">
        <header className="header">
          <div className="brand">
            <div className="logo">م</div>
            <div>
              <h1>مناقيش</h1>
              <p>نظام إدارة منشورات فيسبوك المحفوظة من الفريق</p>
            </div>
          </div>

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

        <DashboardNav isManager={isManager} />

        {children}
      </div>
    </main>
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
