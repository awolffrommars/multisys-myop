# Handoff — MakeYourOwnPoster

Last updated: 2026-06-09

## What this app does

Express + Puppeteer poster generator. User selects a template, uploads a CSV + PNG photos (or enters employees manually), previews the match, generates poster PNGs, and downloads a ZIP. Three templates: New Employee, Birthday, Work Anniversary (anniversary rendering not yet complete — see below).

Start the server: `npm start` → http://localhost:3000

---

## Current state: what's done

### New Employee template — fully working
- CSV: `Full Name, Position, Department`
- Poster HTML: `templates/poster.html`
- Font shrink at >24 chars (29px instead of 36px)

### Birthday template — fully working
- CSV: `Birthday, Full Name, Position, Division, Department`
- Poster HTML: `templates/poster-birthday.html`
- Date auto-correction (month spelling + year strip) in `services/csv.js`
- Full Name fixed at 57px, no shrinking
- Manual entry: 6-col grid — `[Birthday | Full Name | Position]` / `[Division | Department]`

### Work Anniversary template — client + server done, poster HTML missing
- CSV: `Date Hired, Years, Full Name, Position, Division, Department`
- Server validates Years column is numeric; rejects invalid CSVs
- `services/csv.js` parses anniversary rows into `{ dateHired, anniversaryYears, fullName, position, division, department }`
- `server.js` passes `anniversaryYears` and `dateHired` to `renderPoster()`
- Manual entry: 6-col grid — `[Years | Full Name | Position]` / `[Division | Department]`
- Template card in the UI is enabled and selectable
- **MISSING:** `templates/Work Anniversary Poster_Template.png` (background image)
- **MISSING:** `templates/poster-anniversary.html` (HTML layout)
- Currently falls through to `poster.html` — generates a broken new-employee poster

---

## What needs to be done next

### 1. Create `templates/poster-anniversary.html`

Copy `poster-birthday.html` as a starting point. Tokens to replace:
- `{{TEMPLATE_BASE64}}` — background PNG (same pattern as other templates)
- `{{PHOTO_BASE64}}` — employee photo
- `{{FULL_NAME}}`
- `{{POSITION}}`
- `{{DIVISION}}`
- `{{DEPARTMENT}}`
- `{{ANNIVERSARY_YEARS}}` — e.g. "3" or "5"
- `{{DATE_HIRED}}` — e.g. "May 01" (already year-stripped by csv.js)

### 2. Create `templates/Work Anniversary Poster_Template.png`

Background image for the anniversary poster. Drop the PNG into the `templates/` folder, then hit `POST /reload-template` (or restart the server) to load it.

### 3. Update `services/poster.js` line 27

```js
// Current (broken for anniversary):
const htmlFile = templateKey === 'birthday' ? 'poster-birthday.html' : 'poster.html';

// Fix:
const htmlFile = templateKey === 'birthday'    ? 'poster-birthday.html'
               : templateKey === 'anniversary' ? 'poster-anniversary.html'
               : 'poster.html';
```

### 4. Add token replacements in `services/poster.js` (~line 44)

```js
// Add these two lines to the .replace() chain:
.replace('{{ANNIVERSARY_YEARS}}', data.anniversaryYears || '')
.replace('{{DATE_HIRED}}', data.dateHired || '')
```

---

## Key quirks — read before touching these areas

### Birthday CSV key inversion (intentional)
`services/csv.js` stores birthday rows with SWAPPED keys:
- `department` key ← holds Division text (col D)
- `division` key ← holds Department text (col E)

This is intentional — the poster template's `{{DEPARTMENT}}` and `{{DIVISION}}` tokens happen to produce the correct output this way. The manual entry form compensates with a label swap inside `onTemplateChange()` in `index.html`.

**Do not rename these keys without also updating the poster template tokens AND the label swap.**

### Manual form grid (index.html)
The form row `#manualFormRow` has 6 children in this DOM order:
1. `#manualBirthdayField` — hidden by default; shown + grid-positioned by `bday-layout`
2. `#manualYearsField` — hidden by default; shown + grid-positioned by `ann-layout`
3. `#manualNameField`
4. `#manualPositionField`
5. `#manualDeptField`
6. `#manualDivisionField` — hidden by default for new-employee

CSS classes on `#manualFormRow`:
- (none) → 3-col grid, only Name/Position/Dept visible — New Employee
- `bday-layout` → 6-col, Birthday(1) | Name(2) | Position(3) / Division(3) | Department(3)
- `ann-layout` → 6-col, Years(1) | Name(2) | Position(3) / Division(3) | Department(3)

For `ann-layout`, Division and Department get explicit `grid-column` + `grid-row` to swap their visual order (DOM has Dept before Div, but the layout needs Div first).

### `onTemplateChange()` in index.html
This function manages ALL template-specific UI state: grid class, field visibility, label swaps (birthday), CSV hint text, preview table columns, edit modal fields. Always update it when adding template-specific UI behavior.

### `buildPrepareForm()` in index.html
Builds the synthetic CSV sent to `/prepare` for manual-entry jobs. If you change CSV column order in `services/csv.js`, update this function to match.

---

## File map

```
server.js                      — Express routes, job store, ZIP builder
services/
  csv.js                       — CSV parsing for all 3 templates
  matcher.js                   — normalizeNameKey(), buildPhotoMap(), findPhoto()
  poster.js                    — Puppeteer rendering, browser singleton
public/
  index.html                   — entire frontend (single file)
templates/
  poster.html                  — New Employee poster layout
  poster-birthday.html         — Birthday poster layout
  poster-anniversary.html      — ⚠ MISSING — needs to be created
  New Employee Poster_Template.png
  Birthday Poster_Template.png
  Work Anniversary Poster_Template.png  — ⚠ MISSING — needs to be created
  poster.v1.html               — V1 backup, ignore
```
