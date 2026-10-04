import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logActivity, requireUser } from '@/lib/session';
import { canManageMembers, ROLE_LABELS } from '@/lib/rbac';
import { optionalRole, optionalStatus, text, uuid } from '@/lib/validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/**
 * Activates/deactivates a member or changes their role.
 *
 * Manager only. Two invariants are protected here:
 *   1. A manager cannot disable or demote their own account.
 *   2. The system can never lose its last active manager.
 */
export async function PATCH(request: Request, { params }: Params) {
  const session = await requireUser();
  if (!session) return NextResponse.json({ error: 'يجب تسجيل الدخول.' }, { status: 401 });

  if (!canManageMembers(session.profile)) {
    return NextResponse.json({ error: 'إدارة الأعضاء متاحة لمدير النظام فقط.' }, { status: 403 });
  }

  const { id } = await params;
  const memberId = uuid(id);
  if (!memberId) return NextResponse.json({ error: 'معرّف العضو غير صالح.' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'طلب غير صالح.' }, { status: 400 });
  }

  const patch: { role?: string; status?: string; note?: string } = {};

  const role = body.role === undefined ? null : optionalRole(body.role);
  if (body.role !== undefined) {
    if (!role) return NextResponse.json({ error: 'الدور غير صالح.' }, { status: 400 });
    patch.role = role;
  }

  const status = body.status === undefined ? null : optionalStatus(body.status);
  if (body.status !== undefined) {
    if (!status) return NextResponse.json({ error: 'الحالة غير صالحة.' }, { status: 400 });
    patch.status = status;
  }

  if (body.note !== undefined) patch.note = text(body.note, 500);

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'لا توجد حقول للتحديث.' }, { status: 400 });
  }

  // Guard 1: do not let the manager lock themselves out.
  if (memberId === session.userId) {
    if (patch.status === 'disabled') {
      return NextResponse.json({ error: 'لا يمكنك تعطيل حسابك بنفسك.' }, { status: 400 });
    }
    if (patch.role && patch.role !== 'admin') {
      return NextResponse.json({ error: 'لا يمكنك خفض دورك من داخل هذا الحساب.' }, { status: 400 });
    }
  }

  const service = createServiceClient();
  const { data: target, error: readError } = await service
    .from('profiles')
    .select('id,email,full_name,role,status')
    .eq('id', memberId)
    .maybeSingle();

  if (readError) {
    console.error('[members] read failed:', readError);
    return NextResponse.json({ error: 'تعذر قراءة بيانات العضو.' }, { status: 500 });
  }
  if (!target) return NextResponse.json({ error: 'العضو غير موجود.' }, { status: 404 });

  // Would this change strip the target of active-manager status?
  const nextRole = patch.role ?? target.role;
  const nextStatus = patch.status ?? target.status;
  const losingAdmin = target.role === 'admin' && target.status === 'active' && (nextRole !== 'admin' || nextStatus !== 'active');

  // Guard 2: never remove the last active manager.
  if (losingAdmin) {
    const { count } = await service
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .eq('status', 'active');

    if ((count ?? 0) <= 1) {
      return NextResponse.json({ error: 'لا يمكن إزالة آخر مدير نشط في النظام.' }, { status: 400 });
    }
  }

  const { data: updated, error } = await service
    .from('profiles')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', memberId)
    .select('id,email,full_name,avatar_url,role,status,note,created_at,updated_at')
    .single();

  if (error) {
    console.error('[members] update failed:', error);
    return NextResponse.json({ error: 'تعذر تحديث العضو.' }, { status: 500 });
  }

  await logActivity({
    actorId: session.userId,
    actorEmail: session.email,
    action: 'member.update',
    entity: 'profiles',
    entityId: memberId,
    details: {
      target: target.email,
      ...patch,
      ...(patch.role ? { roleLabel: ROLE_LABELS[patch.role as keyof typeof ROLE_LABELS] } : {})
    }
  });

  return NextResponse.json({ ok: true, member: updated });
}
