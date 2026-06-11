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

const { parseCSV } = require('./services/csv');
const { buildPhotoMap, findPhoto, normalizeNameKey } = require('./services/matcher');
const { renderPoster, closeBrowser } = require('./services/poster');

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
const _PS = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,sans-serif;background:#090909;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#141414;border:1px solid #222;border-radius:16px;padding:40px;width:100%;max-width:360px;text-align:center}.logo{font-size:20px;font-weight:700;margin-bottom:8px}.sub{font-size:13px;color:#555;margin-bottom:32px}.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:12px;background:#fff;color:#111;border:none;border-radius:100px;font-size:14px;font-weight:500;cursor:pointer;text-decoration:none}.btn:hover{background:#e8e8e8}.err{margin-bottom:20px;font-size:13px;color:#f87171}`;
const _GSVG = `<svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"/></svg>`;
const _HEAD = (title) => `<!DOCTYPE html><html><head><title>${title}</title><style>${_PS}</style></head><body><div class="box"><img src="/logo-multisys.svg" alt="Multisys" style="height:32px;margin-bottom:16px"/><div class="logo">Make Your Own Poster</div><div class="sub">Multisys Internal Tool</div>`;

const loginPage = (err = '') => _HEAD('Sign In — MYOP') +
  (err ? `<div class="err">${err}</div>` : '') +
  `<a class="btn" href="/auth/google">${_GSVG} Sign in with Google</a></div></body></html>`;

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

// Step 1: Upload CSV + photos, return preview
app.post('/prepare', upload.fields([
  { name: 'csv', maxCount: 1 },
  { name: 'photos' },
]), (req, res) => {
  try {
    const templateKey = req.body?.template || 'new-employee';
    if (!templates[templateKey]) {
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

    const photoMap = buildPhotoMap(photoFiles);

    const preview = employees.map(emp => ({
      ...emp,
      photoFound: !!findPhoto(emp.fullName, photoMap),
    }));

    const jobId = crypto.randomUUID();
    jobs.set(jobId, { employees, photoMap, posters: [], photos: [], status: 'ready', templateKey, createdAt: Date.now() });

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

        const photoResult = findPhoto(emp.fullName, job.photoMap);
        if (!photoResult) {
          emit({ type: 'progress', row, name: emp.fullName, position: emp.position, department: emp.department, division: emp.division, birthdayDate: emp.birthdayDate, status: 'skipped', message: 'No photo' });
          return null;
        }

        const photoData = { base64: photoResult.buffer.toString('base64'), format: photoResult.format };
        try {
          const pngBuffer = await renderPoster(
            { fullName: emp.fullName, position: emp.position, department: emp.department, division: emp.division, birthdayDate: emp.birthdayDate, anniversaryYears: emp.anniversaryYears, dateHired: emp.dateHired },
            photoData,
            templates[job.templateKey],
            null,
            job.templateKey
          );
          emit({ type: 'progress', row, name: emp.fullName, position: emp.position, department: emp.department, division: emp.division, birthdayDate: emp.birthdayDate, status: 'done' });
          return { photoData, name: emp.fullName, buffer: pngBuffer, dateHired: emp.dateHired };
        } catch (err) {
          emit({ type: 'progress', row, name: emp.fullName, status: 'error', message: err.message });
          if (AUTH_ENABLED && req.user && db) {
            try { await db.logError(req.user.email, job.templateKey, emp.fullName, classifyError(err.message), err.message); } catch {}
          }
          return null;
        }
      }));

      // Push results in original order to keep job.posters / job.photos indices aligned
      for (const result of results) {
        if (result) {
          job.photos.push(result.photoData);
          job.posters.push({ name: result.name, buffer: result.buffer, dateHired: result.dateHired });
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
app.post('/regenerate/:jobId/:index', upload.single('photo'), async (req, res) => {
  const job = jobs.get(req.params.jobId);
  const index = parseInt(req.params.index, 10);
  if (!job || !job.posters[index]) return res.status(404).json({ error: 'Poster not found.' });

  const { fullName, position, department, division, birthdayDate, anniversaryYears, dateHired, originalName } = req.body;

  let photoData = null;
  if (req.file) {
    const format = req.file.mimetype.split('/')[1] || 'png';
    photoData = { base64: req.file.buffer.toString('base64'), format };
    job.photoMap.set(normalizeNameKey(fullName), { buffer: req.file.buffer, format, originalName: req.file.originalname });
  } else {
    // Primary: look up by index — never fails due to name changes
    photoData = job.photos?.[index] || null;
    // Fallback: name-based lookup for any edge cases
    if (!photoData) {
      const photoResult = findPhoto(fullName, job.photoMap) ||
        (originalName ? findPhoto(originalName, job.photoMap) : null);
      if (photoResult) {
        photoData = { base64: photoResult.buffer.toString('base64'), format: photoResult.format };
      }
    }
  }

  if (!photoData) return res.status(400).json({ error: 'No photo available for this employee.' });

  try {
    const pngBuffer = await renderPoster(
      { fullName, position, department, division, birthdayDate, anniversaryYears, dateHired },
      photoData,
      templates[job.templateKey],
      null,
      job.templateKey
    );
    job.photos[index] = photoData;
    job.posters[index] = { name: fullName, buffer: pngBuffer, dateHired: dateHired };
    // Re-key photo in photoMap under the new name so the name-based fallback
    // continues to work even if job.photos is somehow stale.
    const photoBuffer = Buffer.from(photoData.base64, 'base64');
    job.photoMap.set(normalizeNameKey(fullName), { buffer: photoBuffer, format: photoData.format, originalName: fullName });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Download ZIP
app.get('/download/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.posters.length) {
    return res.status(404).json({ error: 'No ZIP available. Run generation first.' });
  }
  const suffix = req.query.suffix || '';
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
  const named = job.posters.map(p => {
    const base = suffix ? `${lastFirst(p.name)}-${suffix}` : lastFirst(p.name);
    const prefix = job.templateKey === 'anniversary' ? dateHiredPrefix(p.dateHired) : null;
    return { buffer: p.buffer, name: prefix ? `${prefix}-${base}` : base };
  });
  try {
    const zipBuffer = await buildZip(named);
    const zipName = suffix ? `${suffix}.zip` : 'new-employee-posters.zip';
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
