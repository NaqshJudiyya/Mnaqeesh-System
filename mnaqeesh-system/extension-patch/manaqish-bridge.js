// =====================================================================
//  manaqish-bridge.js  —  الجسر بين صفحة الربط والإضافة
//
//  ⚠️ هذا الملف نسخة مُشدَّدة من الأصل. المنطق واحد، لكن أُضيف فحص
//  للنطاق (host) قبل قبول أي جلسة.
//
//  يعمل فقط على صفحة الربط في موقع مناقيش: يستلم الجلسة بعد تسجيل
//  الدخول بجوجل ويسلّمها للإضافة.
//
//  لماذا الفحص الإضافي؟
//  السطر `event.origin !== window.location.origin` وحده لا يحمي شيئًا،
//  لأنه يقارن أصل الرسالة بأصل الصفحة نفسها — وهذا يتحقق دائمًا. فإذا
//  كان الملف مُحقونًا في نطاق واسع مثل `https://*.vercel.app/*`، تستطيع
//  أي صفحة على أي نطاق فرعي من vercel.app أن ترسل للإضافة جلسة من عندها.
//
//  لذلك نضيف قائمة نطاقات مسموح بها.
// =====================================================================

// ✅ مضبوطة على موقعك — لن تحتاج تعديلها.
// استخدم دائمًا النطاق الرسمي https://mnaqeesh.vercel.app
// ولا تستخدم روابط المعاينة (mnaqeesh-xxxx-….vercel.app) لأنها محمية
// بـ Vercel SSO وتتغير مع كل نشر.
const MANAQISH_ALLOWED_HOSTS = [
  'mnaqeesh.vercel.app'
];

// يقبل النطاق المسموح نفسه وأي نطاق فرعي منه.
function manaqishHostAllowed() {
  const host = window.location.hostname.toLowerCase();
  return MANAQISH_ALLOWED_HOSTS.some(
    (allowed) => allowed && (host === allowed.toLowerCase() || host.endsWith('.' + allowed.toLowerCase()))
  );
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.source !== 'manaqish' || data.type !== 'MANAQISH_SESSION') return;

  // لا نقبل جلسة إلا من نطاق موقع مناقيش المعروف.
  if (!manaqishHostAllowed()) return;

  chrome.runtime.sendMessage({ type: 'MANAQISH_SET_SESSION', session: data.session }, (response) => {
    if (response?.ok) {
      window.postMessage({ source: 'fps-extension', type: 'MANAQISH_SESSION_ACK' }, window.location.origin);
    }
  });
});
