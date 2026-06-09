# Handoff — MakeYourOwnPoster

Last updated: 2026-06-10

## What this app does

Express + Puppeteer poster generator. User selects a template, uploads a CSV + PNG photos (or enters employees manually), previews the match, generates poster PNGs, and downloads a ZIP.

**Three fully working templates:** New Employee, Birthday, Work Anniversary.

Start locally: `npm start` → http://localhost:3000
Live site: https://awolffrommars-multisys-myop.hf.space
GitHub repo: https://github.com/awolffrommars/multisys-myop

---

## Current state: everything is done

### New Employee
- CSV: `Full Name, Position, Department`
- Poster: `templates/poster.html` (1920×1081)
- Font shrinks to 29px when name > 24 chars

### Birthday
- CSV: `Birthday, Full Name, Position, Division, Department`
- Poster: `templates/poster-birthday.html` (1920×1081)
- Date auto-correction: month spelling + year strip in `services/csv.js`
- Full Name fixed at 57px, no shrinking
- **Key quirk:** `csv.js` stores birthday rows with swapped keys (`department` key holds Division text, `division` key holds Department text). This is intentional — do not fix.

### Work Anniversary
- CSV: `Date Hired, Years, Full Name, Position, Division, Department`
- Poster: `templates/poster-anniversary.html` (1920×1081)
- Name split into `{{FIRST_NAME}}` / `{{LAST_NAME}}` in `poster.js` (last word = last name)
- Years displayed in orange (#eb6004) in the polaroid white strip
- Single-word name logs a `console.warn` and leaves last-name overlay blank — no crash

---

## Deployment

Two-branch git strategy:
- `main` — has template PNGs, used for GitHub and local dev
- `hf` — orphan branch (no history), no PNGs, used for HuggingFace

HuggingFace rejects binary files in git. The Dockerfile downloads template PNGs from GitHub raw URLs at build time.

### To deploy updates (run in order every time):

**1. Push to GitHub:**
```bash
git add .
git commit -m "your message"
git push origin main
```

**2. Push to HuggingFace:**
```bash
git branch -D hf
git checkout --orphan hf
git rm --cached "templates/Birthday Poster_Template.png" "templates/New Employee Poster_Template.png" "templates/Work Anniversary_Template.png"
printf '\ntemplates/Birthday Poster_Template.png\ntemplates/New Employee Poster_Template.png\ntemplates/Work Anniversary_Template.png' >> .gitignore
git add .
git commit -m "HF deploy"
git push hf hf:main --force
git checkout main
```

HF rebuilds automatically after push — takes 3–5 minutes.

---

## Key quirks — read before touching these areas

### Birthday CSV key inversion (intentional)
`services/csv.js` stores birthday rows with swapped keys:
- `department` key ← holds Division text (col D)
- `division` key ← holds Department text (col E)

The poster template tokens `{{DEPARTMENT}}` and `{{DIVISION}}` produce correct output this way. The manual entry form compensates with a label swap in `onTemplateChange()` in `index.html`. **Do not rename these keys without also updating the poster template tokens AND the label swap.**

### Parallel rendering
`CONCURRENCY = 3` in `server.js`. The generate loop slices employees into batches of 3 and runs `Promise.all` per batch. Results are pushed in original order after each batch to keep `posters[]` / `photos[]` indices aligned.

### Puppeteer
- Uses `waitUntil: 'domcontentloaded'` (not `networkidle0`) with `timeout: 60000` — avoids navigation timeout on HuggingFace servers where Google Fonts CDN is slow
- `executablePath` reads from `process.env.PUPPETEER_EXECUTABLE_PATH` — set to `/usr/bin/chromium` in Docker, falls back to local Chrome path for local dev
- Browser is a singleton per batch; closed in the `finally` block after each `/generate` call

### `clearAllFields()` in index.html
Must explicitly set `photoRemoveBtn.style.display = 'none'`. If omitted, the × button stays visible on the photo zone after a template switch or back-navigation even when no photos are loaded.

### `onTemplateChange()` in index.html
Manages all template-specific UI state: grid class, field visibility, label swaps (birthday), CSV hint text, preview table columns, edit modal fields. Always update when adding template-specific UI behavior.

### `buildPrepareForm()` in index.html
Builds the synthetic CSV sent to `/prepare` for manual-entry jobs. If CSV column order in `services/csv.js` changes, update this function to match.

---

## File map

```
server.js                        — Express routes, job store, ZIP builder (CONCURRENCY=3)
services/
  csv.js                         — CSV parsing for all 3 templates + date correction
  matcher.js                     — normalizeNameKey(), buildPhotoMap(), findPhoto()
  poster.js                      — Puppeteer rendering, browser singleton
public/
  index.html                     — entire frontend (single file)
templates/
  poster.html                    — New Employee poster layout (1920×1081)
  poster-birthday.html           — Birthday poster layout (1920×1081)
  poster-anniversary.html        — Work Anniversary poster layout (1920×1081)
  New Employee Poster_Template.png
  Birthday Poster_Template.png
  Work Anniversary_Template.png
Dockerfile                       — HuggingFace Docker config; downloads PNGs from GitHub at build time
README.md                        — teammate quickstart + CSV format reference
```
