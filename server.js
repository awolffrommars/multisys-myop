const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
require('dotenv').config();

const QRCode = require('qrcode');
const { parseCSV } = require('./services/csv');
const { buildPhotoMap, findPhoto, normalizeNameKey, resolveMatches } = require('./services/matcher');
const { renderPoster, closeBrowser, renderPdf, renderPdfBatch, normalizePhone } = require('./services/poster');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Auth & Admin ──────────────────────────────────────────────────────────
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || '';
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    || '';
const WHITELIST      = new Set(
  (process.env.WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean)
);
const AUTH_ENABLED = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

// Fail closed in production: if we're clearly on a deployed environment
// (HuggingFace sets SPACE_ID) but the auth secrets didn't load, refuse to
// start rather than silently serving employee PII to the open internet.
if (!AUTH_ENABLED && (process.env.SPACE_ID || process.env.NODE_ENV === 'production')) {
  console.error('FATAL: production environment detected but GOOGLE_CLIENT_ID/SECRET are missing — refusing to start without auth.');
  process.exit(1);
}
if (AUTH_ENABLED && !process.env.SESSION_SECRET) {
  console.warn('[auth] SESSION_SECRET not set — sessions will not survive a restart.');
}

// Small wrapper: Express 4 does not catch async handler rejections — without
// this, a DB outage turns requests into permanent hangs.
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

let db;
try {
  db = require('./services/db');
  db.init().catch(e => console.error('DB init failed:', e.message));
} catch (e) { console.warn('DB unavailable:', e.message); }

// ─── Page templates ───────────────────────────────────────────────────────
const _PS = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,sans-serif;background:#090909;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:40px;width:100%;max-width:360px;text-align:center;position:relative;z-index:1;backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);box-shadow:0 0 0 1px rgba(0,0,0,0.4),0 24px 48px rgba(0,0,0,0.5)}.logo{font-size:20px;font-weight:700;margin-bottom:8px}.sub{font-size:13px;color:#555;margin-bottom:32px}.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:12px;background:#fff;color:#111;border:none;border-radius:100px;font-size:14px;font-weight:500;cursor:pointer;text-decoration:none}.btn:hover{background:#e8e8e8}.err{margin-bottom:20px;font-size:13px;color:#f87171}`;
const _GSVG = `<svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"/></svg>`;
const _HEAD = (title) => `<!DOCTYPE html><html><head><title>${title}</title><link rel="icon" href="/favicon.ico" type="image/x-icon"><style>${_PS}</style></head><body><div class="box"><img src="/logo-multisys.svg" alt="Multisys" style="height:32px;margin-bottom:16px"/><div class="logo">Make Your Own Poster</div><div class="sub">Multisys Internal Tool</div>`;

const loginPage = (err = '') => _HEAD('Sign In — MYOP') +
  (err ? `<div class="err">${err}</div>` : '') +
  `<a class="btn" href="/auth/google">${_GSVG} Sign in with Google</a></div>
<div id="bg-wrap" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none;overflow:hidden"></div>
<script type="module">
  import { ShaderMount, meshGradientFragmentShader, getShaderColorFromString } from 'https://esm.sh/@paper-design/shaders@0.0.76';
  const wrap = document.getElementById('bg-wrap');
  const colors = [
    getShaderColorFromString('#000000'),
    getShaderColorFromString('#0d0d0d'),
    getShaderColorFromString('#1a1a1a'),
    getShaderColorFromString('#262626'),
  ];
  while (colors.length < 10) colors.push([0, 0, 0, 1]);
  new ShaderMount(wrap, meshGradientFragmentShader, {
    u_colors:       colors,
    u_colorsCount:  4,
    u_distortion:   0.5,
    u_swirl:        0.4,
    u_grainMixer:   0.1,
    u_grainOverlay: 0.05,
    u_scale:        1,
  }, undefined, 1);
</script>
</body></html>`;

const waitingPage = (email) => _HEAD('Awaiting Approval — MYOP') +
  `<style>.spin{width:36px;height:36px;border:3px solid #333;border-top-color:#0099ff;border-radius:50%;animation:s .8s linear infinite;margin:0 auto 20px}@keyframes s{to{transform:rotate(360deg)}}</style>
  <div class="spin"></div>
  <p style="font-size:13px;color:#aaa;margin-bottom:8px">Your request has been sent to the admin.</p>
  <p style="font-size:12px;color:#555">This page will update automatically when approved.</p>
  <p style="font-size:11px;color:#444;margin-top:12px">${email}</p>
  <a href="/logout" style="display:block;margin-top:24px;font-size:12px;color:#555;text-decoration:none">Sign out</a>
  </div><script>setInterval(async()=>{const r=await fetch('/auth/status').then(r=>r.json()).catch(()=>({}));if(r.status==='approved')location.href='/';if(r.status==='denied')location.href='/denied';},5000);</script></body></html>`;

const deniedPage = () => _HEAD('Access Denied — MYOP') +
  `<p class="err" style="margin-bottom:20px">Your request was denied. Contact ${ADMIN_EMAIL} for help.</p>
  <a href="/logout" class="btn" style="justify-content:center;background:#1c1c1c;color:#fff;border:1px solid #333">Sign out</a>
  </div><script>setInterval(async()=>{const r=await fetch('/auth/status').then(r=>r.json()).catch(()=>({}));if(r.status==='approved')location.href='/';},5000);</script></body></html>`;

if (AUTH_ENABLED) {
  app.set('trust proxy', 1); // behind the HuggingFace HTTPS proxy
  app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false, saveUninitialized: false,
    // secure:'auto' → Secure flag when the (proxied) connection is HTTPS;
    // sameSite:'lax' → explicit CSRF baseline instead of browser defaults
    cookie: { secure: 'auto', httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
  }));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
  }, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value;
    if (!email) return done(null, false, { message: 'no-email' });
    if (ALLOWED_DOMAIN && !email.endsWith(`@${ALLOWED_DOMAIN}`))
      return done(null, false, { message: 'wrong-domain' });
    return done(null, { email, name: profile.displayName });
  }));

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  // Full access: whitelisted OR approved in DB
  const requireAccess = async (req, res, next) => {
    try {
      if (!req.isAuthenticated()) return res.redirect('/login');
      const { email } = req.user;
      if (WHITELIST.has(email)) { db?.updateLastSeen(email).catch(() => {}); return next(); }
      const user = db ? await db.getUser(email) : null;
      if (user?.status === 'approved') { db.updateLastSeen(email).catch(() => {}); return next(); }
      if (user?.status === 'denied') return res.redirect('/denied');
      // DB unavailable and not whitelisted: /waiting would poll forever — send back to login
      if (!db) { req.logout(() => {}); return res.redirect('/login?denied=1'); }
      return res.redirect('/waiting');
    } catch (e) { next(e); }
  };

  const requireAdmin = (req, res, next) => {
    if (!req.isAuthenticated() || req.user.email !== ADMIN_EMAIL) return res.status(403).send('Forbidden');
    next();
  };

  // ─── Auth routes ──────────────────────────────────────────────────────────
  app.get('/login', (req, res) =>
    res.send(loginPage(req.query.denied ? 'Your account does not have access.' : '')));

  app.get('/auth/google', passport.authenticate('google', { scope: ['email', 'profile'] }));

  app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login?denied=1' }),
    asyncH(async (req, res) => {
      const { email, name } = req.user;
      if (WHITELIST.has(email)) return res.redirect('/');
      if (!db) { req.logout(() => {}); return res.redirect('/login'); }
      const existing = await db.getUser(email);
      if (existing?.status === 'approved') return res.redirect('/');
      if (existing?.status === 'denied') { req.logout(() => {}); return res.redirect('/denied'); }
      await db.upsertPending(email, name);
      res.redirect('/waiting');
    })
  );

  app.get('/waiting', asyncH(async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    if (WHITELIST.has(req.user.email)) return res.redirect('/');
    const user = db ? await db.getUser(req.user.email) : null;
    if (user?.status === 'approved') return res.redirect('/');
    if (user?.status === 'denied')   return res.redirect('/denied');
    res.send(waitingPage(req.user.email));
  }));

  app.get('/denied',      (req, res) => res.send(deniedPage()));
  app.get('/logout',      (req, res) => req.logout(() => res.redirect('/login')));
  app.get('/auth/status', asyncH(async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ status: 'unauthenticated' });
    const { email } = req.user;
    if (WHITELIST.has(email)) return res.json({ status: 'approved' });
    const user = db ? await db.getUser(email) : null;
    res.json({ status: user?.status || 'pending' });
  }));
  app.get('/me', (req, res) => {
    if (req.isAuthenticated()) return res.json({ email: req.user.email, name: req.user.name, isAdmin: req.user.email === ADMIN_EMAIL });
    res.json({});
  });

  // ─── Admin routes ─────────────────────────────────────────────────────────
  app.get('/admin', requireAdmin, (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'admin.html')));

  app.get('/admin/data', requireAdmin, asyncH(async (req, res) => {
    if (!db) return res.json({ pending: [], approved: [], denied: [], history: [], errors: [], stats: { byTemplate: [], byUser: [], activity: [], totalPosters: 0 } });
    const [pending, approved, denied, history, errors, stats] = await Promise.all([
      db.getUsersByStatus('pending'),
      db.getUsersByStatus('approved'),
      db.getUsersByStatus('denied'),
      db.getHistory(Math.min(parseInt(req.query.historyDays, 10) || 30, 3650)),
      db.getErrors(50),
      db.getStats(),
    ]);
    res.json({ pending, approved, denied, history, errors, stats });
  }));

  app.post('/admin/approve/:email', requireAdmin, asyncH(async (req, res) => {
    const email = decodeURIComponent(req.params.email);
    if (db) await db.updateStatus(email, 'approved');
    res.json({ ok: true });
  }));

  app.post('/admin/deny/:email', requireAdmin, asyncH(async (req, res) => {
    if (db) await db.updateStatus(decodeURIComponent(req.params.email), 'denied');
    res.json({ ok: true });
  }));

  app.post('/admin/revoke/:email', requireAdmin, asyncH(async (req, res) => {
    if (db) await db.updateStatus(decodeURIComponent(req.params.email), 'denied');
    res.json({ ok: true });
  }));

  // ─── Protect app routes ───────────────────────────────────────────────────
  // NOTE: Express mount paths match at `/` boundaries only — `/download` does
  // NOT cover `/download-pdf`; every data-returning route needs its own mount.
  app.use('/index.html',      requireAccess);
  app.use('/prepare',         requireAccess);
  app.use('/generate',        requireAccess);
  app.use('/preview',         requireAccess);
  app.use('/download',        requireAccess);
  app.use('/download-pdf',    requireAccess);
  app.use('/regenerate',      requireAccess);
  app.use('/job',             requireAccess);
  app.use('/qr-preview',      requireAccess);
  app.use('/reload-template', requireAdmin);

  app.get('/', requireAccess, (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'index.html')));
}

// Block direct static access to admin.html — the /admin route has requireAdmin
if (AUTH_ENABLED) {
  app.use('/admin.html', (req, res) => res.status(403).send('Forbidden'));
}

app.use(express.static('public'));

// Load template PNGs at startup
const TEMPLATE_FILES = {
  'new-employee': 'New Employee Poster_Template.png',
  'birthday':     'Birthday Poster_Template.png',
  'anniversary':  'Work Anniversary_Template.png',
  'calling-card':      'Calling-Card-FRONT_Template.png',
  'calling-card-back': 'Calling-Card-BACK_Template.png',
  'multisys-id':      'Multsys-ID-FRONT_Template.png',
  'multisys-id-back': 'Multsys-ID-BACK_Template.png',
};
const templates = {};

function loadTemplates() {
  for (const [key, file] of Object.entries(TEMPLATE_FILES)) {
    const p = path.join(__dirname, 'templates', file);
    if (fs.existsSync(p)) {
      templates[key] = fs.readFileSync(p).toString('base64');
      console.log(`✓ Template loaded: ${file}`);
    } else {
      console.warn(`⚠  Template not found: ${file}`);
    }
  }
}

loadTemplates();

// ── Shared helpers ────────────────────────────────────────────────────────────

function lastFirst(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`;
}

const MONTH_NUM = {january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',july:'07',august:'08',september:'09',october:'10',november:'11',december:'12'};
function dateHiredPrefix(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const mm = MONTH_NUM[parts[0].toLowerCase()];
  const dd = String(parts[1]).padStart(2, '0');
  return (mm && dd) ? `${mm}-${dd}` : null;
}

// PDF dimensions and filename labels per paired template
const PDF_CONFIG = {
  'multisys-id':  { pageWidth: '508mm', pageHeight: '807mm', label: 'Multisys ID' },
  'calling-card': { pageWidth: '508mm', pageHeight: '304mm', label: 'Calling Card' },
};

// Default ZIP name when no suffix is provided
const ZIP_NAMES = {
  'birthday':     'Birthday-Posters',
  'anniversary':  'Anniversary-Posters',
  'calling-card': 'Calling-Card-Posters',
  'multisys-id':  'Multisys-ID-Posters',
  'new-employee': 'New-Employee-Posters',
};

// Templates that don't require a photo upload
const NO_PHOTO_TEMPLATES = new Set(['calling-card']);

// ─────────────────────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  // 500 photos + 500 signatures (multisys-id) + 1 CSV. The old 501 silently
  // rejected any ID batch that supplied a signature per employee.
  // Total bytes are separately capped by MAX_PREPARE_BYTES below.
  limits: { fileSize: 20 * 1024 * 1024, files: 1001 },
});

// In-memory job store with TTL eviction (2 hours)
const jobs = new Map();
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
// A 'generating' job idle this long is treated as abandoned (see /generate)
const STALE_GENERATE_MS = 30 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if ((job.createdAt || 0) < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

// `format` lands in `data:image/${format};base64,...` inside a src="" attribute in
// the render browser, so a crafted upload mimetype ("image/png\"><script>") could
// break out of the attribute. Batch uploads are safe (matcher.js hardcodes 'png');
// this guards the /regenerate path, where the mimetype is client-supplied.
const SAFE_IMAGE_FORMATS = new Set(['png', 'jpeg', 'jpg', 'webp', 'gif', 'avif']);
function safeImageFormat(mimetype) {
  const sub = String(mimetype || '').split('/')[1]?.toLowerCase().trim();
  return SAFE_IMAGE_FORMATS.has(sub) ? sub : 'png';
}

// A job holds employee PII (addresses, SSS/TIN/PhilHealth, emergency contacts) and
// the rendered cards. Being an approved user is not enough — you must own the job.
// Returns null for "not yours" as well as "not found" so the 404 doesn't confirm
// that some other user's job id exists.
function ownedJob(req, jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (!AUTH_ENABLED) return job;          // local dev: no identity to check against
  if (job.owner && job.owner !== req.user?.email) return null;
  return job;
}

// job.photos/job.signatures keep Buffer REFERENCES to bytes already held by
// photoMap/signatureMap — storing a base64 STRING copy instead duplicated every
// upload at ~1.33x size (a 500-employee ID batch held ~6.5 GB of redundant string).
// Convert to the renderer's shape only at render time.
function toRenderData(ref) {
  if (!ref) return null;
  if (ref.base64) return ref;             // already render-shaped
  if (ref.buffer) return { base64: ref.buffer.toString('base64'), format: ref.format };
  return null;
}

// Reload templates from disk without restarting
app.post('/reload-template', (req, res) => {
  loadTemplates();
  res.json({ ok: true, loaded: Object.keys(templates) });
});

// QR preview for calling card manual entry
app.get('/qr-preview', async (req, res) => {
  // String() — a repeated query param (?mobile=a&mobile=b) arrives as an array
  const raw = String(req.query.mobile || '').trim();
  if (!raw) return res.status(400).send('mobile required');
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return res.status(400).send('number too short');
  try {
    const uri = normalizePhone(raw) || ('tel:' + digits);
    const size = Math.min(Math.max(parseInt(req.query.size) || 160, 80), 600);
    const png = await QRCode.toBuffer(uri, { errorCorrectionLevel: 'H', width: size, margin: 1 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(png);
  } catch (err) {
    res.status(500).send('QR generation failed');
  }
});

// Reject absurdly large uploads before multer buffers them into memory —
// per-file limits alone still allow ~10GB across 500 files in one request
const MAX_PREPARE_BYTES = 300 * 1024 * 1024;
app.use('/prepare', (req, res, next) => {
  const len = parseInt(req.headers['content-length'], 10);
  if (len && len > MAX_PREPARE_BYTES) {
    return res.status(413).json({ error: 'Upload too large — keep the total batch under 300 MB.' });
  }
  next();
});

// Step 1: Upload CSV + photos, return preview
app.post('/prepare', upload.fields([
  { name: 'csv', maxCount: 1 },
  { name: 'photos' },
  { name: 'signatures' },
]), (req, res) => {
  try {
    const templateKey = req.body?.template || 'new-employee';
    const noPhotoTemplate = NO_PHOTO_TEMPLATES.has(templateKey);
    if (!templates[templateKey] && !noPhotoTemplate) {
      return res.status(400).json({ error: `Template "${templateKey}" is not loaded.` });
    }

    const csvFile = req.files?.csv?.[0];
    const photoFiles = req.files?.photos || [];

    if (!csvFile) return res.status(400).json({ error: 'No CSV file uploaded.' });

    const employees = parseCSV(csvFile.buffer, templateKey);
    if (employees.length === 0) {
      return res.status(400).json({ error: 'CSV is empty or could not be parsed.' });
    }

    // Validate CSV format matches the selected template (batch uploads only — manual builds its own CSV)
    const inputMode = req.body?.inputMode || 'csv';
    if (inputMode === 'csv') {
      const datePattern = /^(january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}[\/\-])/i;
      if (templateKey === 'new-employee' && datePattern.test(employees[0].fullName)) {
        return res.status(400).json({ error: 'This CSV looks like a Birthday or Work Anniversary CSV (first column is a date). Switch to the correct template, or upload a New Employee CSV with columns: Full Name, Position, Department.' });
      }
      if (templateKey === 'birthday' && employees[0].birthdayDate && !datePattern.test(employees[0].birthdayDate)) {
        return res.status(400).json({ error: 'This CSV looks like a New Employee poster CSV (no birthday date in first column). Switch to the New Employee Poster template, or upload a Birthday CSV with columns: Birthday, Full Name, Position, Division, Department.' });
      }
      if (templateKey === 'birthday' && /^\d+$/.test((employees[0].fullName || '').trim())) {
        return res.status(400).json({ error: 'This looks like a Work Anniversary CSV (has a Years column). Switch to the Work Anniversary template or upload a Birthday CSV.' });
      }
      if (templateKey === 'anniversary') {
        const yearsVal = String(employees[0].anniversaryYears || '').trim();
        if (!yearsVal || !/^\d+$/.test(yearsVal)) {
          return res.status(400).json({ error: 'This CSV is not a valid Work Anniversary CSV — no Years column found. Expected columns: Date Hired, Years, Full Name, Position, Division, Department.' });
        }
      }
    }

    const photoMap     = buildPhotoMap(photoFiles);
    const signatureMap = buildPhotoMap(req.files?.signatures || []);

    // Resolve the whole batch at once rather than per employee: exact matches claim
    // their file first, then each remaining employee takes its uniquely best
    // leftover, and any file wanted by two employees is withdrawn from both.
    // Per-employee matching can't see those collisions and would hand the same
    // photo to two people.
    const empNames  = employees.map(e => e.fullName);
    const photoRes  = resolveMatches(empNames, photoMap);
    const sigRes    = templateKey === 'multisys-id'
      ? resolveMatches(empNames, signatureMap)
      : { matches: new Map(), ambiguous: [] };

    const preview = employees.map(emp => ({
      ...emp,
      photoFound:     noPhotoTemplate ? true : photoRes.matches.has(normalizeNameKey(emp.fullName)),
      signatureFound: templateKey === 'multisys-id' ? sigRes.matches.has(normalizeNameKey(emp.fullName)) : undefined,
    }));

    // Signatures are optional — posters render with the signature overlay hidden
    // when absent, and one can be added later via the edit modal (/regenerate)

    const jobId = crypto.randomUUID();
    // Store the resolution, not just the maps — /generate must render exactly what
    // the preview promised, and re-resolving there could differ.
    jobs.set(jobId, { employees, photoMap, signatureMap, photoMatches: photoRes.matches, signatureMatches: sigRes.matches, posters: [], photos: [], signatures: [], status: 'ready', templateKey, noPhotoTemplate, createdAt: Date.now(), owner: AUTH_ENABLED ? req.user?.email : null });

    // Two uploaded files normalizing to the same employee — warn instead of silently keeping the last
    const duplicateFiles = [...(photoMap.duplicates || []), ...(signatureMap.duplicates || [])];
    // Files the loose matcher refused to assign because more than one reading fits
    const ambiguousMatches = [...photoRes.ambiguous, ...sigRes.ambiguous].map(a =>
      a.file
        ? `"${a.file}" could be ${a.employees.join(' or ')}`
        : `${a.employee} matches several files: ${a.files.map(f => `"${f}"`).join(', ')}`);
    res.json({
      jobId,
      employees: preview,
      duplicateFiles: duplicateFiles.length ? duplicateFiles : undefined,
      ambiguousMatches: ambiguousMatches.length ? ambiguousMatches : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 2: Generate posters (SSE stream)
app.get('/generate/:jobId', async (req, res) => {
  const job = ownedJob(req, req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  // A run whose server died mid-generation leaves status stuck at 'generating',
  // and the guard below then closes every reconnect empty — the client retries
  // every ~3s until the 2-hour TTL evicts the job. Treat a run with no progress
  // for STALE_GENERATE_MS as abandoned and allow a fresh attempt. Deliberately
  // generous: a legitimately slow batch must never be restarted underneath itself.
  if (job.status === 'generating' && job.startedAt && (Date.now() - job.startedAt) > STALE_GENERATE_MS) {
    console.warn(`[generate] job ${req.params.jobId} stale for ${Math.round((Date.now() - job.startedAt) / 60000)}min — allowing retry`);
    job.status = 'ready';
  }
  // Block re-runs: EventSource auto-reconnects after the stream closes, which would
  // reset job.photos and corrupt in-flight or completed regenerate calls.
  if (job.status !== 'ready') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    if (job.status === 'done') {
      // Generation complete — send count AND rendered names so a reconnected
      // client builds a gallery aligned with posters[] (front+back pairs = 1)
      const fronts = job.posters.filter(p => p.side !== 'back');
      res.write(`data: ${JSON.stringify({ type: 'complete', count: fronts.length, names: fronts.map(p => p.name) })}\n\n`);
    } else if (job.status === 'error') {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Generation failed.' })}\n\n`);
    }
    // 'generating': send nothing; EventSource will retry in ~3s and check again
    res.end();
    return;
  }

  job.status = 'generating';
  job.startedAt = Date.now();
  job.posters = [];
  job.photos = [];
  job.signatures = []; // must reset with posters/photos to keep 1:1 index alignment

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  function emit(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function classifyError(msg = '') {
    const m = msg.toLowerCase();
    if (m.includes('timeout') || m.includes('timed out'))                                       return 'Timeout';
    if (m.includes('net::') || m.includes('err_network') || m.includes('connection refused'))   return 'Network error';
    if (m.includes('protocol error') || m.includes('session closed') || m.includes('target closed') || m.includes('browser has been closed')) return 'Browser crash';
    if (m.includes('enoent') || m.includes('no such file'))                                     return 'Missing file';
    return 'Render failure';
  }

  const CONCURRENCY = 2; // render 2 posters at a time

  try {
    for (let i = 0; i < job.employees.length; i += CONCURRENCY) {
      const batch = job.employees.slice(i, i + CONCURRENCY);

      const results = await Promise.all(batch.map(async (emp, bi) => {
        const row = i + bi + 1;
        emit({ type: 'progress', row, name: emp.fullName, position: emp.position, department: emp.department, division: emp.division, birthdayDate: emp.birthdayDate, status: 'processing' });

        const noPhoto = job.noPhotoTemplate;
        // Use the resolution computed at /prepare time so the rendered set matches
        // the preview exactly (falls back for jobs predating the resolution).
        const _empKey = normalizeNameKey(emp.fullName);
        const photoResult = noPhoto ? null
          : (job.photoMatches ? job.photoMatches.get(_empKey) || null : findPhoto(emp.fullName, job.photoMap));
        if (!photoResult && !noPhoto) {
          emit({ type: 'progress', row, name: emp.fullName, position: emp.position, department: emp.department, division: emp.division, birthdayDate: emp.birthdayDate, status: 'skipped', message: 'No photo' });
          return null;
        }

        // Refs are what the job retains; the base64 form is built for this render only
        const photoRef = photoResult ? { buffer: photoResult.buffer, format: photoResult.format } : null;
        const photoData = toRenderData(photoRef);

        const sigResult = job.templateKey !== 'multisys-id' ? null
          : (job.signatureMatches ? job.signatureMatches.get(_empKey) || null : findPhoto(emp.fullName, job.signatureMap));
        const signatureRef = sigResult ? { buffer: sigResult.buffer, format: sigResult.format } : null;
        const signatureData = toRenderData(signatureRef);

        const empData = { fullName: emp.fullName, position: emp.position, department: emp.department, division: emp.division, birthdayDate: emp.birthdayDate, anniversaryYears: emp.anniversaryYears, dateHired: emp.dateHired, email: emp.email, mobile: emp.mobile, employeeNumber: emp.employeeNumber, address: emp.address, phoneNumber: emp.phoneNumber, philhealth: emp.philhealth, sss: emp.sss, tin: emp.tin, hdmf: emp.hdmf, contactName: emp.contactName, contactAddress: emp.contactAddress, contactNumber: emp.contactNumber };

        try {
          const frontBuffer = await renderPoster(empData, photoData, templates[job.templateKey], null, job.templateKey, signatureData);

          let backBuffer = null;
          if (job.templateKey === 'multisys-id' && templates['multisys-id-back']) {
            backBuffer = await renderPoster(empData, null, templates['multisys-id-back'], null, 'multisys-id-back', null);
          } else if (job.templateKey === 'calling-card' && templates['calling-card-back']) {
            backBuffer = await renderPoster(empData, null, templates['calling-card-back'], null, 'calling-card-back', null);
          }

          emit({ type: 'progress', row, name: emp.fullName, position: emp.position, department: emp.department, division: emp.division, birthdayDate: emp.birthdayDate, status: 'done' });

          if (backBuffer) {
            const backKey = job.templateKey === 'multisys-id' ? 'multisys-id-back' : 'calling-card-back';
            return [
              { photoRef, signatureRef, name: emp.fullName, buffer: frontBuffer, dateHired: emp.dateHired, birthdayDate: emp.birthdayDate, posterTemplateKey: job.templateKey, side: 'front' },
              { photoRef: null, signatureRef: null, name: emp.fullName, buffer: backBuffer, dateHired: emp.dateHired, birthdayDate: emp.birthdayDate, posterTemplateKey: backKey, side: 'back' },
            ];
          }
          return { photoRef, signatureRef, name: emp.fullName, buffer: frontBuffer, dateHired: emp.dateHired, birthdayDate: emp.birthdayDate };
        } catch (err) {
          emit({ type: 'progress', row, name: emp.fullName, status: 'error', message: err.message });
          if (AUTH_ENABLED && req.user && db) {
            try { await db.logError(req.user.email, job.templateKey, emp.fullName, classifyError(err.message), err.message); } catch {}
          }
          return null;
        }
      }));

      // Push results in original order; multisys-id returns [front, back] arrays
      for (const result of results) {
        if (!result) continue;
        const items = Array.isArray(result) ? result : [result];
        for (const r of items) {
          job.photos.push(r.photoRef);
          job.signatures.push(r.signatureRef);
          job.posters.push({ name: r.name, buffer: r.buffer, dateHired: r.dateHired, birthdayDate: r.birthdayDate, posterTemplateKey: r.posterTemplateKey, side: r.side });
        }
      }
    }

    job.status = 'done';
    // Front+back pairs count as one poster (calling-card, multisys-id)
    const frontPosters = job.posters.filter(p => p.side !== 'back');
    if (AUTH_ENABLED && req.user && db) {
      const durationMs = Date.now() - job.startedAt;
      try { await db.logHistory(req.user.email, job.templateKey, frontPosters.length, frontPosters.map(p => p.name), durationMs); } catch {}
    }

    // names lets the client align gallery cards with posters[] even when some
    // employees errored mid-batch (errored renders push nothing)
    emit({ type: 'complete', count: frontPosters.length, names: frontPosters.map(p => p.name) });
    res.end();
  } catch (err) {
    job.status = 'error';
    emit({ type: 'error', message: err.message });
    if (AUTH_ENABLED && req.user && db) {
      try { await db.logError(req.user.email, job.templateKey, null, 'Server error', err.message); } catch {}
    }
    res.end();
  } finally {
    await closeBrowser();
  }
});

// Regenerate a single poster with updated details
app.post('/regenerate/:jobId/:index', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'signature', maxCount: 1 }]), async (req, res) => {
  const job = ownedJob(req, req.params.jobId);
  const index = parseInt(req.params.index, 10);
  if (!job || !job.posters[index]) return res.status(404).json({ error: 'Poster not found.' });
  const poster = job.posters[index];
  const posterTemplateKey = poster.posterTemplateKey || job.templateKey;
  const isBackCard = posterTemplateKey === 'multisys-id-back' || posterTemplateKey === 'calling-card-back';

  const { fullName, firstName, lastName, position, department, division, birthdayDate, anniversaryYears, dateHired, originalName, email, mobile, employeeNumber, address, phoneNumber, philhealth, sss, tin, hdmf, contactName, contactAddress, contactNumber } = req.body || {};
  // Validate before normalizeNameKey(fullName) — undefined would throw outside the try
  if (typeof fullName !== 'string' || !fullName.trim()) {
    return res.status(400).json({ error: 'fullName is required.' });
  }

  const photoFile = req.files?.photo?.[0];
  let photoRef = null;
  if (photoFile) {
    const format = safeImageFormat(photoFile.mimetype);
    photoRef = { buffer: photoFile.buffer, format };
    const _pName = Buffer.from(photoFile.originalname, 'latin1').toString('utf8');
    const _pEntry = { buffer: photoFile.buffer, format, originalName: _pName, baseName: _pName.replace(/\.[^.]+$/, '') };
    job.photoMap.set(normalizeNameKey(fullName), _pEntry);
    // Keep the stored resolution in step with the map, or a later job reset +
    // re-generate would fall back to the pre-upload matching
    job.photoMatches?.set(normalizeNameKey(fullName), _pEntry);
  } else {
    photoRef = job.photos?.[index] || null;
    if (!photoRef) {
      const photoResult = findPhoto(fullName, job.photoMap) ||
        (originalName ? findPhoto(originalName, job.photoMap) : null);
      if (photoResult) photoRef = { buffer: photoResult.buffer, format: photoResult.format };
    }
  }
  const photoData = toRenderData(photoRef);

  if (!photoData && !job.noPhotoTemplate && !isBackCard) return res.status(400).json({ error: 'No photo available for this employee.' });

  const sigFile = req.files?.signature?.[0];
  let signatureRef = null;
  if (sigFile) {
    const format = safeImageFormat(sigFile.mimetype);
    signatureRef = { buffer: sigFile.buffer, format };
    if (!job.signatureMap) job.signatureMap = new Map();
    const _sName = Buffer.from(sigFile.originalname, 'latin1').toString('utf8');
    const _sEntry = { buffer: sigFile.buffer, format, originalName: _sName, baseName: _sName.replace(/\.[^.]+$/, '') };
    job.signatureMap.set(normalizeNameKey(fullName), _sEntry);
    job.signatureMatches?.set(normalizeNameKey(fullName), _sEntry);
  } else {
    signatureRef = job.signatures?.[index] || null;
    if (!signatureRef && job.signatureMap) {
      const sigResult = findPhoto(fullName, job.signatureMap);
      if (sigResult) signatureRef = { buffer: sigResult.buffer, format: sigResult.format };
    }
  }
  const signatureData = toRenderData(signatureRef);

  const empData = { fullName, firstName, lastName, position, department, division, birthdayDate, anniversaryYears, dateHired, email, mobile, employeeNumber, address, phoneNumber, philhealth, sss, tin, hdmf, contactName, contactAddress, contactNumber };
  try {
    const pngBuffer = await renderPoster(
      empData,
      isBackCard ? null : photoData,
      templates[posterTemplateKey],
      null,
      posterTemplateKey,
      isBackCard ? null : signatureData
    );
    job.photos[index] = isBackCard ? null : photoRef;
    job.signatures[index] = isBackCard ? null : signatureRef;
    // Preserve date fields — /download builds MM-DD filename prefixes from them
    job.posters[index] = { name: fullName, buffer: pngBuffer, dateHired: dateHired || poster.dateHired, birthdayDate: birthdayDate || poster.birthdayDate, posterTemplateKey, side: poster.side };
    if (!isBackCard && photoRef?.buffer) {
      // Reuse the existing Buffer — the old code round-tripped base64 back into a
      // second copy of the same bytes on every regenerate
      job.photoMap.set(normalizeNameKey(fullName), { buffer: photoRef.buffer, format: photoRef.format, originalName: fullName });
    }
    // For front edits on two-sided templates, auto-regenerate the paired back card
    const backTemplateKey = job.templateKey === 'multisys-id' ? 'multisys-id-back'
                          : job.templateKey === 'calling-card' ? 'calling-card-back'
                          : null;
    if (backTemplateKey && poster.side === 'front' && templates[backTemplateKey]) {
      const backIndex = index + 1;
      if (job.posters[backIndex] && job.posters[backIndex].side === 'back') {
        try {
          const backBuffer = await renderPoster(empData, null, templates[backTemplateKey], null, backTemplateKey, null);
          job.posters[backIndex] = { ...job.posters[backIndex], name: fullName, buffer: backBuffer };
        } catch (e) {
          console.warn('[regenerate] back card auto-render failed:', e.message);
        }
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dev: return job metadata for quick reload without re-uploading
app.get('/job/:jobId', (req, res) => {
  const job = ownedJob(req, req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  res.json({
    status: job.status,
    template: job.templateKey,
    count: job.posters.length,
    employees: job.employees,
  });
});

// Dev: reset job so /generate re-renders all posters
app.post('/job/:jobId/reset', (req, res) => {
  const job = ownedJob(req, req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  // Resetting mid-generation would let a second /generate interleave pushes
  // into posters[]/photos[], corrupting every index-based lookup
  if (job.status === 'generating') return res.status(409).json({ error: 'Job is currently generating — wait for it to finish.' });
  job.status = 'ready';
  job.posters = [];
  job.photos = [];
  job.signatures = [];
  res.json({ ok: true });
});

// Preview: serve individual poster PNG
app.get('/preview/:jobId/:index', (req, res) => {
  const job = ownedJob(req, req.params.jobId);
  const index = parseInt(req.params.index, 10);
  if (!job || !job.posters[index]) {
    return res.status(404).send('Not found');
  }
  res.setHeader('Content-Type', 'image/png');
  res.send(job.posters[index].buffer);
});

// Download paired-card template as PDF (front + back)
app.get('/download-pdf/:jobId/:empIdx', async (req, res) => {
  const job = ownedJob(req, req.params.jobId);
  const empIdx = parseInt(req.params.empIdx, 10);
  // Locate the Nth front by scanning sides. `empIdx * 2` assumed every employee
  // produced exactly two posters — if a back template fails to load, one poster is
  // pushed per employee and every index past the first pointed at the wrong person.
  if (!job) return res.status(404).json({ error: 'Poster not found.' });
  let frontIdx = -1, seen = 0;
  for (let i = 0; i < job.posters.length; i++) {
    if (job.posters[i].side === 'back') continue;
    if (seen === empIdx) { frontIdx = i; break; }
    seen++;
  }
  if (frontIdx < 0) return res.status(404).json({ error: 'Poster not found.' });
  const next = job.posters[frontIdx + 1];
  const backIdx = (next && next.side === 'back') ? frontIdx + 1 : -1;
  const cfg = PDF_CONFIG[job.templateKey];
  if (!cfg) return res.status(400).json({ error: 'PDF download not supported for this template.' });
  try {
    const frontBuf = job.posters[frontIdx].buffer;
    const backBuf  = backIdx >= 0 ? job.posters[backIdx].buffer : null;
    const empName  = job.posters[frontIdx].name || '';
    const pdfBuffer = await renderPdf(frontBuf, backBuf, { pageWidth: cfg.pageWidth, pageHeight: cfg.pageHeight });
    const fileBase = headerSafe(`${lastFirst(empName)}-${cfg.label}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: 'PDF generation failed: ' + err.message });
  }
});

// Quotes/control chars in a Content-Disposition filename produce a malformed header
function headerSafe(s) {
  return String(s).replace(/["\\\r\n\x00-\x1f]/g, '');
}

// Download ZIP
app.get('/download/:jobId', async (req, res) => {
  const job = ownedJob(req, req.params.jobId);
  if (!job || !job.posters.length) {
    return res.status(404).json({ error: 'No ZIP available. Run generation first.' });
  }
  // String() — a repeated query param arrives as an array and .replace would throw
  const suffix = String(req.query.suffix || '');

  // Templates whose single-poster download is a 2-page PDF ("Save PDF") must ZIP
  // as PDFs too — front+back paired per employee, not raw PNG sides.
  const pdfCfg = PDF_CONFIG[job.templateKey];
  if (pdfCfg) {
    try {
      const pairs = [];
      const names = [];
      for (let i = 0; i < job.posters.length; i++) {
        const p = job.posters[i];
        if (p.side === 'back') continue; // consumed alongside its front
        const next = job.posters[i + 1];
        pairs.push({ front: p.buffer, back: (next && next.side === 'back') ? next.buffer : null });
        names.push(`${lastFirst(p.name)}-${suffix || pdfCfg.label}`);
      }
      const pdfs = await renderPdfBatch(pairs, { pageWidth: pdfCfg.pageWidth, pageHeight: pdfCfg.pageHeight });
      const zipBuffer = await buildZip(pdfs.map((buffer, i) => ({ buffer, name: names[i], ext: 'pdf' })));
      const zipName = headerSafe(suffix ? `${suffix}.zip` : `${ZIP_NAMES[job.templateKey] || 'Posters'}.zip`);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
      res.setHeader('Content-Length', zipBuffer.length);
      return res.send(zipBuffer);
    } catch (err) {
      return res.status(500).json({ error: 'ZIP generation failed: ' + err.message });
    }
  }

  const named = job.posters.map(p => {
    const sideTag = p.side === 'back' ? '-Back' : '';
    let base, prefix;
    if (job.templateKey === 'birthday') {
      const label = suffix.replace(/-\d{6}$/, '') || 'Birthday Poster';
      base = `${lastFirst(p.name)}-${label}${sideTag}`;
      prefix = dateHiredPrefix(p.birthdayDate);
    } else if (job.templateKey === 'anniversary') {
      const label = suffix.replace(/-\d{6}$/, '') || 'Work Anniversary Poster';
      base = `${lastFirst(p.name)}-${label}${sideTag}`;
      prefix = dateHiredPrefix(p.dateHired);
    } else {
      base = suffix ? `${lastFirst(p.name)}-${suffix}${sideTag}` : `${lastFirst(p.name)}${sideTag}`;
      prefix = null;
    }
    return { buffer: p.buffer, name: prefix ? `${prefix}-${base}` : base };
  });
  try {
    const zipBuffer = await buildZip(named);
    const zipSuffix = (job.templateKey === 'birthday' || job.templateKey === 'anniversary') ? suffix.replace(/-\d{6}$/, '') : suffix;
    const zipName = headerSafe(zipSuffix ? `${zipSuffix}.zip` : `${ZIP_NAMES[job.templateKey] || 'Posters'}.zip`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.setHeader('Content-Length', zipBuffer.length);
    res.send(zipBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildZip(posters) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const pass = new PassThrough();
    pass.on('data', chunk => chunks.push(chunk));
    pass.on('end', () => resolve(Buffer.concat(chunks)));
    pass.on('error', reject);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', reject);
    archive.pipe(pass);

    for (const { name, buffer, ext } of posters) {
      archive.append(buffer, { name: `${name}.${ext || 'png'}` });
    }

    archive.finalize();
  });
}

// JSON error handler — asyncH-forwarded rejections land here instead of hanging
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, err.code || '', err.message);
  if (res.headersSent) return next(err);
  // Multer limit breaches are user-fixable; a generic 500 tells the user nothing
  // about which file to shrink or how many they may send.
  const MULTER_MESSAGES = {
    LIMIT_FILE_SIZE:      ['One of the files is over the 20 MB limit — shrink it and try again.', 413],
    LIMIT_FILE_COUNT:     ['Too many files in one upload — keep it under 1000 photos/signatures plus the CSV.', 413],
    LIMIT_PART_COUNT:     ['Too many parts in one upload — split the batch and try again.', 413],
    LIMIT_FIELD_KEY:      ['A form field name was too long.', 400],
    LIMIT_FIELD_VALUE:    ['A form field value was too long.', 400],
    LIMIT_FIELD_COUNT:    ['Too many form fields in one request.', 400],
    LIMIT_UNEXPECTED_FILE:['Unexpected file field — only csv, photos and signatures are accepted.', 400],
  };
  const hit = MULTER_MESSAGES[err.code];
  if (hit) return res.status(hit[1]).json({ error: hit[0] });
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});
