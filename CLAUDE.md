# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Pending Work

- **Google Drive + README:** Upload the three template PNGs to a shared Google Drive folder restricted to `@multisyscorp.com`, then update `README.md` — replace the current "contact kfgoting" note with the Drive link and add a note that users must be Multisys employees to access the files.
- **Deploy:** All accumulated changes (incl. the 2026-07-14 hardening batch, see `HARDENING-2026-07-14.md`) are uncommitted — `./deploy.sh "Various fixes."` commits + ships everything. Revert hatch: `git reset --hard backup-pre-hardening`.

## Backgrounds (2026-06-29)

### Login Page — Animated Mesh Gradient (`server.js`)

`loginPage()` injects a `position:fixed; z-index:0` `#bg-wrap` div with a WebGL shader canvas. Uses `@paper-design/shaders@0.0.76` via esm.sh (ES module import in a `<script type="module">`).

**Shader:** `meshGradientFragmentShader` with these uniforms:
```js
{ u_colors: [[0,0,0,1],[0.051,0.051,0.051,1],[0.102,0.102,0.102,1],[0.149,0.149,0.149,1], ...×6 black],
  u_colorsCount: 4, u_distortion: 0.5, u_swirl: 0.4,
  u_grainMixer: 0.1, u_grainOverlay: 0.05, u_scale: 1 }
```
**Critical:** `u_scale: 1` is required — vertex shader does `v_objectUV /= u_scale`; WebGL defaults to 0.0 → NaN UVs → black canvas.

**Login card:** `.box` uses glassmorphism: `background:rgba(255,255,255,0.04); backdrop-filter:blur(24px)` so it blends with the animated background.

### Main Page — Infinite Grid (`public/index.html`)

Two animated SVG layers inside `#grid-bg` (`position:fixed; z-index:0; pointer-events:none`):

1. **Base layer** (`#grid-base`, `opacity:0.05`): always-on dim grid
2. **Hover layer** (`#grid-hover`, `opacity:0.4`): same grid, brighter, revealed via `radial-gradient` CSS mask at mouse position

Both layers use `<pattern id="gbp">` / `<pattern id="ghp">` — their `x`/`y` attributes are animated together in `requestAnimationFrame` (speed: 0.15px/frame, wraps at 40px).

**Why two SVGs instead of body CSS + SVG:** The original approach used `background-image` on `body` (base) + SVG (hover), which caused a double-grid effect on hover because both layers were simultaneously visible. Moving both into `#grid-bg` fixed this — single grid that simply brightens under the cursor.

**Stacking:** `#grid-bg` at z-index:0 is behind `.page` at z-index:1. Transparent areas within `.page` show the grid through. Solid-background elements (`.card { background:#141414 }`) block it.

**Transparency pitfalls fixed:**
- `.card.locked`: previously `opacity:0.35` on the whole element made the card background transparent. Fixed: removed opacity from card, applied `opacity:0.35` only to `.card.locked > *` (children). Card background stays solid.
- `.success-card`: was `background:#22c55e0d` (5% opacity) — changed to `background:#0e1c11` (solid dark green)
- `.error-banner`: was `background:#ff55771a` (10% opacity) — changed to `background:#1c0c10` (solid dark red)

**Do NOT add a solid background to `.main` or `.page`** — this creates an ugly rectangle that blocks the grid in the gaps between cards.

## Template Selector

Five templates. First three (Birthday, New Employee, Work Anniversary) shown by default in a `repeat(3,1fr)` grid. Clicking **"▾ More Templates"** (`#moreTemplatesBtn`) toggles `#extraTemplatesGrid` (Calling Card, Multisys ID) with `display:none`/`''`. Button text changes to "▴ Less Templates" when open.

**Do NOT replace the More Templates toggle with a unified grid** — user explicitly wants the toggle preserved.

## Reload Last Job Button

Located above the step indicator (before `#stepIndicator` in HTML). Only shown to admin users (`user.isAdmin === true` from `/me` endpoint). Logic: `window._isAdmin` is set in the `/me` fetch callback; button shown only when `_isAdmin && localStorage.getItem('devLastJob')`. Also gated in the post-generation localStorage save.

## Commands

```bash
npm start          # Start the Express server on port 3000 (plain node — no nodemon)
PUPPETEER_SKIP_DOWNLOAD=true npm install  # Install deps without re-downloading Chromium

# Kill and restart (pkill doesn't match npm-expanded paths — use port):
lsof -ti :3000 | xargs kill -9
nohup node server.js > /tmp/poster-server.log 2>&1 &
```

Puppeteer downloads its own Chromium on `npm install`. If Chromium is already cached at `~/.cache/puppeteer`, skip the download with the env var above.

## Architecture

Single-file Express server (`server.js`). The pipeline is:

```
POST /prepare           — parses CSV + matches photos; returns preview + jobId
GET  /generate/:id      — SSE stream; renders posters via Puppeteer; skips employees without photos; blocks re-runs (EventSource auto-reconnects — guard checks job.status !== 'ready' and returns synthetic complete event)
GET  /preview/:id/:n    — serves individual poster PNG
GET  /download/:id      — builds ZIP on-demand with ?suffix= param for renamed files
POST /regenerate/:id/:n — re-renders a single poster with updated data/photo/signature
POST /reload-template   — hot-reloads all template PNGs from disk without restarting
```

**Template HTML loading:** `services/poster.js` reads template HTML files fresh from disk on every render call (no startup cache) — editing a template HTML file takes effect on the next generation with no server restart required. Only `server.js` itself requires a restart for code changes.

```
```

**In-memory job store:** `jobs` Map keyed by UUID. Each job holds `{ employees, photoMap, signatureMap, posters[], photos[], signatures[], status, templateKey }`. `photos[]` and `signatures[]` store `{base64, format}` per successfully rendered poster (1:1 index with `posters[]`) so `/regenerate` can re-use the originals without re-uploading. Puppeteer browser singleton lives for one batch (`closeBrowser()` in the `finally` block).

**Parallel rendering:** `CONCURRENCY = 2` in `server.js`. The generate loop slices employees into batches of 2 and runs `Promise.all` per batch. Results are pushed in original order after `Promise.all` resolves to keep `posters[]` / `photos[]` indices aligned.

**Template loading:** All five template PNGs are loaded at startup into `templates` map keyed by `'new-employee'`, `'birthday'`, `'anniversary'`, `'calling-card'`, and `'multisys-id'`. `/prepare` receives `template` and `inputMode` fields from the client. Missing PNGs log a warning but do not crash. `calling-card` bypasses the template PNG requirement check in `/prepare` (`noPhotoTemplate` flag) — it can generate without a PNG background.

**SSE events** from `GET /generate/:jobId`:
```js
{ type: 'progress', row, name, position, department, division, birthdayDate, status: 'processing'|'done'|'skipped'|'error', message? }
{ type: 'complete', count, names }   // count = front posters only (front+back pairs = 1); names = rendered front names IN ORDER — the client builds the gallery from this so an errored render doesn't shift cards onto the wrong poster
{ type: 'error', message }
```

`db.logHistory` also logs the front-only count and front-only names (`job.posters.filter(p => p.side !== 'back')`).

**Poster rendering:** `services/poster.js` — `renderPoster(data, photoData, templateBase64, config, templateKey, signatureData)`. Loads HTML template based on `templateKey`, replaces all tokens via `.replaceAll()` (not `.replace()` — ensures duplicate tokens in a template are all substituted), screenshots at 1920×1081.
- **Escaping (do NOT remove):** every text field goes through `escapeHtml()` before substitution — CSV cells must never execute as markup inside the render browser. All `replaceAll` calls use FUNCTION-form replacements (`() => value`): a plain string replacement makes `$&`/`` $` ``/`$$` in the data act as regex substitution patterns (re-injecting tokens / duplicating template HTML). Anniversary position `<br>` is inserted AFTER escaping each half.
- **Browser lifecycle:** module-level singleton + `activeRenders` counter — `closeBrowser()` is a no-op while any render is in flight (two concurrent batches share the browser; unconditional close killed the other batch's renders with "Target closed"). Every render's page is closed in a `finally` (error paths leaked pages).
- **Auto-fit (all templates):** After `document.fonts.ready`, an `AUTOFIT` pass in `renderPoster` measures each configured overlay's real rendered text width (via `document.createRange()` — NOT `scrollWidth`, which is floored at element width for fixed-width overlays) and shrinks font 1px at a time (floor 16px) until it fits. Uses `el.style.setProperty('font-size', ..., 'important')` so it beats the `config.nameFontSize !important` injection. Limits: new-employee/birthday name → parent column width; anniversary first/last name → 1030px (photo starts x=1155); calling-card name+position → 1400px; multisys-id first/last/position → 1700px. This replaced ALL char-count guards (new-employee >24 chars, calling-card >20/>26 chars) — do not re-add them.
- **New Employee:** Full Name has `white-space: nowrap`. Font wait uses `await page.evaluate(async () => await document.fonts.ready)`. Photo img has `position:relative; top:30px` — 30px headroom above the head, bottom 30px cropped by `overflow:hidden`.
- **Birthday:** Full Name renders at 57px with `white-space: nowrap` (auto-fit shrinks only if it overflows the 780px block).
- **Anniversary:** Full Name is split into `{{FIRST_NAME}}` (all tokens except last) and `{{LAST_NAME}}` (last token) in `poster.js` before token replacement. A single-word name sets `lastName = ''` and emits a `console.warn` — no crash, last-name overlay is blank.
- **Calling Card:** No photo required. QR code auto-generated from contact number via `qrcode` npm package. Phone normalized via `normalizePhone()`: `09xxxxxxxxx` → `tel:+639xxxxxxxxx`. QR passed as `{{QR_BASE64}}` data URL. Multisys bars logo (`public/msys-bars-logo.png`) overlaid on QR via `{{LOGO_BASE64}}` token with `mix-blend-mode: multiply`. Viewport: 1920×1080.
- **Multisys ID:** Employee photo required. Signature optional — uploaded separately (batch zone or manual file input), matched by employee name same as photos. `{{SIGNATURE_BASE64}}` token; when absent, `#sigOverlay` is hidden via injected CSS (`display:none`). Tokens cover Employee Information (employeeNumber, address, phoneNumber, philhealth, sss, tin, hdmf) and Emergency Contact (contactName, contactAddress, contactNumber). Viewport: 1920×1080.

**PDF download** (`renderPdf` in `services/poster.js`): Used for Multisys ID — generates a 2-page PDF, front card on page 1, back card on page 2. Page size is 508×807mm (exactly 1920×3050px at 96dpi) — native card dimensions, no fitting to A4, no white space, no stretching. Each image tag is 508×807mm with `page-break-after: always`. `@page { size: 508mm 807mm; margin: 0; }` in CSS + `width: '508mm', height: '807mm'` in `page.pdf()` options.

**Photo matching:** `services/matcher.js` exports `normalizeNameKey(str)` — strips diacritics via NFD decomposition (`normalize('NFD').replace(/[̀-ͯ]/g,'')`), lowercases, strips commas/separators, sorts tokens. Replicated client-side for live feedback. Diacritic stripping means "Escaño" and "Escano" match, "ñ"→"n", "é"→"e", etc. `buildPhotoMap` attaches a `duplicates` array to the returned Map (two files normalizing to the same key — last wins); `/prepare` returns them as `duplicateFiles` and the client shows a warning banner.

**Multer latin1 decode:** Multer parses multipart headers as `latin1` but browsers send filenames as UTF-8. `buildPhotoMap` re-decodes `file.originalname` via `Buffer.from(file.originalname, 'latin1').toString('utf8')` before normalizing — without this, filenames containing ñ, é, etc. arrive garbled and fail to match. Same decode applied to `photoFile.originalname` and `sigFile.originalname` in `/regenerate`.

**CSV parsing:** `services/csv.js` — `parseCSV(buffer, templateKey)`. Parser options: `relax_column_count: true` (Excel omits trailing empty cells — a short row must not abort the upload) and `bom: true`. Detects header row via keyword list. Dates go through two corrections:
1. `correctMonthSpelling` — capitalisation fix → prefix expansion → Levenshtein fuzzy match **only for words ≥ 4 chars, threshold `min(3, floor(len/2))`** — without the guard, `TBD`/`TBA`/`N/A` silently became "May"
2. `stripYear` — removes year from any format: `May 01 1990` → `May 01`, `1990-08-25`/`1990/08/25` → `August 25`, `08/25/1990` → `August 25`, trailing 2-digit years (`May 01 90`) also stripped

**Download filenames:**
- **New Employee / Calling Card / Multisys ID:** `LastName, FirstName-TemplateName-MMDDYY.png`. ZIP is `TemplateName-MMDDYY.zip`.
- **Birthday:** `MM-DD-LastName, FirstName-Birthday Poster.png` (MM-DD from `birthdayDate`). ZIP is `Birthday Poster.zip`. Generation date stripped.
- **Work Anniversary:** `MM-DD-LastName, FirstName-Work Anniversary Poster.png` (MM-DD from `dateHired`). ZIP is `Work Anniversary Poster.zip`. Generation date stripped.
- Applies to both individual Save button (client `buildFilename`) and ZIP download (server `/download`). `birthdayDate` stored on poster objects in job alongside existing `dateHired`.

**Photo uploads:** All photo inputs accept `.png` only.

## New Employee Poster Template (`templates/poster.html`)

Canvas: 1920×1081. CSS variable tuning:

```css
--photo-left:   1116px;
--photo-top:     136px;
--photo-width:   544px;
--photo-height:  648px;
--text-left:    1116px;
--text-width:    544px;
```

**Text block:** name/position/department live in a `.text-block` flex column (`top:784px; height:199px` — the white card strip measured from the template PNG: photo bottom 784 → card bottom 983) with `justify-content:center`, so spacing above and below the details is always even, wrapped lines included. Gaps: name→position 5px, position→department 3px. The old `--name-top`/`--pos-top`/`--dept-top` vars were removed (config injection still writes them but nothing reads them).

Font sizes: Full Name 36px/800 (auto-fit shrinks to fit 544px column), Position 27px/600, Department 27px/400. All `color: #000`, all `text-align: center`.

## Birthday Poster Template (`templates/poster-birthday.html`)

Canvas: 1920×1081. Source template PNG: `Birthday Poster_Template.png` (2561×1441, scale factor ≈ 0.75×). Coordinates measured from rendered PNG output — do NOT estimate from template PNG directly.

```css
--photo-left:   976px;   /* left edge of salmon placeholder  */
--photo-top:    143px;   /* top of salmon placeholder        */
--photo-width:  827px;   /* salmon right (1803) - left (976) */
--photo-height: 938px;   /* 1081 - 143                       */

--text-left:    174px;   /* matches [Position]/[Dept]/[Div] x-start */
--text-width:   780px;
--name-top:     675px;   /* anchor for the flex-column text block */

--date-right:    99px;   /* template x=2429 → canvas right=99 */
--date-top:      81px;   /* template y=114  → canvas top=86, then -5 nudge */
```

**Text layout:** All four text fields (name, position, department, division) live inside a single `.text-block` flex-column div anchored at `--name-top`. They flow downward with fixed `margin-bottom` gaps: name→position 23px, position→department 14px, department→division 12px. A wrapping name pushes rows below it down cleanly.

Font sizes: Full Name 57px/700 (`white-space: nowrap` — fixed, no shrinking), Position 36px/500, Department/Division 36px/400. All `color: #fff`.
Date: 38px/700, white, `text-transform: uppercase`, `text-align: right`.
Photo: `object-fit: cover; object-position: center top; background: transparent`.

Fields: `{{FULL_NAME}}`, `{{POSITION}}`, `{{DEPARTMENT}}`, `{{DIVISION}}`, `{{BIRTHDAY_DATE}}` (top-right).

## Work Anniversary Poster Template (`templates/poster-anniversary.html`)

Canvas: 1920×1081. Source template PNG: `Work Anniversary_Template.png` (1920×1080, scale 1:1 — no scale factor needed unlike Birthday).

**Photo overlay** (covers the orange placeholder inside the polaroid):
```css
left: 1155px; top: 151px; width: 529px; height: 627px; overflow: hidden;
/* img: object-fit: cover; object-position: center top; transform: scale(1.2); transform-origin: center top */
```

**Text overlays** (left side — aligned to template placeholder pixel rows):
```css
/* First name */
left: 125px; top: 277px; font-size: 95px; font-weight: 800; color: #fff;

/* Last name */
left: 125px; top: 396px; font-size: 95px; font-weight: 800; color: #fff;

/* Position */
left: 118px; top: 654px; font-size: 35px; font-weight: 700; color: #fff; text-transform: uppercase;

/* Division */
left: 118px; top: 733px; font-size: 32px; font-weight: 400; color: #fff;

/* Department */
left: 118px; top: 813px; font-size: 32px; font-weight: 400; color: #fff;
```

**Years overlay** (centered in the polaroid white strip at the bottom):
```css
left: 1419px; top: 875px; transform: translate(-50%, -50%);
font-size: 89px; font-weight: 800; color: #eb6004;
```

**"WORK ANNIVERSARY" label** (right white border of polaroid, rotated -90°):
```css
/* container */
position: absolute; left: 1626px; top: 151px; width: 80px; height: 627px;
display: flex; align-items: center; justify-content: center; z-index: 15;

/* span */
display: block; transform: rotate(-90deg); white-space: nowrap;
font-size: 52px; font-weight: 700; color: #f4f1f1; text-transform: uppercase;
```

**Name splitting** (`services/poster.js`): `fullName` is split into `{{FIRST_NAME}}` (all tokens except last) and `{{LAST_NAME}}` (last token). No long-name guard.

Fields: `{{TEMPLATE_BASE64}}`, `{{PHOTO_BASE64}}`, `{{FIRST_NAME}}`, `{{LAST_NAME}}`, `{{POSITION}}`, `{{DIVISION}}`, `{{DEPARTMENT}}`, `{{ANNIVERSARY_YEARS}}`.
(`{{DATE_HIRED}}` is replaced server-side but has no display slot in the current template.)

## Calling Card Template (`templates/poster-calling-card.html`)

Canvas: 1920×1152. Template PNG: `Calling-Card-FRONT_Template.png`. Back: `Calling-Card-BACK_Template.png` (no overlays on back — do NOT add any).

**Overlay positions (tuned):**
```css
.name-overlay     { left:0; top:124px; width:1920px; text-align:center; font-size:100px; font-weight:800; color:#fff; white-space:nowrap; }
.position-overlay { left:0; top:233.5px; width:1920px; text-align:center; font-size:53.5px; font-weight:500; color:#fff; white-space:nowrap; }
.email-overlay    { left:208px; top:556px; font-size:44px; font-weight:400; color:#1a1a1a; white-space:nowrap; }
.phone-overlay    { left:208px; top:642px; display:flex; flex-direction:column; gap:2px; }
.phone            { font-size:44px; font-weight:400; color:#1a1a1a; line-height:1.25; white-space:nowrap; }
.qr               { left:1326px; top:546px; width:474px; height:474px; }
```

**Phone rendering:** `{{PHONE_LINES}}` token replaced by `poster.js` with one `<div class="phone">` containing all numbers joined by ` / `. Numbers displayed as `+63 XXX XXX XXXX` (spaces, not dashes) via `formatPhoneDisplay()`, which strips ALL non-digits plus leading `00`/`63`/`0` first — so any source format (`09…`, `0961-018-8389`, `+63 9…`, `0063 9…`, bare `9…`, dots/parens) renders correctly. `normalizePhone()` (QR URI) is equally tolerant and has a client-side mirror in `index.html` (QR preview URI) — keep the two in sync. QR uses first number only. QR logo: `height:136px`.

**Long-name sizing:** handled by the measured AUTOFIT pass (name + position, 1400px limit) — the old >20/>26 char guards are gone.

Fields: `{{TEMPLATE_BASE64}}`, `{{FULL_NAME}}`, `{{POSITION}}`, `{{EMAIL}}`, `{{PHONE_LINES}}`, `{{QR_BASE64}}`, `{{LOGO_BASE64}}`.
QR logo overlay: `public/msys-bars-logo.png` passed as `{{LOGO_BASE64}}`; `height:136px` with `mix-blend-mode:multiply`.

## Multisys ID Template (`templates/poster-multisys-id.html`)

Canvas: 1920×3050 (portrait). Template PNG: `Multsys-ID-FRONT_Template.png`.

**Name splitting** (`services/poster.js`): same as anniversary — all tokens except last → `{{FIRST_NAME}}`, last token → `{{LAST_NAME}}`. **Exception:** when `/regenerate` supplies explicit `firstName`/`lastName` fields in the request body, those are used directly without re-splitting — this preserves multi-word last names (e.g. "De Apalat") entered via the edit modal.

```css
--photo-left:   290px;   --photo-top:    445px;
--photo-width:  1340px;  --photo-height: 1489px;

--banner-top:   1920px;  --banner-height: 655px;   /* red banner: name + position */

--sig-left:     414px;   --sig-top:    2615px;
--sig-width:    1092px;  --sig-height: 290px;

--empnum-top:   2816px;  --empnum-height: 180px;
```

**Text styles:**
- First name: 160px / 700 / white / `white-space: nowrap` / `position: relative; top: -14px`
- Last name: 160px / 700 / white / `white-space: nowrap`
- Position: 63px / 500 / white / `position: relative; top: 26px`
- Employee number: 110px / 700 / black / `letter-spacing: 6px`

**Signature:** `#sigOverlay` z-index: 20 (above emp-num z-index: 10) — layering only, do NOT reposition. Hidden via injected `<style>` when no signature provided.

Fields: `{{TEMPLATE_BASE64}}`, `{{PHOTO_BASE64}}`, `{{FIRST_NAME}}`, `{{LAST_NAME}}`, `{{POSITION}}`, `{{EMPLOYEE_NUMBER}}`, `{{SIGNATURE_BASE64}}` (optional — overlay hidden via injected CSS when absent).

Note: `{{ADDRESS}}`, `{{PHONE_NUMBER}}`, `{{PHILHEALTH}}`, `{{SSS}}`, `{{TIN}}`, `{{HDMF}}`, `{{CONTACT_NAME}}`, `{{CONTACT_ADDRESS}}`, `{{CONTACT_NUMBER}}` tokens are replaced by poster.js but have no display slots in the current front-card template.

## CSV Formats

**New Employee:** `Full Name, Position, Department`

**Birthday:** `Birthday, Full Name, Position, Division, Department`
- Birthday format: `Month DD` (e.g. `May 01`) — month spelling auto-corrected and year stripped server-side
- Years in any format are stripped automatically (`May 01, 1990`, `1990-08-25`, `08/25/1990` all work)
- Client detects wrong CSV format immediately on file selection, shows an error, and **clears the CSV zone**

**Work Anniversary:** `Date Hired, Years, Full Name, Position, Division, Department`
- Date Hired: same auto-correction as Birthday (month spelling + year strip)
- If the Years column is missing or non-purely-numeric, the server rejects the CSV with a 400 error (uses `/^\d+$/` regex — `'5abc'` is rejected, unlike `isNaN(parseInt(...))` which would pass it)
- Client detects anniversary CSVs by checking: first col is date-like AND second col is purely numeric

**Calling Card:** `Full Name, Position, Email, Contact Number`
- No photo required — `photoFound` is always `true` server-side; photo zone hidden in UI
- QR code auto-generated from Contact Number in `poster.js` (not from CSV)
- Client detects calling-card CSVs by header keyword: column contains "email", "mobile", or equals "contact number"

**Multisys ID:** `Employee Number, Full Name, Position, Address, Phone Number, SSS Number, TIN, Pag-ibig, PhilHealth Number, Emergency Contact Name, Emergency Contact Address, Emergency Contact Number`
- Employee photo required (normal photo matching)
- Client detects multisys-id CSVs by header keyword: column contains "sss", "philhealth", or "hdmf"/"pag-ibig"/"pagibig"
- Fallback detection: ≥10 non-empty columns → multisys-id; 4 columns → calling-card; 3 columns → new-employee

**CSV validation:** Format mismatch is checked client-side on file select and server-side for batch uploads. Manual entry bypasses format validation and builds a synthetic CSV submitted to `/prepare`.

### Birthday CSV internal key quirk

`csv.js` stores Birthday columns as:
- `department` key ← col D (Division text)
- `division` key ← col E (Department text)

The keys appear swapped but this is intentional — the poster template tokens `{{DEPARTMENT}}` and `{{DIVISION}}` happen to map correctly this way. The manual entry form compensates with a label swap in `onTemplateChange()`: `manualDept` input is labeled "Division" and `manualDivision` input is labeled "Department" for the birthday template.

**Do not "fix" this key naming without updating both the poster template tokens and the manual entry label swap.**

## Template Selector

Step 1 shows a "Select Template" card. **No template is selected by default** — the "Add Employees" card is locked until a template is chosen. Switching templates clears all uploaded files and manual entries.

All 5 templates are shown in a unified `repeat(6, 1fr)` CSS grid (`#mainTemplateGrid`): first 3 cards span 2 columns each (row 1), last 2 span 3 columns each (row 2). No "More Templates" toggle — the old split grid + hidden extra-templates row was replaced.

- **Birthday Poster** — `tpl-birthday`, color `#cc3333`, active
- **New Employee Poster** — `tpl-new-employee`, color `#ffb133`, active
- **Work Anniversary** — `tpl-anniversary`, color `#eb6004`, active (fully implemented)
- **Calling Card** — `tpl-calling-card`, color `#0099ff`, active (pipeline complete; awaiting template PNG `Calling Card_Template.png`)
- **Multisys ID** — `tpl-multisys-id`, color `#22c55e`, active (pipeline complete; awaiting template PNG `Multisys ID_Template.png`)

## UI Flow (Step 1 → 2 → 3)

**Step 1 — Add Employees** has two tabs. Switching tabs clears any error banner.

- **Batch Upload**: CSV + bulk PNG photos. Client-side CSV type detection fires on file select. A trash-icon (`.zone-remove-btn`) appears on the CSV zone, photo zone, and signature zone (multisys-id only) to remove files — centered inline SVG, matches photo list item × style. Photos shown in a list with match status (red = no CSV match, purple = duplicate). The "Upload & Preview" button changes to `<span class="btn-spinner"></span> Preparing…` while `/prepare` is in flight. The inline "Upload Photo" button in the Step 2 preview table shows a spinner + "Uploading…" text during the same request. Both are reset on error. **`clearAllFields()` must explicitly set `photoRemoveBtn.style.display = 'none'`** — omitting this leaves the × visible when the zone is empty after a template switch or back-navigation. For multisys-id, `#signatureZone` `margin-top` is set dynamically in `renderPhotoList()` — 12px when photos are present, 0 when the photo list is empty — so spacing above and below the zone stays visually balanced.

  **Inline photo upload (Step 2 "↑ Upload Photo"):** Renames the selected file to `${emp.fullName}.png`, removes from `photoFiles` any existing file whose normalized tokens are all a subset of the employee's name tokens (handles partial-name files like "Garlan, Peter.png" for "Peter Psalm Garlan"), then calls `submitPrepare()`. `submitPrepare()` calls `renderPhotoList()` after `renderPreview()` so the batch photo list match status updates immediately. Photo list match uses exact `normalizeNameKey` comparison — a file only shows as matched if its full normalized key matches a CSV employee name exactly.

- **Manual Entry**: Fields vary by template. New Employee uses a simple 3-column grid (Full Name | Position | Department). Birthday and Anniversary use a **6-column grid** with two rows:
  - Row 1: `[Birthday or Years (1col)] [Full Name (2col)] [Position (3col)]`
  - Row 2: `[Division (3col)] [Department (3col)]` — Department is always last
  - CSS classes: `bday-layout` for Birthday, `ann-layout` for Anniversary (applied to `#manualFormRow`)
  - Form field IDs used as grid targets: `#manualBirthdayField`, `#manualYearsField`, `#manualNameField`, `#manualPositionField`, `#manualDeptField`, `#manualDivisionField`
  - For anniversary row 2, explicit `grid-column` + `grid-row` are set to force Division left / Department right (DOM order is Dept before Div)
  - **Calling Card** uses `cc-layout` two-column flexbox (`display: flex !important` on `#manualFormRow.cc-layout`). `#ccLeft` and `#ccRight` are `display: contents` by default (transparent to other template grids) and become `display: flex; flex-direction: column` inside cc-layout. Left column: Full Name, Position, Email, Contact Number. Right column: "QR PREVIEW" label + `#qrPlaceholder` (dashed border, shown when no number entered) + `#manualQrPreview` (actual QR + URI + Download button, shown when a number is typed). Fields: `#manualEmailField`/`#manualEmail`, `#manualMobileField`/`#manualMobile`. Required: Full Name, Position, Email, Contact Number. No photo zone. QR preview label (`#qrPreviewLabel`), placeholder (`#qrPlaceholder`), and actual preview (`#manualQrPreview`) are hidden for all non-calling-card templates in `onTemplateChange()`.
  - **Multisys ID** shows basic fields (`#manualFormRow`) + extended `#manualIdSection` (Employee Number, Address, Phone, SSS, TIN, Pag-ibig Number, PhilHealth + Emergency Contact section + Signature upload zone `#manualSignatureZone`). IDs: `manualEmployeeNumber`, `manualAddress`, `manualPhoneNumber`, `manualSss`, `manualTin`, `manualHdmf`, `manualPhilhealth`, `manualContactName`, `manualContactAddress`, `manualContactNumber`, `manualSignatureInput`. Required: Full Name, Position. Photo zone visible. Signature optional.
    - **Employee Number** uses `phone-prefix-wrapper` with prefix `MTC-` — user types only the numeric portion; `MTC-` is prepended in JS at commit time (`employeeNumber ? 'MTC-' + employeeNumber : ''`).
    - **Phone Number** uses `phone-prefix-wrapper` with prefix `+63` — same pattern as Calling Card mobile; `+63` prepended at commit time (`phoneNumber ? '+63' + phoneNumber : ''`).
    - **Employee Info field order** matches CSV column order: Address → Phone Number → SSS Number (row 1); TIN → Pag-ibig Number → PhilHealth Number (row 2).
    - **Emergency Contact Number** also uses `phone-prefix-wrapper` with prefix `+63` in both add form and edit modal.

  Required fields show a red `*` (Full Name, Position, Birthday for birthday; Full Name, Position, Years for anniversary; Full Name, Position, Email, Contact Number for calling-card). Birthday field has live month-spelling autocorrect on blur (hint shown inline to the right). Same autocorrect applies in the Edit Poster modal. All inputs have `autocomplete="off"`. Validation warnings (confirm banner): empty department, empty division (birthday/anniversary only), filename mismatch, **duplicate name**. Clicking Edit on a listed employee while another is mid-edit **auto-saves** the current form first.

**Step 2 — Employee Preview**: table with Division and Birthday/DateHired/Years columns shown only for relevant templates. Email/Mobile shown for calling-card; Employee # shown for multisys-id; Department hidden for calling-card/multisys-id; Photo column hidden for calling-card; Signature column shown only for multisys-id. Photo column uses `id="thPhoto"` + `.th-photo` class (width 90px); upload column uses `id="thUpload"` + `.th-upload` (width 120px) — do NOT use nth-child selectors for these. All column header elements have IDs (`thDepartment`, `thDivision`, `thBirthday`, `thYears`, `thDateHired`, `thEmail`, `thMobile`, `thEmployeeNumber`, `thPhoto`, `thSignature`, `thUpload`) — both `onTemplateChange()` and `renderPreview()` manage visibility. The `✓ Found` badge in the Photo Match column has an inline trash button (`.photo-remove-btn`) — clicking removes the matched photo from `photoFiles` (CSV mode, same subset-token filter as inline upload) or clears `manualEmp.photoFile` (manual mode), then re-runs `submitPrepare()` so the row flips to `✗ Missing` with the upload button. The subset-token filter NEVER removes a file whose key exactly matches a *different* employee ("Peter Garlan.png" is a subset of "Peter Psalm Garlan" but may be Peter Garlan's own photo). `submitPrepare()` uses a monotonic `_prepareSeq` token — out-of-order responses from overlapping calls are discarded.

**Client state guards (do not remove):** `popstate` falls back to step 1 when `currentJobId` is null (Back after Start Over reached a stale gallery whose Edit POSTed `/regenerate/null/0`); Start Over and `clearAllFields()` (template switch) clear `currentJobId`/`currentEmployees` + gallery DOM. `showGallery(jobId, count, names)` builds cards from the server's rendered-names list (falls back to `photoFound` filter when absent — dev reload path). Lightbox uses `_posterVersions[index]` for cache-busting (set on regenerate) — NOT `Date.now()`, which re-downloaded every full PNG per prev/next. Manual-entry edit-load strips `MTC-`/`+63` prefixes and rebuilds extra mobile rows + signature state; the mid-edit auto-save normalizes identically to `commitEmployee` (prefixes, joined mobiles, `signatureFile`). Signatures are optional everywhere (`/prepare` block and manual-entry requirement removed 2026-07-13).

**Step 3 — Progress + Gallery**: CSS border spinner. Edit modal includes Division + Birthday fields for Birthday template; Years for Anniversary. Lightbox supports prev/next navigation (‹ › buttons + ← → arrow keys, Esc to close).

**Edit modal:** `checkEditChanged()` must include `!!editSignatureFile` in its `changed` expression — without it a signature-only replacement leaves the Regenerate button disabled. `/regenerate` preserves `birthdayDate`/`dateHired` on the poster record (falling back to the previous poster's values) — `/download` builds MM-DD filename prefixes from them.

**Edit modal — Multisys ID specifics:**
- Full Name is split into separate **First Name** / **Last Name** inputs (`#editFirstName`, `#editLastName`) — Department field is hidden.
- Employee Number, Phone Number, Contact Number use `phone-prefix-wrapper` (MTC- / +63 / +63). Values are stripped of prefix and dashes on populate; prefixes re-attached on save.
- SSS, TIN, HDMF, PhilHealth, Employee Number, Phone Number, Contact Number are digit-only (JS `replace(/\D/g, '')` on input).
- Signature zone (`#editSignatureZone`) shown below photo zone; file sent as `signature` field to `/regenerate`.
- `emp._editFirstName` / `emp._editLastName` stored on the employee object after each regenerate so re-opening the modal preserves multi-word last names without re-splitting from `fullName`.

## Design System

Canvas: `#090909`, Surface-1: `#141414`, Surface-2: `#1c1c1c`. Accent blue (`#0099ff`) only for links/focus rings. CTAs are white pills (`border-radius: 100px`). Typography: Inter with `font-feature-settings: 'cv01','cv05','cv09','cv11','ss03','ss07'`.

Page layout: `.main` max-width is `900px`. `.page` uses `justify-content: flex-start` (not `center`) to prevent content from shifting upward when expandable sections grow.

**UI/UX audit fixes applied (2026-06-25 → 2026-06-26, all 15 findings):**
- **Contrast (C1):** All `#555`/`#666` text on dark surfaces → `#888` (WCAG AA). Affected: `.hint`, `.zone-sub`, `.form-label`, `.preview-table th`, `.progress-detail`, `.progress-status`, `.manual-item-detail`, `.details-list`, `.step-label`, `.qr-preview-label`, `.template-option-badge`, `.details-toggle`, `.photo-match-hint.neutral`
- **Modal ARIA (C2):** Edit modal box has `role="dialog" aria-modal="true" aria-labelledby="editModalTitle"`; `openEditModal()` saves `_editModalTrigger = document.activeElement`, auto-focuses first visible input via `requestAnimationFrame`; `closeEditModal()` restores focus to trigger; Tab key trapped within `.edit-modal-box` focusable elements; Esc key closes modal
- **Touch targets (H1):** `.zone-remove-btn` enlarged to `min-width: 44px; min-height: 44px`; `.mode-tab` padding `12px 8px`
- **Alt text (H2):** Paired gallery images use `alt="${name} — front"` / `alt="${name} — back"` (was generic)
- **Step indicator (M1):** `.step-dot` / `.step-line` / `.step-label` elements before `#errorBanner`; `updateStepIndicator(n, complete)` toggles `.active` / `.done` classes; label reads "Step N of 3", turns green on step 3. Dot 3 is white (`active`) while generating; `showGallery()` calls `updateStepIndicator(3, true)` so all dots+lines turn green when generation completes
- **Browser history (M2):** `history.replaceState({step:1})` at load; `goToStep(n)` calls `history.pushState({step:n})`; `popstate` listener restores step without re-pushing (skipHistory=true)
- **Error focus (M3):** `commitManualEntry()` maps `missingFields[0]` to input ID via `_fieldMap` and calls `.focus()` on the first invalid element
- **Empty gallery (M4):** `showGallery()` early-returns with SVG illustration + message + "← Back to Upload" button when `count === 0`
- **Template grid (L2):** Replaced 3-card + hidden 2-card + "More Templates" toggle with unified `repeat(6,1fr)` grid (`#mainTemplateGrid`) — first 3 span 2 cols, last 2 span 3 cols
- **Lightbox swipe (L3):** Passive `touchstart`/`touchend` listeners on `#lightbox`; horizontal swipe (|dx|>50 and |dx|>|dy|) → `navigateLightbox(±1)`; swipe-down (dy>80 and |dy|>|dx|) → `closeLightbox()`
- **Disabled buttons:** `.btn:disabled { opacity: 0.45; cursor: not-allowed; pointer-events: none; }` — semantic + visual
- **Active press:** `.btn:active:not(:disabled) { transform: translateY(0) scale(0.98); transition-duration: 60ms; }`
- **Focus-visible parity:** Added `:focus-visible` to match `:hover` on upload zones, zone-remove-btn, btn-icon, upload-inline, gallery-dl, template options
- **Exit animations:** `fadeOutBackdrop` + `slideDownModal` keyframes; `.edit-modal-overlay.closing` and `.lightbox.closing` classes applied by `closeEditModal()` / `closeLightbox()` (120ms ease-in) — `animationend` listener removes the element after
- **Spinner on upload:** Upload button inner HTML replaced with `<span class="btn-spinner"></span> Preparing…` on click — reset in finally block
- **Success feedback:** `showSuccess(msg)` function reuses `#errorBanner` styled green (background `#1a3a1a`, color `#4ade80`, border `#2d6a2d`) — auto-hides after 2500ms; called from `doRegenerate()` after a successful re-render
- **Accessible error banners:** `#errorBanner` and `#manualErrorBanner` have `role="alert" aria-live="assertive"`
- **Template option aria-labels:** All 5 template cards have `aria-label="Select X template"`
- **Manual form scroll hint:** Manual form wrapped in `.form-scroll-wrap` div with a right-edge gradient fade (40px, transparent → #141414) to hint at overflow
- **Zone remove buttons:** Changed from `×` text to centered inline SVG trash icon (`.zone-remove-btn`) — matches photo-list item × style

## Auth & Admin System

**Auth is optional** — skipped entirely when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` env vars are absent (local dev without `.env` works fine).

**Login flow:**
- Google OAuth restricted to `@multisyscorp.com` accounts — `ALLOWED_DOMAIN` is checked in the GoogleStrategy callback; any non-matching email is rejected before reaching the DB
- **Whitelist** (full immediate access): `kfgoting`, `jhbanag`, `espingol`, `mtcabugnason` — all `@multisyscorp.com`
- Non-whitelisted `@multisyscorp.com` users → inserted as `pending` in DB → shown `/waiting` page (polls `/auth/status` every 5s → auto-redirects when approved)
- If DB is unavailable and user is not whitelisted → redirected back to `/login` (not stuck on `/waiting` forever)
- Denied users → `/denied` page (also polls every 5s → auto-redirects to `/` if admin re-approves them)
- No email notifications — approvals/denials are managed entirely through the admin dashboard

**Middleware:**
- `requireAccess` — blocks unless whitelisted OR DB status=`approved`; updates `last_seen` on each pass
- `requireAdmin` — blocks unless `req.user.email === ADMIN_EMAIL` (`kfgoting@multisyscorp.com`)

**Admin routes (all behind `requireAdmin`):**
```
GET  /admin               — serves public/admin.html
GET  /admin/data          — JSON: { pending, approved, denied, history, stats }
POST /admin/approve/:email
POST /admin/deny/:email
POST /admin/revoke/:email
```

**Auth routes:**
```
GET /login               — Google sign-in page
GET /auth/google         — OAuth redirect
GET /auth/google/callback
GET /waiting             — polling page for pending users
GET /denied
GET /auth/status         — returns { status: 'pending'|'approved'|'denied'|'unauthenticated' }
GET /logout
GET /me                  — returns { email, name } or {}
```

**Database:** `services/db.js` — Turso hosted SQLite via `@libsql/client` (async API). Persists across HuggingFace deploys. Falls back to local file (`data/myop.db`) when `TURSO_URL` is not set (local dev). Three tables:
- `users` — `email PK`, `name`, `status` (pending/approved/denied), `requested_at`, `approved_at`, `last_seen`
- `history` — `id`, `user_email`, `template`, `employee_count`, `employee_names` (JSON), `generated_at`, `duration_ms`
- `render_errors` — `id`, `user_email`, `template`, `employee_name`, `error_type`, `error_message`, `occurred_at`

`db.init()` is called at startup — creates all tables if they don't exist (idempotent). All db exports are `async`. `requireAccess` middleware is `async`. History is logged in `/generate` after `job.status = 'done'` — only when `AUTH_ENABLED && req.user && db`.

**Admin dashboard** (`public/admin.html`) — the Admin link on the main page opens in a new tab (`target="_blank" rel="noopener"`). Users nav icon is a simple single head+shoulders SVG:
- KPI cards: Total Users, Pending, Approved, Posters Generated
- Pending Requests table (approve/deny), with amber alert banner when non-empty
- Charts: Posters by Template (doughnut, template colors) + Daily Activity last 30 days (bar)
- Approved Users table (last seen, posters made, revoke)
- Denied Users table (with re-approve)
- Recent Activity table: header has a user filter dropdown (`#recent-user-filter`, options rebuilt from history each render, selection preserved across the 30s auto-refresh) and a date range dropdown (`#recent-range-filter`: 7/30/90/365/3650 days → `switchHistoryRange()` refetches `/admin/data?historyDays=N`; server clamps to 3650). User filter comes FIRST, range second. Badge shows `N batches · M posters <range label>` for the current filter. Rows render from module-level `_recentRows` (the filtered list) — `openActivityModal(idx)` indexes into `_recentRows`, NOT `DATA.history`; row count badge; scrollable (max-height 420px, sticky thead); modal `background:#141414` (do NOT use `var(--surface-1)` — undefined in admin.html); Esc/overlay click closes; `db.getHistory(days)` queries by date range not row limit
- Render Errors table; same scrollable + click-to-details treatment as Recent Activity; `openErrorModal(idx)` shows full untruncated error message in monospaced scrollable block; `background:#141414` for modal
- Auto-refreshes every 30 seconds via `setInterval(loadData, 30000)`

**Required env vars for full auth:**
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
SESSION_SECRET=...
ALLOWED_DOMAIN=multisyscorp.com
ADMIN_EMAIL=kfgoting@multisyscorp.com
WHITELIST=kfgoting@multisyscorp.com,jhbanag@multisyscorp.com,espingol@multisyscorp.com,mtcabugnason@multisyscorp.com
TURSO_URL=libsql://myop-awolffrommars.aws-ap-northeast-1.turso.io
TURSO_AUTH_TOKEN=...       # Database-level token from Turso dashboard (not org API key)
```

All of the above are also set as HuggingFace secrets. `TURSO_AUTH_TOKEN` must be a **database token** (generated from the specific DB page or via `turso db tokens create myop`) — org-level API keys return 401.

**Deploy:**
```bash
./deploy.sh "your commit message"
```
Handles GitHub push + HuggingFace orphan branch with git-lfs for template PNGs in one command. The script is failure-safe: an EXIT trap always returns the checkout to `main` and restores the 7 gitignored template PNGs (backed up to a `mktemp -d` dir before the branch dance), and it recovers cleanly when re-run after a stranded previous run.

## Security & Limits

See `HARDENING-2026-07-14.md` for the full 29-finding security/correctness audit record and the revert procedure (`git reset --hard backup-pre-hardening`).

**Auth mounts (server.js):** Express mount paths match at `/` boundaries only — `app.use('/download', requireAccess)` does NOT cover `/download-pdf`. Protected mounts: `/index.html`, `/prepare`, `/generate`, `/preview`, `/download`, `/download-pdf`, `/regenerate`, `/job`, `/qr-preview` (all `requireAccess`) and `/reload-template` (`requireAdmin`). Any NEW data-returning route must be added to this block.

**Fail-closed boot:** If `SPACE_ID` (HuggingFace) or `NODE_ENV=production` is set but Google OAuth creds are missing, the server exits at startup instead of silently running with auth off.

**Session cookie:** `trust proxy 1` + `{ secure: 'auto', httpOnly: true, sameSite: 'lax' }`.

**Async route safety:** All async auth/admin routes are wrapped in `asyncH()` (Express 4 doesn't catch async throws — unwrapped rejections hang the request); a JSON error middleware terminates forwarded errors. Query params that could be arrays (`suffix`, `mobile`) are coerced with `String()`; `Content-Disposition` filenames pass through `headerSafe()` (strips quotes/control chars).

**Multer upload limits:** `/prepare` enforces `fileSize: 20 MB` and `files: 501` (500 photos + 1 CSV), plus a 300 MB total Content-Length cap (413) before multer buffers into memory.

**Job store TTL:** The in-memory `jobs` Map is evicted every 10 minutes; entries older than 2 hours are deleted. `job.createdAt` is set at `/prepare` time. The interval uses `.unref()` so it doesn't block process exit. `/job/:id/reset` returns 409 while `status === 'generating'` (a mid-generation reset would let a second `/generate` interleave pushes and corrupt every index-based lookup).

**Static file guard:** When `AUTH_ENABLED`, `app.use('/admin.html', → 403)` is registered before `express.static` so the raw dashboard HTML cannot be fetched without going through `/admin` + `requireAdmin`.

**XSS prevention in admin.html:** ALL user-influenced strings inserted into `innerHTML` go through `esc()` — including the pending/approved/denied user tables (`u.name` is the Google display name = attacker-controlled; unescaped it enabled self-approval XSS), the errors table (message also lands in a `title="…"` attribute — `esc()` handles quotes), and template CSS classes. `enc()` additionally encodes `'` for onclick contexts. Do not add an unescaped interpolation.

**XSS prevention in poster rendering:** see the escaping bullet under Poster rendering — `escapeHtml()` + function-form `replaceAll` in `services/poster.js`.

**SSE reconnect guard:** The `/generate` re-entry guard sends a synthetic `complete` (with `count` + `names`) only when `job.status === 'done'`; for `error` it sends an error event; for `generating` it closes the stream empty so EventSource retries in ~3s. Client-side, `onerror` only surfaces an error when `readyState === CLOSED` and no complete arrived — transient blips auto-retry; `runGenerate` closes any previous EventSource before opening a new one.

**DB:** indexes on `history.generated_at`, `render_errors.occurred_at`, `users.status` (created in `db.init()`); `upsertPending` refreshes `name` via `ON CONFLICT(email) DO UPDATE` (status/requested_at untouched).

## V1 Backups / Future Work

V1 backups: `server.v1.js`, `public/index.v1.html`, `templates/poster.v1.html`. `npm run start:v1` launches V1.

**V2 concept (paused):** Externalize template positions into `template-config.json` editable via UI gear button. Resume when a new template needs a different layout.
