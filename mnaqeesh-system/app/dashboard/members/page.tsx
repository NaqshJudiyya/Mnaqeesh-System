import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { describeAccess, listMembers, countPostsByUser } from '@/lib/session';
import { canSeeMembers } from '@/lib/rbac';
import MembersClient from '@/components/members-client';

export const dynamic = 'force-dynamic';

/** Reads the stashed original session to learn who we switched away from. */
async function readOriginEmail(): Promise<string> {
  try {
    const store = await cookies();
    const raw = store.get('mnq_origin')?.value;
    if (!raw) return '';
    const parsed = JSON.parse(raw) as { email?: string };
    return parsed.email ?? '';
  } catch {
    return '';
  }
}

export default async function MembersPage() {
  const access = await describeAccess();
  if (access.state !== 'active') redirect('/login');

  // Editors and translators are refused here, not just hidden in the UI.
  if (!canSeeMembers(access.session.profile)) {
    redirect('/not-authorized?reason=members');
  }

  const [members, counts, originEmail] = await Promise.all([
    listMembers(),
    countPostsByUser(),
    readOriginEmail()
  ]);

  const rows = members.map((member) => ({ ...member, post_count: counts[member.id] ?? 0 }));

  return (
    <MembersClient
      currentUserId={access.session.userId}
      initialMembers={rows}
      isImpersonating={originEmail.length > 0}
      originEmail={originEmail}
    />
  );
}
