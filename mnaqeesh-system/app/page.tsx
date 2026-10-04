import { redirect } from 'next/navigation';
import { describeAccess } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Entry point.
 *
 * Sends each state to the right place instead of failing silently:
 * signed out -> login, unactivated account -> explanation page.
 */
export default async function RootPage() {
  const access = await describeAccess();

  if (access.state === 'anonymous') redirect('/login');
  if (access.state === 'no_profile') redirect('/not-authorized?reason=no_profile');
  if (access.state === 'pending') redirect('/not-authorized?reason=pending');
  if (access.state === 'disabled') redirect('/not-authorized?reason=disabled');

  redirect('/dashboard');
}
