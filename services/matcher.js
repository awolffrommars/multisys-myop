// Only PNG is accepted — ensures transparent backgrounds
const SUPPORTED_EXTS = new Set(['.png']);

// Normalize a name into a sorted set of tokens so "Kay Santos" and "Santos, Kay" both produce the same key
function normalizeNameKey(str) {
  return str
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics (ñ→n, é→e, etc.)
    .toLowerCase()
    .replace(/[,]+/g, ' ')       // remove commas (handles "Santos, Kay")
    .replace(/[\s_\-\.]+/g, ' ') // collapse separators
    .trim()
    .split(' ')
    .filter(Boolean)
    .sort()                       // sort tokens so name order doesn't matter
    .join(' ');
}

// Tokens that are export artefacts rather than parts of a name. Without stripping
// these, "Nama-Sy, Ma. Benjieleen Tenido_3.png" never matched its employee because
// of the trailing "_3".
const JUNK_TOKENS = new Set([
  'copy', 'final', 'final2', 'new', 'edit', 'edited', 'resized', 'crop', 'cropped',
  'draft', 'img', 'image', 'photo', 'pic', 'picture', 'portrait', 'headshot',
  'v1', 'v2', 'v3', 'orig', 'original',
]);

// Meaningful name tokens: normalized, with export junk, bare numbers and single
// letters (middle initials) dropped. Single letters are dropped rather than matched
// because "J" appearing in a filename tells us nothing reliable.
function nameTokens(str) {
  return normalizeNameKey(str)
    .split(' ')
    .filter(t => t && t.length > 1 && !/^\d+$/.test(t) && !JUNK_TOKENS.has(t));
}

// Would `fileName` be an acceptable match for `employeeName`?
//
// Rule: every meaningful token of the SHORTER name must appear in the longer one,
// and at least 2 tokens must be shared — unless both names are genuinely a single
// token. That accepts a filename missing a middle name ("Garlan, Peter.png" for
// "Peter Psalm Garlan") and one carrying export junk, while refusing a single
// shared surname ("John Cruz.png" is not "John Santos") and refusing truncated
// tokens ("kath" is not "kathleen").
//
// Returns null for no match, or { shared, sizeDelta } for ranking candidates.
function scoreMatch(employeeName, fileName) {
  const e = nameTokens(employeeName);
  const f = nameTokens(fileName);
  if (!e.length || !f.length) return null;

  const eSet = new Set(e);
  const fSet = new Set(f);
  const shared = [...fSet].filter(t => eSet.has(t)).length;
  if (shared === 0) return null;

  // The shorter side must be fully contained in the longer one
  const [small, bigSet] = e.length <= f.length ? [e, fSet] : [f, eSet];
  if (!small.every(t => bigSet.has(t))) return null;

  // A single shared token is only trustworthy when neither name has more to offer
  if (shared < 2 && !(eSet.size === 1 && fSet.size === 1)) return null;

  return { shared, sizeDelta: Math.abs(eSet.size - fSet.size) };
}

function buildPhotoMap(files) {
  const map = new Map();
  const duplicates = [];
  const entries = []; // every accepted file, for the fuzzy pass
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
    const entry = {
      buffer: file.buffer,
      format: 'png',
      originalName,
      baseName: nameWithoutExt,
    };
    map.set(key, entry);
    entries.push(entry);
  }
  map.duplicates = duplicates;
  map.entries = entries;
  return map;
}

// Single-name lookup: exact key first, then a UNIQUELY best fuzzy candidate.
// Ties resolve to null — a coin flip here puts the wrong face on an ID card.
// Used where there is no full employee list to cross-check against (/regenerate).
function findPhoto(employeeName, photoMap) {
  if (!photoMap) return null;
  const exact = photoMap.get(normalizeNameKey(employeeName));
  if (exact) return exact;

  let best = null, bestScore = null, tied = false;
  for (const entry of photoMap.entries || []) {
    const score = scoreMatch(employeeName, entry.baseName);
    if (!score) continue;
    if (!bestScore || score.shared > bestScore.shared ||
        (score.shared === bestScore.shared && score.sizeDelta < bestScore.sizeDelta)) {
      best = entry; bestScore = score; tied = false;
    } else if (score.shared === bestScore.shared && score.sizeDelta === bestScore.sizeDelta) {
      tied = true;
    }
  }
  return tied ? null : best;
}

// Resolve the whole batch at once so a file can't be handed to two employees.
//
//   1. exact key matches are assigned first and claim their file
//   2. each remaining employee takes its uniquely best UNCLAIMED file
//   3. any file still wanted by more than one employee is withdrawn from all of them
//
// Returns { matches: Map<normalizedEmployeeKey, entry>, ambiguous: [...] }.
// `ambiguous` entries are surfaced to the user as a warning; those employees are
// reported as unmatched so the photo is uploaded explicitly instead of guessed.
function resolveMatches(employeeNames, photoMap) {
  const matches = new Map();
  const ambiguous = [];
  if (!photoMap) return { matches, ambiguous };

  const claimed = new Set();
  const pending = [];

  for (const name of employeeNames) {
    const key = normalizeNameKey(name);
    if (matches.has(key)) continue; // duplicate name in the CSV — first wins
    const exact = photoMap.get(key);
    if (exact) {
      matches.set(key, exact);
      claimed.add(exact);
    } else {
      pending.push({ name, key });
    }
  }

  // Tentative fuzzy assignments over the files no exact match took
  const wantedBy = new Map(); // entry -> [employee names]
  for (const { name, key } of pending) {
    let best = null, bestScore = null, tiedWith = [];
    for (const entry of photoMap.entries || []) {
      if (claimed.has(entry)) continue;
      const score = scoreMatch(name, entry.baseName);
      if (!score) continue;
      if (!bestScore || score.shared > bestScore.shared ||
          (score.shared === bestScore.shared && score.sizeDelta < bestScore.sizeDelta)) {
        best = entry; bestScore = score; tiedWith = [];
      } else if (score.shared === bestScore.shared && score.sizeDelta === bestScore.sizeDelta) {
        tiedWith.push(entry);
      }
    }
    if (!best) continue;
    if (tiedWith.length) {
      // Several files fit this employee equally well — don't guess
      ambiguous.push({ employee: name, files: [best, ...tiedWith].map(e => e.originalName) });
      continue;
    }
    matches.set(key, best);
    if (!wantedBy.has(best)) wantedBy.set(best, []);
    wantedBy.get(best).push({ name, key });
  }

  // One file, several employees — withdraw it from all of them
  for (const [entry, claimants] of wantedBy) {
    if (claimants.length < 2) continue;
    ambiguous.push({ file: entry.originalName, employees: claimants.map(c => c.name) });
    for (const c of claimants) matches.delete(c.key);
  }

  return { matches, ambiguous };
}

module.exports = { buildPhotoMap, findPhoto, normalizeNameKey, nameTokens, scoreMatch, resolveMatches };
