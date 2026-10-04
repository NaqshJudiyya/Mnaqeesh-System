'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/components/auth-gate';
import MembersClient from '@/components/members-client';
import { countPostsByUser, listMembers, readStashedOrigin } from '@/lib/client/members';
import { canSeeMembers } from '@/lib/rbac';
import { appPath } from '@/lib/client/paths';
import type { MemberRow } from '@/lib/client/members';

/**
 * الأعضاء والصلاحيات — manager only. The server page used to gate access
 * and pre-load the list; both happen client-side now.
 */
export default function MembersPage() {
  const session = useSession();
  const router = useRouter();

  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [refused, setRefused] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!session) return;

    // Editors and translators are refused here, not just hidden in the UI.
    if (!canSeeMembers(session.profile)) {
      router.replace(appPath('/not-authorized?reason=members'));
      setRefused(true);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const [rows, counts] = await Promise.all([listMembers(), countPostsByUser()]);
        if (cancelled) return;
        setMembers(rows.map((member) => ({ ...member, post_count: counts[member.id] ?? 0 })));
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'تعذر تحميل الأعضاء.');
          setMembers([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session, router]);

  if (!session || refused) return null;

  const originStash = readStashedOrigin();

  return (
    <>
      {loadError && <div className="notice error">{loadError}</div>}
      {members === null ? (
        <section className="card"><div className="empty">جارٍ تحميل الأعضاء…</div></section>
      ) : (
        <MembersClient
          viewer={session.profile}
          currentUserId={session.userId}
          initialMembers={members}
          isImpersonating={Boolean(originStash)}
          originEmail={originStash?.email ?? ''}
        />
      )}
    </>
  );
}
