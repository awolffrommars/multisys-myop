# Handoff — MakeYourOwnPoster

Last updated: 2026-06-13

## What this app does

Express + Puppeteer poster generator. User selects a template, uploads a CSV + PNG photos (or enters employees manually), previews the match, generates poster PNGs, and downloads a ZIP.

**Three fully working templates:** New Employee, Birthday, Work Anniversary.

Start locally: `npm start` → http://localhost:3000
Live site: https://awolffrommars-multisys-myop.hf.space
GitHub repo: https://github.com/awolffrommars/multisys-myop

---

## Current state: everything is done and deployed

### Poster Templates

**New Employee**
- CSV: `Full Name, Position, Department`
- Poster: `templates/poster.html` (1920×1081)
- Font shrinks to 29px when name > 24 chars

**Birthday**
- CSV: `Birthday, Full Name, Position, Division, Department`
- Poster: `templates/poster-birthday.html` (1920×1081)
- Date auto-correction: month spelling + year strip in `services/csv.js`
- Full Name fixed at 57px, no shrinking
- **Key quirk:** `csv.js` stores birthday rows with swapped keys (`department` key holds Division text, `division` key holds Department text). This is intentional — do not fix.

**Work Anniversary**
- CSV: `Date Hired, Years, Full Name, Position, Division, Department`
- Poster: `templates/poster-anniversary.html` (1920×1081)
- Name split into `{{FIRST_NAME}}` / `{{LAST_NAME}}` in `poster.js` (last word = last name)
- Years displayed in orange (#eb6004) in the polaroid white strip
- Filenames prefixed with Date Hired as `MM-DD-`

---

## Auth & Admin System

Google OAuth login, restricted to `@multisyscorp.com`. No email notifications — all managed through the admin dashboard.

**Whitelist** (immediate access, no approval needed):
`kfgoting`, `jhbanag`, `espingol`, `mtcabugnason` — all `@multisyscorp.com`

**Non-whitelisted flow:**
1. User signs in → Google OAuth callback checks `ALLOWED_DOMAIN` first (rejects non-corporate accounts before they reach the DB)
2. Status set to `pending` in Turso DB → `/waiting` page shown — polls `/auth/status` every 5s, auto-redirects when approved
3. Admin approves/denies from `/admin` dashboard
4. `/denied` page also polls every 5s — auto-redirects to `/` if re-approved
5. Active sessions are kicked within 15s of revocation (index.html polls `/auth/status`)
6. If DB is unavailable during sign-in, non-whitelisted users are bounced back to `/login` instead of getting stuck on `/waiting`

**Admin dashboard** at `/admin` (kfgoting only):
- KPI cards, pending/approved/denied user tables, approve/deny/revoke
- Posters by template (doughnut) + daily activity charts
- Generation history table filterable by user and template
- Auto-refreshes every 30 seconds

---

## Database

**Turso** hosted SQLite via `@libsql/client` (async API). Persists across HuggingFace deploys — this was the whole reason for switching from `better-sqlite3` (local SQLite file gets wiped on every HF container restart).

`services/db.js` — all exports are async. `db.init()` is called at startup and creates tables idempotently.

Tables: `users`, `history`, `render_errors`

Falls back to a local file (`data/myop.db`) when `TURSO_URL` is not set — useful for local dev without Turso credentials.

**TURSO_AUTH_TOKEN must be a database-level token**, not an org API key. Generate it from the specific database page in the Turso dashboard, or via `turso db tokens create myop`. Org-level tokens return 401.

---

## Deployment

Single command — handles GitHub push + HuggingFace orphan branch with git-lfs for template PNGs:

```bash
./deploy.sh "your commit message"
```

Template PNGs are gitignored on `main` (so GitHub cloners don't get them), but force-added via git-lfs to the `hf` orphan branch on each deploy so HuggingFace can use them.

HF rebuilds automatically after push — takes 3–5 minutes.

---

## Environment variables

All of these are in `.env` locally (gitignored) and set as HuggingFace secrets:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
SESSION_SECRET=...
ALLOWED_DOMAIN=multisyscorp.com
ADMIN_EMAIL=kfgoting@multisyscorp.com
WHITELIST=kfgoting@multisyscorp.com,jhbanag@multisyscorp.com,espingol@multisyscorp.com,mtcabugnason@multisyscorp.com
TURSO_URL=libsql://myop-awolffrommars.aws-ap-northeast-1.turso.io
TURSO_AUTH_TOKEN=...
```

---

## Security & limits

- **ALLOWED_DOMAIN enforced at OAuth:** GoogleStrategy rejects any email that doesn't end with `@${ALLOWED_DOMAIN}` — non-corporate Google accounts can't queue for approval.
- **`/admin.html` blocked via static:** When `AUTH_ENABLED`, an explicit `app.use('/admin.html', → 403)` sits before `express.static` — the raw HTML is not fetchable without going through the authenticated `/admin` route.
- **Multer limits:** `/prepare` caps uploads at 20 MB per file and 501 files (500 photos + 1 CSV). Exceeded limits return a 413 from multer before the route handler runs.
- **Job store TTL:** `jobs` Map entries are evicted 2 hours after `createdAt`; a `.unref()`'d interval runs every 10 minutes.
- **XSS in admin.html:** All DB-sourced strings written to `innerHTML` go through `esc()` (HTML-escapes `&`, `<`, `>`, `"`).
- **SSE reconnect race:** `/generate` guard only sends synthetic `complete` when `job.status === 'done'`; mid-batch reconnects get an empty response and retry.

## Key quirks — read before touching these areas

### Birthday CSV key inversion (intentional)
`services/csv.js` stores birthday rows with swapped keys:
- `department` key ← holds Division text (col D)
- `division` key ← holds Department text (col E)

The poster template tokens `{{DEPARTMENT}}` and `{{DIVISION}}` produce correct output this way. The manual entry form compensates with a label swap in `onTemplateChange()` in `index.html`. **Do not rename these keys without also updating the poster template tokens AND the label swap.**

### Parallel rendering
`CONCURRENCY = 2` in `server.js` (reduced from 3 — was hanging during presentations). The generate loop slices employees into batches of 2 and runs `Promise.all` per batch. Results are pushed in original order after each batch to keep `posters[]` / `photos[]` indices aligned.

### Puppeteer
- Uses `waitUntil: 'domcontentloaded'` with `timeout: 60000` — avoids navigation timeout on HuggingFace where Google Fonts CDN is slow
- `executablePath` reads from `process.env.PUPPETEER_EXECUTABLE_PATH` — set to `/usr/bin/chromium` in Docker
- Browser is a singleton per batch; closed in the `finally` block after each `/generate` call

### `clearAllFields()` in index.html
Must explicitly set `photoRemoveBtn.style.display = 'none'`. If omitted, the × button stays visible on the photo zone after a template switch or back-navigation even when no photos are loaded.

### `onTemplateChange()` in index.html
Manages all template-specific UI state: grid class, field visibility, label swaps (birthday), CSV hint text, preview table columns, edit modal fields. Always update here when adding template-specific UI behavior.

### `buildPrepareForm()` in index.html
Builds the synthetic CSV sent to `/prepare` for manual-entry jobs. If CSV column order in `services/csv.js` changes, update this function to match.

### Async db middleware
`requireAccess` is an async Express middleware — wrap in try/catch and call `next(e)` on error (already done). All `db.*` calls throughout `server.js` are awaited.

---

## File map

```
server.js                        — Express routes, job store, ZIP builder (CONCURRENCY=2)
services/
  db.js                          — Turso async DB client; users/history/render_errors tables
  csv.js                         — CSV parsing for all 3 templates + date correction
  matcher.js                     — normalizeNameKey(), buildPhotoMap(), findPhoto()
  poster.js                      — Puppeteer rendering, browser singleton
public/
  index.html                     — entire frontend (single file)
  admin.html                     — admin dashboard (kfgoting only)
templates/
  poster.html                    — New Employee poster layout (1920×1081)
  poster-birthday.html           — Birthday poster layout (1920×1081)
  poster-anniversary.html        — Work Anniversary poster layout (1920×1081)
  *.png                          — template background images (gitignored on main; sent via git-lfs on hf branch)
Dockerfile                       — HuggingFace Docker config; @libsql/client is pure JS, no native build tools needed
deploy.sh                        — one-command deploy to GitHub + HuggingFace
README.md                        — teammate quickstart + CSV format reference
```
