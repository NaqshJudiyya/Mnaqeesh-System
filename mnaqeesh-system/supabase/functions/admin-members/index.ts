// =====================================================================
//  مناقيش — Edge Function: admin-members
//
//  THE ONLY server-side code left in the system. When the dashboard
//  moved to static hosting (GitHub Pages / Firebase Hosting), everything
//  else started talking to Supabase directly with the member's own JWT
//  (enforced by RLS + triggers from migration 0007).
//
//  Two operations have NO JWT-side equivalent because they use
//  supabase.auth.admin, which always requires the service-role key:
//    action = "create"       -> create a member by hand (auth.admin.createUser)
//    action = "set_password" -> assign a member a password (auth.admin.updateUserById)
//
//  The service-role key lives ONLY in this function's secrets. Every call
//  must carry the caller's Supabase access token, and the caller must be
//  an ACTIVE ADMIN — the function re-checks that from the token itself.
//
//  DEPLOY (see HOSTING.md for the full walkthrough):
//    supabase functions deploy admin-members --project-ref <ref>
//    supabase secrets set ALLOWED_ORIGINS="https://site1,https://site2"
//  (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
// =====================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type CreatePayload = {
  action: 'create';
  username?: string;
  email?: string;
  fullName?: string;
  password?: string;
  role?: string;
  status?: string;
  note?: string;
};

type SetPasswordPayload = {
  action: 'set_password';
  memberId?: string;
  password?: string;
};

type Payload = CreatePayload | SetPasswordPayload;

const ROLES = ['admin', 'editor', 'collector', 'translator'];
const STATUSES = ['pending', 'active', 'disabled'];
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

function json(body: unknown, status = 200, origin: string | null = null): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...corsHeaders(origin)
  };
  return new Response(JSON.stringify(body), { status, headers });
}

function corsHeaders(origin: string | null): Record<string, string> {
  // Reflect the request origin only when it is on the allow-list; with no
  // list configured the function stays open (a stolen call still needs an
  // admin's valid token, so CORS here is defence-in-depth, not the wall).
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const allow = allowed.length === 0 || (origin !== null && allowed.includes(origin))
    ? (origin ?? '*')
    : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin'
  };
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get('origin');

  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(origin) });
  }
  if (request.method !== 'POST') {
    return json({ error: 'الطريقة غير مدعومة.' }, 405, origin);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? serviceKey;

  const service = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // ---- 1. Who is calling? The bearer token decides, never the body. ----
  const authHeader = request.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return json({ error: 'يجب تسجيل الدخول.' }, 401, origin);
  }

  const verifier = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data: userData, error: userError } = await verifier.auth.getUser(token);
  if (userError || !userData.user) {
    return json({ error: 'الجلسة غير صالحة. سجّل الدخول من جديد.' }, 401, origin);
  }

  const { data: callerProfile, error: profileError } = await service
    .from('profiles')
    .select('id,role,status,email')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileError || !callerProfile || callerProfile.role !== 'admin' || callerProfile.status !== 'active') {
    return json({ error: 'إدارة الأعضاء متاحة لمدير النظام فقط.' }, 403, origin);
  }

  // ---- 2. Dispatch on the action. ----
  let payload: Payload;
  try {
    payload = await request.json() as Payload;
  } catch {
    return json({ error: 'طلب غير صالح.' }, 400, origin);
  }

  async function logActivity(action: string, entityId: string, details: Record<string, unknown>) {
    await service.from('activity_log').insert({
      actor_id: callerProfile.id,
      actor_email: callerProfile.email ?? '',
      action,
      entity: 'profiles',
      entity_id: entityId,
      details
    });
  }

  function shadowEmail(username: string): string {
    return `${username.toLowerCase().replace(/[^a-z0-9._-]/g, '')}@members.mnaqeesh.local`;
  }

  if (payload.action === 'create') {
    const username = String(payload.username ?? '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, 32);
    const emailInput = String(payload.email ?? '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, 200);
    const fullName = String(payload.fullName ?? '').trim().slice(0, 120);
    const password = String(payload.password ?? '');
    const role = ROLES.includes(String(payload.role)) ? String(payload.role) : 'collector';
    const status = STATUSES.includes(String(payload.status)) ? String(payload.status) : 'active';

    if (!emailInput && !USERNAME_RE.test(username)) {
      return json({ error: 'اسم المستخدم يجب أن يكون 3–32 حرفًا إنجليزيًا (حروف وأرقام ونقطة أو شرطة).' }, 400, origin);
    }

    const email = emailInput || shadowEmail(username);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'البريد الإلكتروني غير صالح.' }, 400, origin);
    }
    if (password.length < 8) {
      return json({ error: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل.' }, 400, origin);
    }

    const { data: existing } = await service
      .from('profiles')
      .select('id,email')
      .ilike('email', email)
      .maybeSingle();
    if (existing) {
      return json({ error: 'يوجد عضو مسجّل بهذا البريد بالفعل.' }, 409, origin);
    }

    const { data: created, error: createError } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName || username || email,
        created_by_manager: true,
        username: username || ''
      }
    });

    if (createError || !created?.user) {
      const message = createError?.message ?? '';
      if (/already registered|already exists/i.test(message)) {
        return json({ error: 'هذا البريد مُستخدم بالفعل في Supabase Auth.' }, 409, origin);
      }
      return json({ error: 'تعذر إنشاء العضو: ' + message }, 500, origin);
    }

    const userId = created.user.id;
    const { error: profileUpdateError } = await service
      .from('profiles')
      .update({
        role,
        status,
        full_name: fullName || username || email,
        note: String(payload.note ?? '').slice(0, 500)
      })
      .eq('id', userId);

    await logActivity('member.create', userId, {
      email,
      role,
      status,
      createdManually: true
    });

    if (profileUpdateError) {
      return json(
        { error: 'أُنشئ الحساب لكن تعذّر ضبط الدور. عدّل العضو من القائمة.', userId },
        207,
        origin
      );
    }

    return json(
      {
        ok: true,
        member: { id: userId, email, full_name: fullName || username || email, role, status },
        login: emailInput ? { mode: 'email', email } : { mode: 'username', username, email }
      },
      200,
      origin
    );
  }

  if (payload.action === 'set_password') {
    const memberId = String(payload.memberId ?? '');
    const password = String(payload.password ?? '');

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(memberId)) {
      return json({ error: 'معرّف العضو غير صالح.' }, 400, origin);
    }
    if (password.length < 8 || password.length > 128) {
      return json({ error: 'كلمة المرور يجب أن تكون بين 8 و128 حرفًا.' }, 400, origin);
    }

    const { data: target } = await service
      .from('profiles')
      .select('id,email')
      .eq('id', memberId)
      .maybeSingle();
    if (!target) {
      return json({ error: 'العضو غير موجود.' }, 404, origin);
    }

    const { error: updateError } = await service.auth.admin.updateUserById(memberId, { password });
    if (updateError) {
      return json({ error: 'تعذر تعيين كلمة المرور.' }, 500, origin);
    }

    await logActivity('member.set_password', memberId, { target: target.email ?? '' });
    return json({ ok: true }, 200, origin);
  }

  return json({ error: 'نوع الإجراء غير معروف.' }, 400, origin);
});
