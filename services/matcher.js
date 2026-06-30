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
  for (const file of files) {
    const originalName = file.originalname;
    const lastDot = originalName.lastIndexOf('.');
    const ext = lastDot >= 0 ? originalName.slice(lastDot).toLowerCase() : '';
    if (!SUPPORTED_EXTS.has(ext)) continue;

    const nameWithoutExt = lastDot >= 0 ? originalName.slice(0, lastDot) : originalName;
    const key = normalizeNameKey(nameWithoutExt);
    map.set(key, {
      buffer: file.buffer,
      format: 'png',
      originalName,
    });
  }
  return map;
}

function findPhoto(employeeName, photoMap) {
  const key = normalizeNameKey(employeeName);
  return photoMap.get(key) || null;
}

module.exports = { buildPhotoMap, findPhoto, normalizeNameKey };
