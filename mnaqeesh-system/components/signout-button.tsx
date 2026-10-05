'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { appPath } from '@/lib/client/paths';

export default function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      // Signs out directly with Supabase — no server route needed on a
      // static host. Even on failure the user is sent to the login page.
      await createClient().auth.signOut();
    } catch {
      // Ignore and continue to the login page.
    }
    window.location.href = appPath('/login');
  }

  return (
    <button className="btn secondary small" onClick={signOut} disabled={busy}>
      {busy ? '…' : 'خروج'}
    </button>
  );
}
