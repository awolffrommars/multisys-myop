---
title: Make Your Own Poster
emoji: 🖼
colorFrom: yellow
colorTo: red
sdk: docker
pinned: false
app_port: 7860
---

# Make Your Own Poster

Generate Multisys announcement posters — New Employee, Birthday, and Work Anniversary — from a CSV file or manual entry. Photos are matched by filename, posters are rendered via Puppeteer, and results are downloadable as individual PNGs or a ZIP.

## Features

- Three poster templates: **New Employee**, **Birthday**, and **Work Anniversary**
- Two input modes: **Batch Upload** (CSV + bulk PNGs) or **Manual Entry** (one employee at a time)
- Live photo matching with filename-based name normalization
- Client-side CSV format detection and validation
- Server-Sent Events for real-time generation progress
- Edit any poster after generation and re-render individually
- ZIP download with standardized filenames (`LastName, FirstName-Template-MMDDYY.png`)

## Quick Start

```bash
npm install
npm start
# Open http://localhost:3000
```

Puppeteer downloads its own Chromium on `npm install`. If already cached at `~/.cache/puppeteer`:

```bash
PUPPETEER_SKIP_DOWNLOAD=true npm install
```

## Usage

### Step 1 — Select Template

Choose **Birthday Poster** or **New Employee Poster**. The Work Anniversary template is reserved for future use. Switching templates clears all uploaded files and entries.

### Step 2 — Add Employees

**Batch Upload tab:**
1. Upload a CSV matching the template format (see below)
2. Upload employee photos as PNGs — filenames must match employee names
3. Mismatched or duplicate photos are flagged in the list

**Manual Entry tab:**
1. Fill in employee fields and optionally attach a photo
2. Click **+ Add Employee** — warns if department/division is empty, photo filename doesn't match, or name is a duplicate
3. Click ✎ to edit a listed employee (current form auto-saves before loading)
4. Repeat for all employees, then click **Upload & Preview**

### Step 3 — Preview & Generate

Review the employee table. Upload missing photos inline. Click **Generate Posters**.

### Step 4 — Gallery & Download

View rendered posters in a lightbox (← → to navigate). Edit any poster to fix details or swap a photo. Download all as a ZIP or grab individual PNGs.

## CSV Formats

**New Employee:**
```
Full Name, Position, Department
```

**Birthday:**
```
Birthday, Full Name, Position, Department, Division
```

Birthday date format: `Month DD` (e.g. `May 01`). Month spelling is auto-corrected and years are stripped automatically — `May 01, 1990`, `1990-08-25`, and `08/25/1990` all work.

## Photo Matching

Photos are matched by normalizing the employee name and the photo filename (lowercase, strip commas/separators, sort tokens). `"Goting, King Garrett.png"` matches `"King Garrett Goting"`. Unmatched photos are flagged red; duplicates are flagged purple.

## Project Structure

```
├── server.js                  # Express server — all API routes
├── services/
│   ├── poster.js              # Puppeteer poster renderer
│   ├── csv.js                 # CSV parser + month correction
│   └── matcher.js             # Photo filename normalizer
├── templates/
│   ├── poster.html            # New Employee poster (1920×1081)
│   ├── poster-birthday.html   # Birthday poster (1920×1081)
│   ├── New Employee Poster_Template.png
│   └── Birthday Poster_Template.png
└── public/
    └── index.html             # Web UI
```

## Design System

Dark UI: canvas `#090909`, surfaces `#141414` / `#1c1c1c`. White pill CTAs (`border-radius: 100px`). Inter typography with OpenType features. Accent blue `#0099ff` for links and focus rings only.
