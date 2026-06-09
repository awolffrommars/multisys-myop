# Setup & Architecture Notes

## What's Running

A single-file Express server (`server.js`) with Puppeteer for poster rendering. No Google Cloud, no service account, no external APIs required.

## Install & Run

```bash
npm install                              # installs deps + downloads Chromium
PUPPETEER_SKIP_DOWNLOAD=true npm install # skip Chromium download if already cached
npm start                                # starts server on port 3000
npm run start:v1                         # runs V1 (Google Sheets version) for reference
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/prepare` | Parse CSV + match photos; returns preview data + jobId |
| `GET` | `/generate/:id` | SSE stream; renders posters one by one via Puppeteer |
| `GET` | `/preview/:id/:n` | Serve individual poster PNG |
| `GET` | `/download/:id` | Build + stream ZIP (optional `?suffix=` for filename override) |
| `POST` | `/regenerate/:id/:n` | Re-render a single poster with updated data/photo |
| `POST` | `/reload-template` | Hot-reload template PNGs from disk without restarting |

## Services

### `services/poster.js`

`renderPoster(data, photoData, templateBase64, config, templateKey)`

- Loads `poster.html` (New Employee) or `poster-birthday.html` (Birthday) from disk on each call
- Replaces `{{FULL_NAME}}`, `{{POSITION}}`, `{{DEPARTMENT}}`, `{{DIVISION}}`, `{{BIRTHDAY_DATE}}`
- Puppeteer browser singleton is reused within a batch; `closeBrowser()` is called in the `finally` block
- Font wait: `await page.evaluate(async () => await document.fonts.ready)` — **NOT** `evaluateHandle` (which returns a handle to the Promise without awaiting it)
- **New Employee name sizing:** if `fullName.length > 24`, injects `font-size: 29px !important; text-align: center !important` via a `<style>` tag. DOM measurement was attempted but is unreliable on `position: absolute` elements with `overflow: visible`
- **Birthday name sizing:** iterative 1px shrink from 57px down to 28px min while `scrollWidth > clientWidth` (works because the name is inside a flex container that constrains its width)

### `services/csv.js`

`parseCSV(buffer, templateKey)` — detects header row via keyword list. Column order:
- New Employee: `Full Name, Position, Department`
- Birthday: `Birthday, Full Name, Position, Department, Division`

Birthday date corrections applied in order:
1. `correctMonthSpelling` — capitalization fix → prefix expansion → Levenshtein ≤ 3
2. `stripYear` — removes year from any format (`May 01 1990` → `May 01`, `1990-08-25` → `August 25`)

### `services/matcher.js`

`normalizeNameKey(str)` — lowercases, strips commas/separators, sorts tokens. Used server-side for photo matching and replicated client-side for live feedback and duplicate detection.

## Templates

### New Employee (`templates/poster.html`)

Canvas: 1920×1081. Key CSS variables:

```css
--photo-left:   1116px;
--photo-top:     136px;
--photo-width:   544px;
--photo-height:  648px;
--text-left:    1116px;
--text-width:    544px;
--name-top:      816px;
--pos-top:       860px;
--dept-top:      893px;
```

All text elements use `text-align: center` explicitly (not just inherited). Full Name has `white-space: nowrap` — it does NOT wrap. Font sizes: Full Name 36px/800 (29px if name > 24 chars), Position 27px/600, Department 27px/400.

### Birthday (`templates/poster-birthday.html`)

Canvas: 1920×1081. Source PNG is 2561×1441 (scale ≈ 0.75×) — measure coordinates from the rendered PNG output, not the source PNG.

```css
--photo-left:   976px;
--photo-top:    143px;
--photo-width:  827px;
--photo-height: 938px;
--text-left:    174px;
--text-width:   780px;
--name-top:     675px;
--date-right:    99px;
--date-top:      81px;
```

All four text fields live in a single `.text-block` flex-column anchored at `--name-top`, flowing down with fixed `margin-bottom` gaps (23px / 14px / 19px). Individual `--pos-top`, `--dept-top`, `--div-top` variables are no longer used by the template.

Font sizes: Full Name 57px/700 (`white-space: nowrap`, shrinks iteratively), Position 36px/500, Department/Division 36px/400. All `color: #fff`. Date: 38px/700, `text-transform: uppercase`, `text-align: right`.

## UI Notes

### Manual Entry validation warnings (confirm banner)
- Department is empty
- Division is empty (Birthday template only)
- Photo filename doesn't match Full Name
- Employee name already exists in the list (checked via `normalizeNameKey`)

User can dismiss with "Add anyway" or fix and re-submit.

### Edit flow
Clicking ✎ on a listed employee while another is mid-edit **auto-saves** the current form values (pushed to end of list) before loading the selected employee.

### Progress list ("See N more queued")
When a hidden row is auto-revealed by its `processing` SSE event, the counter decrements. When N reaches 0, the element removes itself.

### Upload button (`.upload-inline`)
Font 11px, `padding: 4px 10px`, `white-space: nowrap`. Column width: `.th-upload` = 120px.

## V1 Backups

`server.v1.js`, `public/index.v1.html`, `templates/poster.v1.html` — the original Google Sheets/Drive version. Run with `npm run start:v1`.

## Future Work (paused)

**V2 concept:** Externalize template positions into `template-config.json` editable via a UI gear button. Resume when a new template needs a different layout.
