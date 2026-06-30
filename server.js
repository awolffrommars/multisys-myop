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
const { buildPhotoMap, findPhoto, normalizeNameKey } = require('./services/matcher');
const { renderPoster, closeBrowser, renderPdf, normalizePhone } = require('./services/poster');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Auth & Admin ──────────────────────────────────────────────────────────
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || '';
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    || '';
const WHITELIST      = new Set(
  (process.env.WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean)
);
const AUTH_ENABLED = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

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
  app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false, saveUninitialized: false,
    cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 },
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
    async (req, res) => {
      const { email, name } = req.user;
      if (WHITELIST.has(email)) return res.redirect('/');
      if (!db) { req.logout(() => {}); return res.redirect('/login'); }
      const existing = await db.getUser(email);
      if (existing?.status === 'approved') return res.redirect('/');
      if (existing?.status === 'denied') { req.logout(() => {}); return res.redirect('/denied'); }
      await db.upsertPending(email, name);
      res.redirect('/waiting');
    }
  );

  app.get('/waiting', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    if (WHITELIST.has(req.user.email)) return res.redirect('/');
    const user = db ? await db.getUser(req.user.email) : null;
    if (user?.status === 'approved') return res.redirect('/');
    if (user?.status === 'denied')   return res.redirect('/denied');
    res.send(waitingPage(req.user.email));
  });

  app.get('/denied',      (req, res) => res.send(deniedPage()));
  app.get('/logout',      (req, res) => req.logout(() => res.redirect('/login')));
  app.get('/auth/status', async (req, res) => {
    if (!req.isAuthenticated()) return res.json({ status: 'unauthenticated' });
    const { email } = req.user;
    if (WHITELIST.has(email)) return res.json({ status: 'approved' });
    const user = db ? await db.getUser(email) : null;
    res.json({ status: user?.status || 'pending' });
  });
  app.get('/me', (req, res) => {
    if (req.isAuthenticated()) return res.json({ email: req.user.email, name: req.user.name, isAdmin: req.user.email === ADMIN_EMAIL });
    res.json({});
  });

  // ─── Admin routes ─────────────────────────────────────────────────────────
  app.get('/admin', requireAdmin, (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'admin.html')));

  app.get('/admin/data', requireAdmin, async (req, res) => {
    if (!db) return res.json({ pending: [], approved: [], denied: [], history: [], errors: [], stats: { byTemplate: [], byUser: [], activity: [], totalPosters: 0 } });
    const [pending, approved, denied, history, errors, stats] = await Promise.all([
      db.getUsersByStatus('pending'),
      db.getUsersByStatus('approved'),
      db.getUsersByStatus('denied'),
      db.getHistory(200),
      db.getErrors(50),
      db.getStats(),
    ]);
    res.json({ pending, approved, denied, history, errors, stats });
  });

  app.post('/admin/approve/:email', requireAdmin, async (req, res) => {
    const email = decodeURIComponent(req.params.email);
    if (db) await db.updateStatus(email, 'approved');
    res.json({ ok: true });
  });

  app.post('/admin/deny/:email', requireAdmin, async (req, res) => {
    if (db) await db.updateStatus(decodeURIComponent(req.params.email), 'denied');
    res.json({ ok: true });
  });

  app.post('/admin/revoke/:email', requireAdmin, async (req, res) => {
    if (db) await db.updateStatus(decodeURIComponent(req.params.email), 'denied');
    res.json({ ok: true });
  });

  // ─── Protect app routes ───────────────────────────────────────────────────
  app.use('/index.html',      requireAccess);
  app.use('/prepare',         requireAccess);
  app.use('/generate',        requireAccess);
  app.use('/preview',         requireAccess);
  app.use('/download',        requireAccess);
  app.use('/regenerate',      requireAccess);
  app.use('/reload-template', requireAccess);

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
  limits: { fileSize: 20 * 1024 * 1024, files: 501 }, // 20 MB per file, 500 photos + 1 CSV
});

// In-memory job store with TTL eviction (2 hours)
const jobs = new Map();
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if ((job.createdAt || 0) < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

// Reload templates from disk without restarting
app.post('/reload-template', (req, res) => {
  loadTemplates();
  res.json({ ok: true, loaded: Object.keys(templates) });
});

// QR preview for calling card manual entry
app.get('/qr-preview', async (req, res) => {
  const raw = (req.query.mobile || '').trim();
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

    const preview = employees.map(emp => ({
      ...emp,
      photoFound:     noPhotoTemplate ? true : !!findPhoto(emp.fullName, photoMap),
      signatureFound: templateKey === 'multisys-id' ? !!findPhoto(emp.fullName, signatureMap) : undefined,
    }));

    if (AUTH_ENABLED && templateKey === 'multisys-id') {
      const missing = preview.filter(e => !e.signatureFound).map(e => e.fullName);
      if (missing.length) return res.status(400).json({ error: `Signature required for: ${missing.join(', ')}` });
    }

    const jobId = crypto.randomUUID();
    jobs.set(jobId, { employees, photoMap, signatureMap, posters: [], photos: [], signatures: [], status: 'ready', templateKey, noPhotoTemplate, createdAt: Date.now() });

    res.json({ jobId, employees: preview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 2: Generate posters (SSE stream)
app.get('/generate/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  // Block re-runs: EventSource auto-reconnects after the stream closes, which would
  // reset job.photos and corrupt in-flight or completed regenerate calls.
  if (job.status !== 'ready') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    if (job.status === 'done') {
      // Generation complete — send the real count so a reconnected client gets a consistent gallery
      res.write(`data: ${JSON.stringify({ type: 'complete', count: job.posters.length })}\n\n`);
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
        const photoResult = noPhoto ? null : findPhoto(emp.fullName, job.photoMap);
        if (!photoResult && !noPhoto) {
          emit({ type: 'progress', row, name: emp.fullName, position: emp.position, department: emp.department, division: emp.division, birthdayDate: emp.birthdayDate, status: 'skipped', message: 'No photo' });
          return null;
        }

        const photoData = photoResult ? { base64: photoResult.buffer.toString('base64'), format: photoResult.format } : null;

        const sigResult = job.templateKey === 'multisys-id' ? findPhoto(emp.fullName, job.signatureMap) : null;
        const signatureData = sigResult ? { base64: sigResult.buffer.toString('base64'), format: sigResult.format } : null;

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
              { photoData, signatureData, name: emp.fullName, buffer: frontBuffer, dateHired: emp.dateHired, posterTemplateKey: job.templateKey, side: 'front' },
              { photoData: null, signatureData: null, name: emp.fullName, buffer: backBuffer, dateHired: emp.dateHired, posterTemplateKey: backKey, side: 'back' },
            ];
          }
          return { photoData, signatureData, name: emp.fullName, buffer: frontBuffer, dateHired: emp.dateHired };
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
          job.photos.push(r.photoData);
          job.signatures.push(r.signatureData);
          job.posters.push({ name: r.name, buffer: r.buffer, dateHired: r.dateHired, posterTemplateKey: r.posterTemplateKey, side: r.side });
        }
      }
    }

    job.status = 'done';
    if (AUTH_ENABLED && req.user && db) {
      const durationMs = Date.now() - job.startedAt;
      try { await db.logHistory(req.user.email, job.templateKey, job.posters.length, job.posters.map(p => p.name), durationMs); } catch {}
    }

    emit({ type: 'complete', count: job.posters.length });
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
  const job = jobs.get(req.params.jobId);
  const index = parseInt(req.params.index, 10);
  if (!job || !job.posters[index]) return res.status(404).json({ error: 'Poster not found.' });
  const poster = job.posters[index];
  const posterTemplateKey = poster.posterTemplateKey || job.templateKey;
  const isBackCard = posterTemplateKey === 'multisys-id-back' || posterTemplateKey === 'calling-card-back';

  const { fullName, firstName, lastName, position, department, division, birthdayDate, anniversaryYears, dateHired, originalName, email, mobile, employeeNumber, address, phoneNumber, philhealth, sss, tin, hdmf, contactName, contactAddress, contactNumber } = req.body;

  const photoFile = req.files?.photo?.[0];
  let photoData = null;
  if (photoFile) {
    const format = photoFile.mimetype.split('/')[1] || 'png';
    photoData = { base64: photoFile.buffer.toString('base64'), format };
    job.photoMap.set(normalizeNameKey(fullName), { buffer: photoFile.buffer, format, originalName: photoFile.originalname });
  } else {
    photoData = job.photos?.[index] || null;
    if (!photoData) {
      const photoResult = findPhoto(fullName, job.photoMap) ||
        (originalName ? findPhoto(originalName, job.photoMap) : null);
      if (photoResult) {
        photoData = { base64: photoResult.buffer.toString('base64'), format: photoResult.format };
      }
    }
  }

  if (!photoData && !job.noPhotoTemplate && !isBackCard) return res.status(400).json({ error: 'No photo available for this employee.' });

  const sigFile = req.files?.signature?.[0];
  let signatureData = null;
  if (sigFile) {
    const format = sigFile.mimetype.split('/')[1] || 'png';
    signatureData = { base64: sigFile.buffer.toString('base64'), format };
    if (!job.signatureMap) job.signatureMap = new Map();
    job.signatureMap.set(normalizeNameKey(fullName), { buffer: sigFile.buffer, format, originalName: sigFile.originalname });
  } else {
    signatureData = job.signatures?.[index] || null;
    if (!signatureData && job.signatureMap) {
      const sigResult = findPhoto(fullName, job.signatureMap);
      if (sigResult) signatureData = { base64: sigResult.buffer.toString('base64'), format: sigResult.format };
    }
  }

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
    job.photos[index] = isBackCard ? null : photoData;
    job.signatures[index] = isBackCard ? null : signatureData;
    job.posters[index] = { name: fullName, buffer: pngBuffer, dateHired, posterTemplateKey, side: poster.side };
    if (!isBackCard && photoData) {
      const photoBuffer = Buffer.from(photoData.base64, 'base64');
      job.photoMap.set(normalizeNameKey(fullName), { buffer: photoBuffer, format: photoData.format, originalName: fullName });
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
  const job = jobs.get(req.params.jobId);
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
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  job.status = 'ready';
  job.posters = [];
  job.photos = [];
  job.signatures = [];
  res.json({ ok: true });
});

// Preview: serve individual poster PNG
app.get('/preview/:jobId/:index', (req, res) => {
  const job = jobs.get(req.params.jobId);
  const index = parseInt(req.params.index, 10);
  if (!job || !job.posters[index]) {
    return res.status(404).send('Not found');
  }
  res.setHeader('Content-Type', 'image/png');
  res.send(job.posters[index].buffer);
});

// Download paired-card template as PDF (front + back)
app.get('/download-pdf/:jobId/:empIdx', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  const empIdx = parseInt(req.params.empIdx, 10);
  const frontIdx = empIdx * 2;
  const backIdx  = empIdx * 2 + 1;
  if (!job || !job.posters[frontIdx]) return res.status(404).json({ error: 'Poster not found.' });
  const cfg = PDF_CONFIG[job.templateKey];
  if (!cfg) return res.status(400).json({ error: 'PDF download not supported for this template.' });
  try {
    const frontBuf = job.posters[frontIdx].buffer;
    const backBuf  = job.posters[backIdx]?.buffer || null;
    const empName  = job.posters[frontIdx].name || '';
    const pdfBuffer = await renderPdf(frontBuf, backBuf, { pageWidth: cfg.pageWidth, pageHeight: cfg.pageHeight });
    const fileBase = `${lastFirst(empName)}-${cfg.label}`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: 'PDF generation failed: ' + err.message });
  }
});

// Download ZIP
app.get('/download/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.posters.length) {
    return res.status(404).json({ error: 'No ZIP available. Run generation first.' });
  }
  const suffix = req.query.suffix || '';
  const named = job.posters.map(p => {
    const sideTag = p.side === 'back' ? '-Back' : '';
    const base = suffix ? `${lastFirst(p.name)}-${suffix}${sideTag}` : `${lastFirst(p.name)}${sideTag}`;
    const prefix = job.templateKey === 'anniversary' ? dateHiredPrefix(p.dateHired) : null;
    return { buffer: p.buffer, name: prefix ? `${prefix}-${base}` : base };
  });
  try {
    const zipBuffer = await buildZip(named);
    const zipName = suffix ? `${suffix}.zip` : `${ZIP_NAMES[job.templateKey] || 'Posters'}.zip`;
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

    for (const { name, buffer } of posters) {
      archive.append(buffer, { name: `${name}.png` });
    }

    archive.finalize();
  });
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});
