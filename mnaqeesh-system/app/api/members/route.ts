import { NextResponse } from 'next/server';
import { canSeeMembers } from '@/lib/rbac';
import { countPostsByUser, listMembers, requireUser } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The member list.
 *
 * Manager only. Editors and translators must never be able to enumerate
 * the other members, so this returns 403 for them rather than an empty
 * list — and `canSeeMembers` is the single place that decides.
 */
export async function GET() {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });

  if (!canSeeMembers(session.profile)) {
    return NextResponse.json({ error: 'لا تملك صلاحية الاطلاع على الأعضاء.' }, { status: 403 });
  }

  try {
    const [members, counts] = await Promise.all([listMembers(), countPostsByUser()]);
    const rows = members.map((member) => ({ ...member, post_count: counts[member.id] ?? 0 }));
    return NextResponse.json({ members: rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'تعذر تحميل الأعضاء.' },
      { status: 500 }
    );
  }
}
