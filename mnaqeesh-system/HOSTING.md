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

# النطاقات المسموح لها باستدعاء الدالة (أصول مفصولة بفواصل — بدون مسارات):
# نطاق GitHub Pages + نطاق Vercel القديم (احذفه إن أوقفت نشر Vercel نهائيًا)
supabase secrets set ALLOWED_ORIGINS="https://naqshjudiyya.github.io,https://mnaqeesh.vercel.app"
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

## الخيار أ — GitHub Pages ✅ (الإعداد الحالي لهذا المستودع)

المستودع `NaqshJudiyya/Mnaqeesh-System` جاهز للنشر كما هو — الـ workflow
`.github/workflows/deploy-pages.yml` مضبوط بالكامل:

- **مسار القاعدة (Base path)** مضبوط على `/Mnaqeesh-System` لأن هذا مستودع
  مشروع (Project site) يُخدم تحت `https://naqshjudiyya.github.io/Mnaqeesh-System/`.
  > ⚠️ لو غيّرت اسم المستودع يومًا: حدّث `NEXT_PUBLIC_BASE_PATH` في الـ workflow
  > ليطابق الاسم الجديد **بنفس حالة الأحرف**، وإلا ظهرت صفحة بيضاء.
- **قيم Supabase** تُحقن وقت البناء، ومعها قيم احتياطية مكتوبة داخل الـ workflow
  (نفس القيم العامة الموجودة داخل الإضافة — آمنة بالتصميم لأن الحماية كلها في
  RLS). النتيجة: النشر يعمل حتى لو لم تضف أي أسرار. ولإضافة أسرار رسمية
  (اختياري): Settings → Secrets and variables → Actions:
  - `NEXT_PUBLIC_SUPABASE_URL` → `https://czgxygcjyvfkhsuoearu.supabase.co`
  - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` → المفتاح العام (نفسه في الإضافة)

الخطوة الوحيدة المطلوبة منك مرة واحدة (لا يمكن ضبطها من الملفات):

> **Settings → Pages → Build and deployment → Source: اختر «GitHub Actions»**

بعدها كل push على `main` (يغيّر `mnaqeesh-system/` أو الـ workflow) يبني وينشر
تلقائيًا، أو شغّله يدويًا من تبويب Actions → «Deploy مناقيش to GitHub Pages» →
Run workflow. عنوان الموقع النهائي:
**https://naqshjudiyya.github.io/Mnaqeesh-System/**

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

## الخطوة 4 — اربط Supabase بالنطاق الجديد (مطلوب مرة واحدة)

في Supabase → **Authentication → URL Configuration**:

- **Site URL**: `https://naqshjudiyya.github.io/Mnaqeesh-System`
- **Redirect URLs** — أضف الأربعة (بالمسار وبالشرطة المائلة، لأن Google يعيد
  المستخدم إلى `/login` ثم المتصفح يحوّلها إلى `/login/`):
  ```
  https://naqshjudiyya.github.io/Mnaqeesh-System/login
  https://naqshjudiyya.github.io/Mnaqeesh-System/login/
  https://naqshjudiyya.github.io/Mnaqeesh-System/connect
  https://naqshjudiyya.github.io/Mnaqeesh-System/connect/
  ```

لاحظ أن العودة من Google صارت إلى `/login` مباشرة (المتصفح يبادل رمز PKCE بنفسه) —
لم تعد هناك صفحة `/auth/callback` على السيرفر.

## الخطوة 5 — وجّه الإضافة للنطاق الجديد ✅ (منفّذة في هذا المستودع)

الملفات الثلاثة معدّلة فعلًا وأنتظرتها معك في المستودع:

1. `manaqish-config.js` → `siteUrl: 'https://naqshjudiyya.github.io/Mnaqeesh-System'`
2. `manaqish-bridge.js` → `MANAQISH_ALLOWED_HOSTS` فيها `naqshjudiyya.github.io` (ومعها نطاق Vercel القديم توافقًا)
3. `manifest.json` → نطاق `https://naqshjudiyya.github.io/*` في `host_permissions`
   وفي `content_scripts` لملف الجسر

الوحيد المتبقي: بعد مزامنة الملفات على أي جهاز فيه الإضافة —
`chrome://extensions` → زر التحديث (↻) على «Facebook Post Saver».

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
- **صفحة بيضاء على GitHub Pages بموقع مشروع**: القيمة مضبوطة أصلًا في الـ workflow
  (`NEXT_PUBLIC_BASE_PATH: /Mnaqeesh-System`) — تظهر المشكلة فقط لو تغيّر اسم
  المستودع دون تحديث هذه القيمة بنفس حالة الأحرف، أو لو لم تضبط Pages على
  Source: GitHub Actions.
