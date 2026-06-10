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
- ZIP download with standardized filenames

## Quick Start

### 1. Install Prerequisites

**Node.js** is required. Install it one of these ways:

- **Mac (Homebrew):**
  ```bash
  brew install node
  ```
- **Windows / Mac (manual):** Download the LTS installer from [nodejs.org](https://nodejs.org) and run it.

Verify it's installed:
```bash
node -v
```

### 2. Clone and Run

```bash
cd ~/Desktop
git clone https://github.com/awolffrommars/multisys-myop.git
cd multisys-myop
npm install
npm start
```

> `npm install` downloads Puppeteer's bundled Chromium (~200MB) on first run — this is normal and only happens once.

Then open `http://localhost:3000` in your browser.

### Getting updates

When a new version is pushed to GitHub, pull the latest changes and restart:

```bash
cd ~/Desktop/multisys-myop
git pull origin main
lsof -ti :3000 | xargs kill -9
nohup node server.js > /tmp/poster-server.log 2>&1 &
```

Then refresh `http://localhost:3000`.

### Restarting the server

If you need to restart after making changes:

```bash
lsof -ti :3000 | xargs kill -9
nohup node server.js > /tmp/poster-server.log 2>&1 &
```

## Live Site

The app is also deployed at: https://awolffrommars-multisys-myop.hf.space

## Usage

### Step 1 — Select Template

Choose **Birthday Poster**, **New Employee Poster**, or **Work Anniversary**. Switching templates clears all uploaded files and entries.

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

**Birthday:**
```
Birthday, Full Name, Position, Division, Department
```

Birthday date format: `Month DD` (e.g. `May 01`). Month spelling is auto-corrected and years are stripped automatically — `May 01, 1990`, `1990-08-25`, and `08/25/1990` all work.

**New Employee:**
```
Full Name, Position, Department
```

**Work Anniversary:**
```
Date Hired, Years, Full Name, Position, Division, Department
```

Date Hired follows the same auto-correction as Birthday. Years must be a whole number (e.g. `5`).

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
│   ├── poster-anniversary.html # Work Anniversary poster (1920×1081)
│   ├── New Employee Poster_Template.png
│   ├── Birthday Poster_Template.png
│   └── Work Anniversary_Template.png
└── public/
    └── index.html             # Web UI
```

## Design System

Dark UI: canvas `#090909`, surfaces `#141414` / `#1c1c1c`. White pill CTAs (`border-radius: 100px`). Inter typography with OpenType features. Accent blue `#0099ff` for links and focus rings only.
