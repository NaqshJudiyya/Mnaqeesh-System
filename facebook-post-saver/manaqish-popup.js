// شريط «مناقيش» داخل نافذة الإضافة:
// تسجيل الدخول، حالة الإرسال، وإرسال المنشورات المحفوظة إلى النظام.
//
// الإرسال في اتجاه واحد: من هذا الجهاز إلى مناقيش. التعديل والترجمة
// والمراجعة تحدث داخل النظام، ولا تنزّل الإضافة شيئًا.
(function () {
  const header = document.querySelector('.fps-header');
  if (!header) return;

  const bar = document.createElement('div');
  bar.className = 'mq-bar';
  header.appendChild(bar);

  const send = (type) => new Promise((resolve) => chrome.runtime.sendMessage({ type }, resolve));

  // A one-off confirmation shown after a manual send.
  let flash = '';

  async function render() {
    const s = await send('MANAQISH_STATUS');
    if (!s?.ok) return;

    if (!s.signedIn) {
      bar.innerHTML = `
        <span class="mq-label"><b>مناقيش</b> — سجّل الدخول لإرسال منشوراتك إلى الفريق</span>
        <button type="button" class="mq-btn mq-primary" data-act="login">تسجيل الدخول بجوجل</button>`;
      return;
    }

    const st = s.status || {};
    const warn = st.state === 'denied' || st.state === 'offline' || st.state === 'signed_out';
    const stateText = flash
      ? flash
      : st.message
        ? st.message
        : s.pending
          ? `${s.pending} بانتظار الإرسال…`
          : 'كل المنشورات مُرسلة ✓';

    bar.innerHTML = `
      <span class="mq-label"><b>مناقيش</b> · <span dir="ltr">${s.email}</span></span>
      <span class="mq-state ${warn ? 'mq-warn' : ''}">${stateText}</span>
      <button type="button" class="mq-btn" data-act="sync"
        title="أرسل المنشورات المحفوظة على هذا الجهاز إلى النظام. المنشورات المُرسلة سابقًا تُتجاهل.">إرسال منشوراتي</button>
      <button type="button" class="mq-btn mq-ghost" data-act="logout">خروج</button>`;
  }

  bar.addEventListener('click', async (e) => {
    const act = e.target?.dataset?.act;
    if (!act) return;

    if (act === 'login') {
      const s = await send('MANAQISH_STATUS');
      chrome.tabs.create({ url: `${s.siteUrl}/connect` });
      return;
    }

    if (act === 'sync') {
      const button = e.target;
      button.disabled = true;
      button.textContent = 'جارٍ الإرسال…';
      const result = await send('MANAQISH_SYNC_ALL');
      flash = result?.queued
        ? `تم إرسال ${result.queued} منشورًا ✓`
        : 'لا توجد منشورات جديدة للإرسال ✓';
      render();
      setTimeout(() => {
        flash = '';
        render();
      }, 6000);
      return;
    }

    if (act === 'logout') {
      if (confirm('تسجيل الخروج من مناقيش؟ منشوراتك المحلية لن تتأثر.')) {
        await send('MANAQISH_SIGN_OUT');
        flash = '';
        render();
      }
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('manaqish'))) render();
  });

  render();
})();
