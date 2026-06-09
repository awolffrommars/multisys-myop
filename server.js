const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
require('dotenv').config();

const { parseCSV } = require('./services/csv');
const { buildPhotoMap, findPhoto, normalizeNameKey } = require('./services/matcher');
const { renderPoster, closeBrowser } = require('./services/poster');

const app = express();
const PORT = process.env.PORT || 3000;

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

const upload = multer({ storage: multer.memoryStorage() });

// In-memory job store
const jobs = new Map();

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
    jobs.set(jobId, { employees, photoMap, posters: [], photos: [], status: 'ready', templateKey });

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
    // Send a synthetic complete so a reconnected client knows it's done
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.write(`data: ${JSON.stringify({ type: 'complete', count: job.posters.length })}\n\n`);
    res.end();
    return;
  }

  job.status = 'generating';
  job.posters = [];
  job.photos = [];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  function emit(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  const CONCURRENCY = 3; // render 3 posters at a time

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
          return { photoData, name: emp.fullName, buffer: pngBuffer };
        } catch (err) {
          emit({ type: 'progress', row, name: emp.fullName, status: 'error', message: err.message });
          return null;
        }
      }));

      // Push results in original order to keep job.posters / job.photos indices aligned
      for (const result of results) {
        if (result) {
          job.photos.push(result.photoData);
          job.posters.push({ name: result.name, buffer: result.buffer });
        }
      }
    }

    job.status = 'done';

    emit({ type: 'complete', count: job.posters.length });
    res.end();
  } catch (err) {
    job.status = 'error';
    emit({ type: 'error', message: err.message });
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
    job.posters[index] = { name: fullName, buffer: pngBuffer };
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
  const named = job.posters.map(p => ({
    buffer: p.buffer,
    name: suffix ? `${lastFirst(p.name)}-${suffix}` : lastFirst(p.name),
  }));
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
