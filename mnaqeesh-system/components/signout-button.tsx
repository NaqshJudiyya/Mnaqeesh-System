'use client';

import { useState } from 'react';

export default function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch('/api/auth/signout', { method: 'POST' });
    } catch {
      // Even if the request fails, send the user to the login page.
    }
    window.location.href = '/login';
  }

  return (
    <button className="btn secondary small" onClick={signOut} disabled={busy}>
      {busy ? '…' : 'خروج'}
    </button>
  );
}
