# Security & Correctness Hardening — 2026-07-14

Full-project review (4 parallel code reviews: server, services, frontend, admin/auth/deploy) surfaced 29 findings. All were fixed in one batch. This document records each finding, the change made, and how to revert everything.

---

## ⏪ Revert

The pre-hardening state is preserved on the `backup-pre-hardening` branch (commit `6782d4b` — last state before this batch, with all features through 2026-07-13 intact).

**Revert everything (uncommitted or committed):**

```bash
git reset --hard backup-pre-hardening
PUPPETEER_SKIP_DOWNLOAD=true npm install   # restores the removed npm packages
lsof -ti :3000 | xargs kill -9; nohup node server.js > /tmp/poster-server.log 2>&1 &
```

**Revert but keep it in history (if the hardening was already deployed/committed):**

```bash
git revert --no-edit backup-pre-hardening..HEAD
```

---

## 🔴 Critical — Security

### 1. Unauthenticated PII routes
**Finding:** `GET /job/:jobId` (returns full employee data — SSS, TIN, PhilHealth, addresses), `GET /download-pdf/...` (full ID-card PDFs), `POST /job/:id/reset`, and `GET /qr-preview` were reachable without login. Express mount paths match at `/` boundaries, so the existing `app.use('/download', requireAccess)` did **not** cover `/download-pdf`.
**Fix (`server.js`):** Added `requireAccess` mounts for `/job`, `/download-pdf`, `/qr-preview`. `/reload-template` upgraded from `requireAccess` to `requireAdmin`.
**Verified:** all four return 302 (login redirect) / 403 unauthenticated.

### 2. Stored XSS in admin dashboard (self-approval)
**Finding:** The pending/approved/denied user tables inserted `u.email`/`u.name` into `innerHTML` unescaped. `u.name` is the Google display name — any `@multisyscorp.com` user could set their name to a script tag, sign in, and have it auto-approve them when the admin dashboard rendered. The Render Errors table escaped only `<` and interpolated the message into a `title="…"` attribute (quote breakout), plus unescaped `user_email`/`error_type`/template class.
**Fix (`public/admin.html`):** `esc()` applied to all three user tables, the errors table (row + modal, including the title attribute), and template class interpolations. `enc()` now also encodes `'` (breaks out of `onclick='…'`).

### 3. CSV data injected raw into the render browser
**Finding:** Every CSV field was interpolated into the poster HTML unescaped — a cell like `<img src=x onerror=fetch(...)>` executes JavaScript inside server-side Chrome (SSRF/exfiltration risk); benign values like `R&D <Platform>` broke rendering. Separately, `String.replaceAll` with a string replacement treats `$&`, `` $` ``, `$'`, `$$` as substitution patterns — data containing them re-injected tokens or duplicated chunks of template HTML.
**Fix (`services/poster.js`):** New `escapeHtml()` applied to every text field; ALL `replaceAll` calls switched to function-form replacements (`() => value`), which disables `$` pattern expansion. Anniversary position line-break inserted *after* escaping. Phone lines escaped.
**Verified:** rendered a poster with a live XSS payload + `$&`/`$'`/`$$` — everything prints as literal text.

### 4. Session cookie & CSRF baseline
**Finding:** `cookie: { secure: false }`, no `sameSite`, no `trust proxy` — the cookie could travel over plain HTTP behind HuggingFace's HTTPS proxy, and CSRF protection relied on browser defaults. Admin approve/deny/revoke POSTs were CSRF-able.
**Fix (`server.js`):** `app.set('trust proxy', 1)` + `cookie: { secure: 'auto', httpOnly: true, sameSite: 'lax' }`. Warns at boot if `SESSION_SECRET` is missing.

### 5. Fail-open auth
**Finding:** If HuggingFace secrets failed to load, `AUTH_ENABLED` silently flipped off and the entire app (including PII endpoints) became public; the `/admin.html` static block was skipped too.
**Fix (`server.js`):** Refuses to start (exit 1) when a production environment is detected (`SPACE_ID` or `NODE_ENV=production`) but Google credentials are absent.

---

## 🟠 High — Correctness

### 6. Gallery misalignment when a render errors
**Finding:** The server skips errored renders (nothing pushed to `posters[]`), but the gallery mapped employees→poster indices 1:1 by `photoFound`. One failed render shifted every following card onto the wrong person's poster — wrong Save filenames, Edit regenerating the wrong employee.
**Fix (`server.js` + `public/index.html`):** The SSE `complete` event now includes `names` (the actually-rendered front posters, in order). `showGallery` builds its card list from that, falling back to the old filter when absent (dev reload path).

### 7. Shared Puppeteer browser closed mid-batch
**Finding:** `/generate`'s `finally` closed the singleton browser unconditionally — with two users generating, the first to finish killed the second's browser ("Target closed").
**Fix (`services/poster.js`):** `activeRenders` counter; `closeBrowser()` is a no-op while any render is in flight — the last active batch closes it.

### 8. Signature-only edit couldn't be saved
**Finding:** `checkEditChanged()` never checked `editSignatureFile`, so replacing only the signature left the Regenerate button disabled.
**Fix (`public/index.html`):** Added `|| !!editSignatureFile`.

### 9. Manual-entry edit mangled prefixed values
**Finding:** Editing a committed manual employee reloaded stored values (`MTC-0001`, `+63917…`) raw into the prefix inputs → re-saving produced `MTC-MTC-0001` / `+63+63917…`. Multi-number mobiles lost all but the first number; the signature wasn't restored.
**Fix (`public/index.html`):** Populate now strips `MTC-`/`+63`, splits multi-mobiles back into primary + extra rows (with Add Number button state), and restores `currentManualSignature` + zone label.

### 10. Month autocorrect mangled non-dates
**Finding:** Levenshtein threshold 3 with no length guard turned `TBD`→"May", `TBA 15`→"May 15", `N/A`→"May/A" — silently printing fake dates on real posters.
**Fix (`services/csv.js`):** Fuzzy match only for words ≥4 chars, with threshold `min(3, floor(len/2))`. Real typos ("Augsut") still correct. Unit-verified.

### 11. One short CSV row aborted the whole upload
**Finding:** Excel omits trailing empty cells; an 11-cell row in a 12-column CSV threw `CSV_RECORD_INCONSISTENT_FIELDS_LENGTH` and failed the entire `/prepare`.
**Fix (`services/csv.js`):** `relax_column_count: true` + `bom: true` (BOM was also leaking into the first cell of headerless CSVs).

### 12. deploy.sh could strand the repo / lose template PNGs
**Finding:** Any failure between `checkout --orphan hf` and `checkout main` left the repo stuck on the orphan branch with the 7 gitignored PNGs deleted (recoverable only from periodically-wiped `/tmp`); re-running couldn't recover (`branch -D` can't delete the checked-out branch).
**Fix (`deploy.sh`):** Rewritten with a `trap`-based `restore()` (always returns to main + restores PNGs from a `mktemp -d` backup), template list de-duplicated into an array, and an explicit `checkout main` before `branch -D hf` so re-runs recover from a stranded state.

---

## 🟡 Medium

### 13. `/regenerate` dropped `birthdayDate`
Editing a birthday poster lost the `MM-DD-` ZIP filename prefix. **Fix (`server.js`):** poster record now preserves `birthdayDate`/`dateHired` (falling back to the previous poster's values).

### 14. `639…`-format calling-card numbers printed as garbage
A pre-map blindly prepended `+63` (→ `+63639…`, 12 digits, formatter bailed). **Fix (`services/poster.js`):** removed the prepend — `formatPhoneDisplay` normalizes all prefixes itself. QR and printed number now always agree.

### 15. EventSource gave up on the first blip
`onerror` closed the stream immediately, defeating the designed ~3s auto-retry (the server deliberately closes empty while still generating). **Fix (`public/index.html`):** only errors out when `readyState === CLOSED` and no complete arrived; previous stream is closed before a new `runGenerate` (Back-then-Generate no longer double-streams).

### 16. Browser history reached steps with dead state
Back after Start Over showed a stale gallery whose Edit POSTed `/regenerate/null/0`; Forward after a template switch ran the old job under the new template. **Fix (`public/index.html`):** `popstate` falls back to step 1 when `currentJobId` is gone; Start Over and `clearAllFields()` (template switch) clear `currentJobId`/`currentEmployees`/gallery DOM.

### 17. Photo subset-filter deleted other employees' photos
Uploading for "Peter Psalm Garlan" removed `Peter Garlan.png` even when that was employee Peter Garlan's exact match. **Fix (`public/index.html`):** files exactly matching a *different* employee's name are never removed (both the inline-upload and trash-button paths).

### 18. Concurrent `/prepare` race
Fast upload+trash clicks could leave the UI on the older response. **Fix (`public/index.html`):** monotonic request token; stale responses are discarded.

### 19. Mid-edit auto-save dropped data
Clicking Edit on B while A was mid-edit saved A without prefixes, without extra mobiles, and without the signature. **Fix (`public/index.html`):** auto-save now normalizes exactly like `commitEmployee` and includes `signatureFile`.

### 20. Page leak on render errors
Failed renders never closed their Puppeteer page (failed `/regenerate`s accumulated pages indefinitely). **Fix (`services/poster.js`):** `page.close()` in a `finally`.

### 21. Unbounded upload memory
501 × 20MB per request could buffer ~10GB. **Fix (`server.js`):** 413 rejection when Content-Length exceeds 300MB on `/prepare`.

### 22. Async route handlers hung requests on errors
Express 4 doesn't catch async throws — a Turso outage during login hung the request forever; `?suffix=a&suffix=b` (array) threw outside try/catch. **Fix (`server.js`):** `asyncH()` wrapper on all async auth/admin routes, a JSON error middleware, `String()` coercion on `suffix`/`mobile` query params, `/regenerate` validates `fullName` up front, and `headerSafe()` strips quotes/control chars from `Content-Disposition` filenames.

---

## 🟢 Low / cleanup

| # | Finding | Fix |
|---|---|---|
| 23 | No DB indexes on queried columns; `upsertPending` never refreshed names | Indexes on `history.generated_at`, `render_errors.occurred_at`, `users.status` (in `db.init()`); `ON CONFLICT(email) DO UPDATE SET name` |
| 24 | `stripYear` missed `1990/05/25` and 2-digit years | Both patterns handled (`services/csv.js`), with a guard so a bare day isn't mistaken for a year |
| 25 | Duplicate photo filenames silently overwrote server-side | `buildPhotoMap` records duplicates; `/prepare` returns `duplicateFiles`; client shows a warning banner |
| 26 | Lightbox cache-busted every image (`?t=Date.now()`) | Per-poster version map — only regenerated posters get a fresh `?t` |
| 27 | 4 unused heavyweight npm deps (`three`, `@react-three/fiber`, `framer-motion`, `@paper-design/shaders-react`) | Uninstalled (~40MB per install; login shader loads from esm.sh) |
| 28 | Admin auto-refresh snapped open dropdowns shut; doughnut chart leaked on the empty path | Dropdowns rebuild only when the email set changes (`data-sig`); `charts.doughnut.destroy()` before empty-state innerHTML; restored `role="img"`/aria-label |
| 29 | Misc: stale QR after clearing number; "Add anyway" bypassed validation; logout bar unescaped; `getFileSuffix` read the DOM not state; DB-down users stuck on `/waiting`; `job.signatures` not reset with posters/photos; aria-label double-escaped | All fixed (`public/index.html`, `server.js`) |

---

## Verification performed

- `services/csv.js`: unit repros — `TBD`/`TBA 15` untouched, `Augsut`→August, `1990/05/25`→May 25, 2-digit year stripped, short row + BOM parse cleanly
- `services/poster.js`: end-to-end render smoke test — normal poster identical; hostile poster (XSS payload + `$` patterns) renders as literal text
- `server.js`: boots clean; `/job`, `/download-pdf`, `/qr-preview` → 302; `/reload-template`, `/admin.html` → 403
- All JS files pass `node` syntax load

**Files changed:** `server.js`, `services/poster.js`, `services/csv.js`, `services/matcher.js`, `services/db.js`, `public/index.html`, `public/admin.html`, `deploy.sh`, `package.json`
