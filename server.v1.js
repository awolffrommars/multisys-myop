const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
require('dotenv').config();

const { parseCSV } = require('./services/csv');
const { buildPhotoMap, findPhoto } = require('./services/matcher');
const { renderPoster, closeBrowser } = require('./services/poster');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// Load fixed template at startup
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'New Employee Poster_Template.png');
let templateBase64 = null;

function loadTemplate() {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.warn(`⚠  Template not found at ${TEMPLATE_PATH}. Place your background PNG there.`);
    return;
  }
  templateBase64 = fs.readFileSync(TEMPLATE_PATH).toString('base64');
  console.log(`✓ Template loaded: ${path.basename(TEMPLATE_PATH)}`);
}

loadTemplate();

const upload = multer({ storage: multer.memoryStorage() });

// In-memory job store
const jobs = new Map();

// Reload template from disk without restarting
app.post('/reload-template', (req, res) => {
  loadTemplate();
  res.json({ ok: true, loaded: !!templateBase64 });
});

// Step 1: Upload CSV + photos, return preview
app.post('/prepare', upload.fields([
  { name: 'csv', maxCount: 1 },
  { name: 'photos' },
]), (req, res) => {
  try {
    if (!templateBase64) {
      return res.status(500).json({ error: 'Template not loaded. Place background.png in the templates/ folder and restart.' });
    }

    const csvFile = req.files?.csv?.[0];
    const photoFiles = req.files?.photos || [];

    if (!csvFile) return res.status(400).json({ error: 'No CSV file uploaded.' });

    const employees = parseCSV(csvFile.buffer);
    if (employees.length === 0) {
      return res.status(400).json({ error: 'CSV is empty or could not be parsed.' });
    }

    const photoMap = buildPhotoMap(photoFiles);

    const preview = employees.map(emp => ({
      ...emp,
      photoFound: !!findPhoto(emp.fullName, photoMap),
    }));

    const jobId = crypto.randomUUID();
    jobs.set(jobId, { employees, photoMap, posters: [], zipBuffer: null, status: 'ready' });

    res.json({ jobId, employees: preview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 2: Generate posters (SSE stream)
app.get('/generate/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status === 'generating') return res.status(409).json({ error: 'Already generating.' });

  job.status = 'generating';
  job.posters = [];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  function emit(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  try {
    for (let i = 0; i < job.employees.length; i++) {
      const emp = job.employees[i];
      emit({ type: 'progress', row: i + 1, name: emp.fullName, position: emp.position, department: emp.department, status: 'processing' });

      try {
        const photoResult = findPhoto(emp.fullName, job.photoMap);

        if (!photoResult) {
          emit({ type: 'progress', row: i + 1, name: emp.fullName, position: emp.position, department: emp.department, status: 'skipped', message: 'No photo' });
          continue;
        }

        const photoData = { base64: photoResult.buffer.toString('base64'), format: photoResult.format };

        const pngBuffer = await renderPoster(
          { fullName: emp.fullName, position: emp.position, department: emp.department },
          photoData,
          templateBase64
        );

        job.posters.push({ name: emp.fullName, buffer: pngBuffer });
        emit({ type: 'progress', row: i + 1, name: emp.fullName, position: emp.position, department: emp.department, status: 'done' });
      } catch (err) {
        emit({ type: 'progress', row: i + 1, name: emp.fullName, status: 'error', message: err.message });
      }
    }

    job.zipBuffer = await buildZip(job.posters);
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

  const { fullName, position, department, originalName } = req.body;

  let photoData = null;
  if (req.file) {
    const format = req.file.mimetype.split('/')[1] || 'png';
    photoData = { base64: req.file.buffer.toString('base64'), format };
  } else {
    const photoResult = findPhoto(fullName, job.photoMap) ||
      (originalName ? findPhoto(originalName, job.photoMap) : null);
    if (photoResult) {
      photoData = { base64: photoResult.buffer.toString('base64'), format: photoResult.format };
    }
  }

  if (!photoData) return res.status(400).json({ error: 'No photo available for this employee.' });

  try {
    const pngBuffer = await renderPoster({ fullName, position, department }, photoData, templateBase64);
    job.posters[index] = { name: fullName, buffer: pngBuffer };
    job.zipBuffer = await buildZip(job.posters);
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
