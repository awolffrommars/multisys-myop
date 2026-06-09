# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
POST /regenerate/:id/:n — re-renders a single poster with updated data/photo
POST /reload-template   — hot-reloads all template PNGs from disk without restarting
```

**In-memory job store:** `jobs` Map keyed by UUID. Each job holds `{ employees, photoMap, posters[], photos[], status, templateKey }`. `photos[]` stores `{base64, format}` per successfully rendered poster (1:1 index with `posters[]`) so `/regenerate` can re-use the original photo without re-uploading. Puppeteer browser singleton lives for one batch (`closeBrowser()` in the `finally` block).

**Template loading:** All three template PNGs are loaded at startup into `templates` map keyed by `'new-employee'`, `'birthday'`, and `'anniversary'`. `/prepare` receives `template` and `inputMode` fields from the client. Missing PNGs log a warning but do not crash.

**SSE events** from `GET /generate/:jobId`:
```js
{ type: 'progress', row, name, position, department, division, birthdayDate, status: 'processing'|'done'|'skipped'|'error', message? }
{ type: 'complete', count }
{ type: 'error', message }
```

**Poster rendering:** `services/poster.js` — `renderPoster(data, photoData, templateBase64, config, templateKey)`. Loads HTML template based on `templateKey`, replaces all tokens via `.replaceAll()` (not `.replace()` — ensures duplicate tokens in a template are all substituted), screenshots at 1920×1081.
- **New Employee:** Full Name has `white-space: nowrap`. If name length > 24 chars, injects `font-size: 29px !important` via a `<style>` tag before `</head>`. Font wait uses `await page.evaluate(async () => await document.fonts.ready)`.
- **Birthday:** Full Name renders at fixed 57px with `white-space: nowrap` — no shrinking applied.
- **Anniversary:** Full Name is split into `{{FIRST_NAME}}` (all tokens except last) and `{{LAST_NAME}}` (last token) in `poster.js` before token replacement. A single-word name sets `lastName = ''` and emits a `console.warn` — no crash, last-name overlay is blank.

**Photo matching:** `services/matcher.js` exports `normalizeNameKey(str)` — lowercases, strips commas/separators, sorts tokens. Replicated client-side for live feedback.

**CSV parsing:** `services/csv.js` — `parseCSV(buffer, templateKey)`. Detects header row via keyword list. Dates go through two corrections:
1. `correctMonthSpelling` — capitalisation fix → prefix expansion → Levenshtein ≤ 3
2. `stripYear` — removes year from any format: `May 01 1990` → `May 01`, `1990-08-25` → `August 25`, `08/25/1990` → `August 25`

**Download filenames:** `LastName, FirstName-TemplateName-MMDDYY.png`. ZIP is named `TemplateName-MMDDYY.zip`.

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
--name-top:      816px;   /* Full Name */
--pos-top:       860px;   /* Position */
--dept-top:      893px;   /* Department */
```

Font sizes: Full Name 36px/800 (29px if name > 24 chars), Position 27px/600, Department 27px/400. All `color: #000`, all `text-align: center`.

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

**Text layout:** All four text fields (name, position, department, division) live inside a single `.text-block` flex-column div anchored at `--name-top`. They flow downward with fixed `margin-bottom` gaps (23px / 14px / 19px) so a wrapping name pushes the rows below it down cleanly.

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

**CSV validation:** Format mismatch is checked client-side on file select and server-side for batch uploads. Manual entry bypasses format validation and builds a synthetic CSV submitted to `/prepare`.

### Birthday CSV internal key quirk

`csv.js` stores Birthday columns as:
- `department` key ← col D (Division text)
- `division` key ← col E (Department text)

The keys appear swapped but this is intentional — the poster template tokens `{{DEPARTMENT}}` and `{{DIVISION}}` happen to map correctly this way. The manual entry form compensates with a label swap in `onTemplateChange()`: `manualDept` input is labeled "Division" and `manualDivision` input is labeled "Department" for the birthday template.

**Do not "fix" this key naming without updating both the poster template tokens and the manual entry label swap.**

## Template Selector

Step 1 shows a "Select Template" card. **No template is selected by default** — the "Add Employees" card is locked until a template is chosen. Switching templates clears all uploaded files and manual entries.

- **Birthday Poster** — `tpl-birthday`, color `#cc3333`, active
- **New Employee Poster** — `tpl-new-employee`, color `#ffb133`, active
- **Work Anniversary** — `tpl-anniversary`, color `#eb6004`, active (fully implemented)

## UI Flow (Step 1 → 2 → 3)

**Step 1 — Add Employees** has two tabs. Switching tabs clears any error banner.

- **Batch Upload**: CSV + bulk PNG photos. Client-side CSV type detection fires on file select. A × button appears on the CSV zone to remove the file; a × button also appears on the photo zone to remove all photos at once. Photos shown in a list with match status (red = no CSV match, purple = duplicate).

- **Manual Entry**: Fields vary by template. New Employee uses a simple 3-column grid (Full Name | Position | Department). Birthday and Anniversary use a **6-column grid** with two rows:
  - Row 1: `[Birthday or Years (1col)] [Full Name (2col)] [Position (3col)]`
  - Row 2: `[Division (3col)] [Department (3col)]` — Department is always last
  - CSS classes: `bday-layout` for Birthday, `ann-layout` for Anniversary (applied to `#manualFormRow`)
  - Form field IDs used as grid targets: `#manualBirthdayField`, `#manualYearsField`, `#manualNameField`, `#manualPositionField`, `#manualDeptField`, `#manualDivisionField`
  - For anniversary row 2, explicit `grid-column` + `grid-row` are set to force Division left / Department right (DOM order is Dept before Div)

  Required fields show a red `*` (Full Name, Position, Birthday for birthday; Full Name, Position, Years for anniversary). Birthday field has live month-spelling autocorrect on blur (hint shown inline to the right). Same autocorrect applies in the Edit Poster modal. All inputs have `autocomplete="off"`. Validation warnings (confirm banner): empty department, empty division (birthday/anniversary only), filename mismatch, **duplicate name**. Clicking Edit on a listed employee while another is mid-edit **auto-saves** the current form first.

**Step 2 — Employee Preview**: table with Division and Birthday/DateHired/Years columns shown only for relevant templates. Photo column uses `.th-photo` class (width 90px); upload column uses `.th-upload` (width 120px) — do NOT use nth-child selectors for these.

**Step 3 — Progress + Gallery**: CSS border spinner. Edit modal includes Division + Birthday fields for Birthday template; Years for Anniversary. Lightbox supports prev/next navigation (‹ › buttons + ← → arrow keys, Esc to close).

## Design System

Canvas: `#090909`, Surface-1: `#141414`, Surface-2: `#1c1c1c`. Accent blue (`#0099ff`) only for links/focus rings. CTAs are white pills (`border-radius: 100px`). Typography: Inter with `font-feature-settings: 'cv01','cv05','cv09','cv11','ss03','ss07'`.

Page layout: `.main` max-width is `900px`. `.page` uses `justify-content: flex-start` (not `center`) to prevent content from shifting upward when expandable sections grow.

## V1 Backups / Future Work

V1 backups: `server.v1.js`, `public/index.v1.html`, `templates/poster.v1.html`. `npm run start:v1` launches V1.

**V2 concept (paused):** Externalize template positions into `template-config.json` editable via UI gear button. Resume when a new template needs a different layout.
