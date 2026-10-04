import { NextResponse } from 'next/server';
import { requireUser, listActivity } from '@/lib/session';
import { canSeeActivityLog } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The audit trail. Manager only. */
export async function GET() {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });

  if (!canSeeActivityLog(session.profile)) {
    return NextResponse.json({ error: 'لا تملك صلاحية الاطلاع على السجل.' }, { status: 403 });
  }

  const activity = await listActivity(60);
  return NextResponse.json({ activity }, { headers: { 'Cache-Control': 'no-store' } });
}
