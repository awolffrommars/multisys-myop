// Only PNG is accepted — ensures transparent backgrounds
const SUPPORTED_EXTS = new Set(['.png']);

// Normalize a name into a sorted set of tokens so "Kay Santos" and "Santos, Kay" both produce the same key
function normalizeNameKey(str) {
  return str
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics (ñ→n, é→e, etc.)
    .toLowerCase()
    .replace(/[,]+/g, ' ')       // remove commas (handles "Santos, Kay")
    .replace(/[\s_\-\.]+/g, ' ') // collapse separators
    .trim()
    .split(' ')
    .filter(Boolean)
    .sort()                       // sort tokens so name order doesn't matter
    .join(' ');
}

function buildPhotoMap(files) {
  const map = new Map();
  const duplicates = [];
  for (const file of files) {
    // Multer parses multipart headers as latin1; browsers send UTF-8 — re-decode so ñ, é, etc. survive
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const lastDot = originalName.lastIndexOf('.');
    const ext = lastDot >= 0 ? originalName.slice(lastDot).toLowerCase() : '';
    if (!SUPPORTED_EXTS.has(ext)) continue;

    const nameWithoutExt = lastDot >= 0 ? originalName.slice(0, lastDot) : originalName;
    const key = normalizeNameKey(nameWithoutExt);
    if (map.has(key)) {
      // Two files normalize to the same person ("Smith, John.png" + "John Smith.png") —
      // last one wins, but record it so /prepare can warn instead of silently dropping
      duplicates.push({ kept: originalName, overwrote: map.get(key).originalName });
    }
    map.set(key, {
      buffer: file.buffer,
      format: 'png',
      originalName,
    });
  }
  map.duplicates = duplicates;
  return map;
}

function findPhoto(employeeName, photoMap) {
  const key = normalizeNameKey(employeeName);
  return photoMap.get(key) || null;
}

module.exports = { buildPhotoMap, findPhoto, normalizeNameKey };
