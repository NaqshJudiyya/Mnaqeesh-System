# الاستضافة على GitHub Pages و Firebase Hosting — خطوات كاملة

منذ هذا الإصدار أصبح **موقع مناقيش تطبيقًا ثابتًا بالكامل**: كل شيء يعمل في المتصفح
ويتصل بـ Supabase مباشرة بهوية العضو نفسه، فلا يحتاج النظام أي سيرفر. لذلك يمكن
نشره مجانًا على أي مستضيف ملفات ثابتة — وهذا الدليل يغطي **GitHub Pages** و
**Firebase Hosting** (يمكن استخدامهما معًا: أحدهما أساسي والآخر مرآة).

> ## لماذا تغيّرت البنية؟
>
> GitHub Pages وFirebase Hosting (الخطة المجانية) يقدّمان **ملفات ثابتة فقط**، ولا
> يشغّلان كود Node. النسخة السابقة كانت تعتمد على سيرفر Next.js (مسارات API +
> مفتاح خدمة سري). التحويل تم هكذا:
>
> | كان (سيرفر Vercel) | صار (ثابت + Supabase) |
> |---|---|
> | مسارات `/api/*` تقرأ وتكتب بمفتاح الخدمة | المتصفح يقرأ ويكتب بـ JWT العضو نفسه، وسياسات RLS تقرر |
> | قواعد الصلاحيات في كود السيرفر | نفس القواعد أصبحت محفزات وسياسات داخل قاعدة البيانات (ترحيل 0007) |
> | مفتاح الخدمة في Vercel | مفتاح الخدمة في أسرار Edge Function واحدة فقط (إنشاء الأعضاء وكلمات المرور) |
> | بروكسي `/api/media` للتنزيل | روابط فيسبوك تُفتح مباشرة من الجدول (لا وسيط) |
> | جلسة «تبديل الحساب» في كوكي httpOnly | مخزنة في sessionStorage بنفس المتصفح (بعد التحقق من كلمة مرور العضو كما كان) |
>
> عقد الإضافة مع قاعدة البيانات (`post_key`, `post_date`, …) لم يُمَس، والإضافة
> تكمل العمل كما هي بعد تحديث عنوان الموقع فقط.

---

## الخطوة 1 — قاعدة البيانات (مطلوب مرة واحدة)

نفّذ في **Supabase → SQL Editor** بالترتيب، كل ملف كاملًا ثم Run:

1. `supabase/migrations/0001_mnaqeesh.sql`
2. `supabase/migrations/0002_post_content_editor.sql`
3. `supabase/migrations/0003_post_status_states.sql`
4. `supabase/migrations/0004_role_permissions.sql`
5. `supabase/migrations/0005_restore_deleted_on_resync.sql`
6. `supabase/migrations/0006_site_settings.sql`
7. `supabase/migrations/0007_static_hosting.sql` ← **هذا هو الجديد، وهو ما يجعل النسخة الثابتة آمنة**
   (منع تغيير صاحب البوست لغير المدير على مستوى القاعدة، حماية آخر مدير، منع ترجمة
   مترجم من حذف ترجمة غيره، RPC سجل النشاط، قراءة الإعدادات للزوار).

> كل الملفات آمنة للتشغيل أكثر من مرة.

## الخطوة 2 — انشر Edge Function (مطلوب مرة واحدة)

عمليتان فقط يحتاجان مفتاح الخدمة: **إنشاء عضو يدويًا** و**تعيين كلمة مرور عضو**.
هما في `supabase/functions/admin-members`:

```bash
# من داخل مجلد mnaqeesh-system (يتطلب تسجيل الدخول بـ supabase login أول مرة)
supabase functions deploy admin-members --project-ref czgxygcjyvfkhsuoearu

# النطاقات المسموح لها باستدعاء الدالة (ضع نطاق موقعك/مواقعك)
supabase secrets set ALLOWED_ORIGINS="https://YOUR-SITE-URL"
```

مفاتيح `SUPABASE_URL` و`SUPABASE_SERVICE_ROLE_KEY` تُحقن تلقائيًا في الدالة عند
النشر عبر CLI — **لا تضع مفتاح الخدمة في أي ملف أمامي أو مستودع**.

بدون هذه الخطوة: كل شيء يعمل ما عدا زرّي «+ إضافة عضو يدويًا» و«🔑 كلمة مرور».

## الخطوة 3 — بناء النسخة الثابتة محليًا (اختياري)

```bash
pnpm install
cp .env.example .env.local   # املأ العنوان والمفتاح العام
pnpm build                   # ينتج مجلد out/ جاهزًا للنشر
```

---

## الخيار أ — GitHub Pages

1. ارفع المستودع إلى GitHub، ثم أضف **سرّين على مستوى المستودع**
   (Settings → Secrets and variables → Actions → New repository secret) —
   هما مطلوبان وقت البناء لأن قيمهما تُحقن في ملفات الموقع:
   - `NEXT_PUBLIC_SUPABASE_URL` → `https://czgxygcjyvfkhsuoearu.supabase.co`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` → المفتاح العام (نفسه الموجود في الإضافة)
2. من إعدادات المستودع: **Settings → Pages → Source: GitHub Actions**.
3. الـ workflow الجاهز `.github/workflows/deploy-pages.yml` يبني وينشر تلقائيًا
   مع كل push على `main` (يمكن تشغيله يدويًا من تبويب Actions).
4. **مهم — عنوان الموقع:**
   - حساب/مستخدم: `https://<user>.github.io/` → لا شيء إضافي.
   - مشروع: `https://<user>.github.io/<repo>/` → في خطوة
     «Build static export» داخل الـ workflow فعّل سطر
     `NEXT_PUBLIC_BASE_PATH: /<repo>` (أزل `#` واكتب اسم مستودعك).

## الخيار ب — Firebase Hosting

```bash
npm install -g firebase-tools
firebase login
# أنشئ مشروعًا على console.firebase.google.com ثم:
firebase use --add          # اختر المشروع (يحدث .firebaserc)
pnpm build                  # ينتج out/
firebase deploy --only hosting
```

ملف `firebase.json` جاهز: يخدم مجلد `out/` مع تخزين مؤقت سليم للملفات الثابتة
و`no-cache` لملفات HTML. Firebase Hosting يتعامل مع المسارات النظيفة تلقائيًا.

> ملاحظة: Firebase هنا **استضافة فقط**. القاعدة والمصادقة تبقيان على Supabase —
> نقل المصادقة أو قاعدة البيانات إلى Firebase يكسر عقد الإضافة بالكامل ولا يُنصح به.

---

## الخطوة 4 — اربط Supabase بالنطاق الجديد

في Supabase → **Authentication → URL Configuration**:

- **Site URL**: نطاق موقعك الأساسي (مثال: `https://<user>.github.io` أو نطاق Firebase).
- **Redirect URLs**: أضف لكل نطاق:
  ```
  https://YOUR-SITE-URL/login
  https://YOUR-SITE-URL/connect
  ```

لاحظ أن العودة من Google صارت إلى `/login` مباشرة (المتصفح يبادل رمز PKCE بنفسه) —
لم تعد هناك صفحة `/auth/callback` على السيرفر.

## الخطوة 5 — وجّه الإضافة للنطاق الجديد

عدّل ملفين في الإضافة ثم أعد توزيعها:

1. `manaqish-config.js`:
   ```js
   siteUrl: 'https://YOUR-SITE-URL',
   ```
2. `manaqish-bridge.js` — ضع نطاقك في القائمة:
   ```js
   const MANAQISH_ALLOWED_HOSTS = ['your-site-host'];
   ```
   وفعّل مطابقة النطاق في `manifest.json` لملف الجسر.

بقية ملفات الإضافة لا تُلمس إطلاقًا.

---

## ما الذي تغيّر وظيفيًا؟ (شفافية كاملة)

| الميزة | الحالة |
|---|---|
| كل المنشورات، الترجمات، اللغات، السلة، الإجراءات الجماعية، تغيير صاحب البوست، إعدادات المظهر، التصدير بكل صيغه، الاستيراد، سجل النشاط | تعمل كما هي |
| إنشاء عضو يدويًا / تعيين كلمة مرور | تعمل عبر Edge Function (أول خطوتين أعلاه) |
| حماية القواعد (منع ترقية النفس، حماية آخر مدير، صاحب البوست للمدير فقط…) | أقوى من السابق: صارت على مستوى قاعدة البيانات نفسها |
| سجل «تبديل الحساب» | كلمة مرور العضو مطلوبة كما كان؛ جلسة المدير الأصلية محفوظة في sessionStorage بدل كوكي httpOnly (مقايضة معروفة للاستضافة الثابتة) |
| تنزيل الصور/الفيديو عبر بروكسي السيرفر | حُذف — الروابط تُفتح مباشرة من الجدول (فيسبوك يوقّع الروابط وتنتهي صلاحيتها كما كان) |
| سقف التصدير | 10,000 صف افتراضيًا (يُبنى في المتصفح)، قابل للرفع عبر `NEXT_PUBLIC_EXPORT_ROW_LIMIT` (بحد 50,000) |

## استكشاف الأخطاء

- **صفحة فارغة بعد تسجيل الدخول**: تأكد أن ترحيل 0007 نُفّذ (بدونه تُقرأ الصلاحيات بشكل مختلف).
- **«إضافة عضو يدويًا» لا تعمل**: خطوة نشر Edge Function لم تُنفذ أو `ALLOWED_ORIGINS` لا يطابق نطاق موقعك.
- **فشل تسجيل الدخول بجوجل**: أضف نطاق موقعك في **Redirect URLs** (الخطوة 4).
- **الإضافة تفتح صفحة الاتصال لكنها تفشل**: `siteUrl` في `manaqish-config.js` لا يطابق نطاق النشر، أو النطاق ليس في `MANAQISH_ALLOWED_HOSTS`.
- **صفحة بيضاء على GitHub Pages بموقع مشروع**: نسيت `NEXT_PUBLIC_BASE_PATH`.
