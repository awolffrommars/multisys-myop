const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const LAUNCH_OPTIONS = {
  headless: 'new',
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
};

function formatPhoneDisplay(num) {
  // Strip everything but digits so dashes/spaces in the source (CSV or edit modal) don't break formatting
  let digits = num.replace(/\D/g, '').replace(/^00/, '');
  if (digits.startsWith('63')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) return '+63 ' + digits.slice(0,3) + ' ' + digits.slice(3,6) + ' ' + digits.slice(6);
  if (digits.length === 9)  return '+63 ' + digits.slice(0,2) + ' ' + digits.slice(2,5) + ' ' + digits.slice(5);
  return num;
}

// Escape user data before HTML interpolation — CSV cells must never execute
// as markup/script inside the render browser
function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizePhone(raw) {
  if (!raw) return null;
  // Accept any punctuation/spacing and any common PH prefix: 09…, 639…, +63 9…, 0063 9…, bare 9…
  const digits = raw.replace(/\D/g, '').replace(/^00/, '');
  if (!digits) return null;
  if (/^09\d{9}$/.test(digits)) return 'tel:+63' + digits.slice(1);
  if (/^639\d{9}$/.test(digits)) return 'tel:+' + digits;
  if (/^9\d{9}$/.test(digits)) return 'tel:+63' + digits;
  if (raw.trim().startsWith('+') && digits.length >= 10) return 'tel:+' + digits;
  return 'tel:' + digits;
}

// ── Static asset cache ────────────────────────────────────────────────────────
// Load once at module init; avoids redundant disk reads on every render call.

const HTML_FILES = {
  'birthday':          'poster-birthday.html',
  'anniversary':       'poster-anniversary.html',
  'calling-card':      'poster-calling-card.html',
  'calling-card-back': 'poster-calling-card-back.html',
  'multisys-id':       'poster-multisys-id.html',
  'multisys-id-back':  'poster-multisys-id-back.html',
  'new-employee':      'poster.html',
};

const htmlCache = {};
for (const [key, file] of Object.entries(HTML_FILES)) {
  const p = path.join(__dirname, '../templates', file);
  if (fs.existsSync(p)) {
    htmlCache[key] = fs.readFileSync(p, 'utf8');
  } else {
    console.warn(`[poster] HTML template not found: ${file}`);
    htmlCache[key] = '';
  }
}

function loadIcon(file) {
  try { return 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../public', file)).toString('base64'); }
  catch (e) { console.warn(`[poster] ${file} not found`); return ''; }
}

const _homeIcon    = loadIcon('home-icon.png');
const _contactIcon = loadIcon('contact-icon.png');
const _personIcon  = loadIcon('person-icon.png');
const _barsLogo    = loadIcon('msys-bars-logo.png');

// ─────────────────────────────────────────────────────────────────────────────

// Memoize the launch PROMISE, not the resolved browser. The old
// `if (!browser) browser = await puppeteer.launch()` let two concurrent renders
// (CONCURRENCY=2 runs Promise.all) both pass the null check before either awaited:
// two Chromiums launched, the second assignment orphaned the first, and it survived
// as a ~80 MB zombie reparented to init. Holding the promise means the second caller
// awaits the first launch instead of starting its own.
let browserPromise = null;
let activeRenders = 0; // renders currently in flight across ALL requests

async function getBrowser() {
  if (!browserPromise) {
    const launching = puppeteer.launch(LAUNCH_OPTIONS)
      .then(b => {
        // A crashed browser must not stay memoized as a dead handle — drop it so
        // the next render launches a fresh one instead of failing forever
        b.on('disconnected', () => { if (browserPromise === launching) browserPromise = null; });
        return b;
      })
      .catch(err => {
        if (browserPromise === launching) browserPromise = null; // let the next call retry
        throw err;
      });
    browserPromise = launching;
  }
  return browserPromise;
}

async function closeBrowser() {
  // Never close while another request's render is mid-flight — two concurrent
  // batches share this singleton, and closing under one kills the other
  // ("Protocol error: Target closed"). The last batch to finish closes it.
  if (!browserPromise || activeRenders > 0) return;
  const closing = browserPromise;
  browserPromise = null; // clear first, so a render starting now launches its own
  const b = await closing.catch(() => null);
  if (b) await b.close().catch(() => {});
}

async function renderPoster(data, photoData, templateBase64, config, templateKey = 'new-employee', signatureData = null) {
  try {
    const _htmlFile = HTML_FILES[templateKey] || HTML_FILES['new-employee'];
    let html = fs.readFileSync(path.join(__dirname, '../templates', _htmlFile), 'utf8');

    const templateSrc = templateBase64
      ? `data:image/png;base64,${templateBase64}`
      : '';

    let photoSrc = '';
    if (photoData && photoData.base64) {
      const mimeType = `image/${photoData.format || 'png'}`;
      photoSrc = `data:${mimeType};base64,${photoData.base64}`;
    }

    let signatureSrc = '';
    if (signatureData && signatureData.base64) {
      const mimeType = `image/${signatureData.format || 'png'}`;
      signatureSrc = `data:${mimeType};base64,${signatureData.base64}`;
    }

    const homeIconDataUrl    = templateKey === 'multisys-id-back' ? _homeIcon    : '';
    const contactIconDataUrl = templateKey === 'multisys-id-back' ? _contactIcon : '';
    const personIconDataUrl  = templateKey === 'multisys-id-back' ? _personIcon  : '';
    const logoDataUrl        = templateKey === 'calling-card'      ? _barsLogo   : '';

    // Calling card: generate QR code from first mobile number
    let qrDataUrl = '';
    if (templateKey === 'calling-card' && data.mobile) {
      const firstMobile = data.mobile.split(/\s*\/\s*/)[0].trim();
      const phoneUri = normalizePhone(firstMobile) || ('tel:' + firstMobile);
      qrDataUrl = await QRCode.toDataURL(phoneUri, {
        errorCorrectionLevel: 'H',
        width: 480,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      });
    }

    // Escape BEFORE inserting the <br> so the break survives escaping
    let positionValue = escapeHtml(data.position || '');
    let anniversaryPositionTwoLines = false;
    if (templateKey === 'anniversary' && (data.position || '').length > 30) {
      const raw = data.position;
      const breakIdx = raw.lastIndexOf(' ', 30);
      if (breakIdx > 0) {
        positionValue = escapeHtml(raw.slice(0, breakIdx)) + '<br>' + escapeHtml(raw.slice(breakIdx + 1));
        anniversaryPositionTwoLines = true;
      }
    }

    // All replacements use function form — a plain string replacement makes
    // `$&`, `$'`, `$$` etc. in the data act as regex substitution patterns,
    // re-injecting tokens or duplicating template HTML.
    // Text fields are HTML-escaped; data-URL/HTML fields (base64, phone lines) are trusted.
    const sub = (token, value) => { html = html.replaceAll(token, () => value); };
    sub('{{TEMPLATE_BASE64}}', templateSrc);
    sub('{{PHOTO_BASE64}}', photoSrc);
    sub('{{FULL_NAME}}', escapeHtml(data.fullName || ''));
    sub('{{POSITION}}', positionValue);
    sub('{{DEPARTMENT}}', escapeHtml(data.department || ''));
    sub('{{DIVISION}}', escapeHtml(data.division || ''));
    sub('{{BIRTHDAY_DATE}}', escapeHtml(data.birthdayDate || ''));
    sub('{{ANNIVERSARY_YEARS}}', escapeHtml(data.anniversaryYears || ''));
    // "1 YEAR", not "1 YEARS". Anything non-numeric or absent keeps the plural,
    // which is what the hardcoded template text used to always produce.
    const _yrs = parseInt(String(data.anniversaryYears ?? '').trim(), 10);
    sub('{{YEARS_WORD}}', _yrs === 1 ? 'YEAR' : 'YEARS');
    sub('{{DATE_HIRED}}', escapeHtml(data.dateHired || ''));
    sub('{{EMAIL}}', escapeHtml(data.email || ''));
    sub('{{MOBILE}}', escapeHtml(data.mobile || ''));
    sub('{{QR_BASE64}}', qrDataUrl);
    sub('{{LOGO_BASE64}}', logoDataUrl);
    sub('{{EMPLOYEE_NUMBER}}', escapeHtml(data.employeeNumber || ''));
    sub('{{ADDRESS}}', escapeHtml(data.address || ''));
    sub('{{PHONE_NUMBER}}', escapeHtml(data.phoneNumber || ''));
    sub('{{PHILHEALTH}}', escapeHtml(data.philhealth || ''));
    sub('{{SSS}}', escapeHtml(data.sss || ''));
    sub('{{TIN}}', escapeHtml(data.tin || ''));
    sub('{{HDMF}}', escapeHtml(data.hdmf || ''));
    sub('{{CONTACT_NAME}}', escapeHtml(data.contactName || ''));
    sub('{{CONTACT_ADDRESS}}', escapeHtml(data.contactAddress || ''));
    sub('{{CONTACT_NUMBER}}', escapeHtml(data.contactNumber || ''));
    sub('{{SIGNATURE_BASE64}}', signatureSrc);
    sub('{{HOME_ICON_BASE64}}', homeIconDataUrl);
    sub('{{CONTACT_ICON_BASE64}}', contactIconDataUrl);
    sub('{{PERSON_ICON_BASE64}}', personIconDataUrl);

    // Calling card: build phone lines HTML and adjust font for long names / multiple numbers
    if (templateKey === 'calling-card') {
      // formatPhoneDisplay normalizes all prefixes itself — pre-prepending +63
      // here double-prefixed numbers already in 63… form
      const mobileNumbers = (data.mobile || '').split(/\s*\/\s*/).map(n => n.trim()).filter(Boolean)
        .map(formatPhoneDisplay);
      const phoneLines = `<div class="phone">${escapeHtml(mobileNumbers.join(' / '))}</div>`;
      html = html.replaceAll('{{PHONE_LINES}}', () => phoneLines);
      if (mobileNumbers.length >= 3) {
        html = html.replace('</head>', '<style>.phone { font-size: 28px !important; }</style></head>');
      }
      // Name/position sizing handled by the measured AUTOFIT pass after page load
    }

    if (!signatureSrc && templateKey === 'multisys-id') {
      html = html.replace('</head>', '<style>#sigOverlay{display:none}</style></head>');
    }

    // Anniversary / Multisys ID front: split full name into first name (all but last word) and last name (last word)
    // For regenerate calls, data.firstName / data.lastName are passed directly to preserve multi-word last names.
    if (templateKey === 'anniversary' || templateKey === 'multisys-id') {
      let firstName, lastName;
      if (data.firstName !== undefined && data.firstName !== '') {
        firstName = data.firstName;
        lastName  = data.lastName || '';
      } else {
        const parts = (data.fullName || '').trim().split(/\s+/);
        if (parts.length < 2) {
          console.warn(`[poster] ${templateKey} name has only one word: "${data.fullName}" — last-name overlay will be blank`);
        }
        lastName  = parts.length > 1 ? parts[parts.length - 1] : '';
        firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : (data.fullName || '');
      }
      html = html.replaceAll('{{FIRST_NAME}}', () => escapeHtml(firstName)).replaceAll('{{LAST_NAME}}', () => escapeHtml(lastName));
      const noDivision = !data.division;
      const divTop  = anniversaryPositionTwoLines ? 775 : 733;
      const deptTop = anniversaryPositionTwoLines ? 855 : 813;
      const overrides = [];
      if (anniversaryPositionTwoLines) overrides.push(`.employee-division{top:${divTop}px}`);
      if (noDivision) overrides.push(`.employee-department{top:${divTop}px}`);
      else if (anniversaryPositionTwoLines) overrides.push(`.employee-department{top:${deptTop}px}`);
      if (overrides.length) html = html.replace('</head>', `<style>${overrides.join('')}</style></head>`);
    }

    // Inject config overrides as CSS custom properties
    if (config) {
      const css = `<style>:root {
        --photo-left: ${config.photoLeft}px;
        --photo-top: ${config.photoTop}px;
        --photo-width: ${config.photoWidth}px;
        --photo-height: ${config.photoHeight}px;
        --text-left: ${config.textLeft}px;
        --text-width: ${config.textWidth}px;
        --name-top: ${config.nameTop}px;
        --pos-top: ${config.posTop}px;
        --dept-top: ${config.deptTop}px;
      }
      .employee-name { font-size: ${config.nameFontSize}px !important; }
      .employee-position { font-size: ${config.posFontSize}px !important; }
      .employee-department { font-size: ${config.deptFontSize}px !important; }
      </style>`;
      html = html.replace('</head>', css + '</head>');
    }

    const browserInstance = await getBrowser();
    activeRenders++;
    const page = await browserInstance.newPage();
    try {

    const VIEWPORTS = {
      'calling-card':      { width: 1920, height: 1152 },
      'calling-card-back': { width: 1920, height: 1152 },
      'multisys-id':       { width: 1920, height: 3050 },
      'multisys-id-back':  { width: 1920, height: 3050 },
    };
    const vp = VIEWPORTS[templateKey] || { width: 1920, height: 1081 };
    await page.setViewport(vp);
    // New-employee: name auto-fit happens after page load (measured, not char-count based)

    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(async () => { await document.fonts.ready; });
    // Wait for every image to be DECODED, not merely loaded. `load` fires once the
    // bytes have arrived, but a 10 MB 2500x4300 portrait plus the 1920x3050 template
    // can still be mid-decode when the screenshot fires — which yields a half-painted
    // card (logo only, no photo, no red banner). img.decode() resolves when the
    // bitmap is ready to paint.
    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).map(async (img) => {
        if (!img.complete) await new Promise(res => { img.onload = res; img.onerror = res; });
        if (img.decode) { try { await img.decode(); } catch {} }
      }));
    });

    // Centre the SUBJECT, not the image (anniversary polaroid).
    // `object-fit: cover` centres the image BOX; a transparent cut-out whose person
    // sits off-centre inside their own PNG therefore renders off-centre in the
    // polaroid — and with the 1.2x zoom the far shoulder gets cropped at the frame
    // edge. Measure the alpha bounding box in the render browser and translate by the
    // difference. No-op for opaque photos (alpha spans the full width), for a fully
    // transparent file, or if the canvas read throws.
    if (templateKey === 'anniversary') {
      await page.evaluate(() => {
        const box = document.querySelector('.photo-overlay');
        const img = box && box.querySelector('img');
        if (!img || !img.naturalWidth) return;

        let frac;
        try {
          const MAX = 320;                       // downsample — we only need geometry
          const sc0 = Math.min(1, MAX / img.naturalWidth);
          const c = document.createElement('canvas');
          c.width  = Math.max(1, Math.round(img.naturalWidth  * sc0));
          c.height = Math.max(1, Math.round(img.naturalHeight * sc0));
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, c.width, c.height);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;

          // per-row opaque extents
          const rows = [];
          for (let y = 0; y < c.height; y++) {
            let minX = c.width, maxX = -1, count = 0, sumX = 0;
            const base = y * c.width;
            for (let x = 0; x < c.width; x++) {
              if (d[(base + x) * 4 + 3] > 24) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                count++; sumX += x;
              }
            }
            if (maxX >= 0) rows.push({ y, minX, maxX, w: maxX - minX + 1, count, sumX });
          }
          if (!rows.length) return;                               // nothing opaque

          const top = rows[0].y, bot = rows[rows.length - 1].y;
          const subjH = bot - top + 1;
          const gMinX = Math.min.apply(null, rows.map(r => r.minX));
          const gMaxX = Math.max.apply(null, rows.map(r => r.maxX));

          // Is this actually an opaque photo? Measure the TRANSPARENT FRACTION, not
          // whether the silhouette touches the side edges — a tightly cropped cut-out
          // touches both edges too, and testing for that skipped 13 of 14 real
          // portraits (23-47% transparent), which is why centring appeared to do
          // nothing on live photos.
          let clear = 0, total = 0;
          for (let y = 0; y < c.height; y += 2) {
            const base = y * c.width;
            for (let x = 0; x < c.width; x += 2) { total++; if (d[(base + x) * 4 + 3] <= 24) clear++; }
          }
          if (!total || clear / total < 0.02) return;              // opaque photo — nothing to centre

          // Centre on the HEAD, not the silhouette: crossed arms, an outstretched
          // elbow or hair falling to one side drag a whole-body centroid sideways
          // and push the face off-centre. Find the shoulder line as the first row
          // meaningfully wider than the crown, and use only the rows above it.
          const crown = rows.filter(r => r.y <= top + Math.max(2, subjH * 0.08))
                            .map(r => r.w).sort((a, b) => a - b);
          const headW = crown.length ? crown[Math.floor(crown.length / 2)] : 0;
          let shoulderY = null;
          if (headW > 0) {
            for (let i = 0; i < rows.length; i++) {
              const r = rows[i];
              if (r.y < top + subjH * 0.05) continue;              // skip the crown itself
              if (r.w > headW * 1.5) { shoulderY = r.y; break; }
            }
          }
          const bandEnd = Math.min(
            shoulderY === null ? top + subjH * 0.25 : shoulderY,
            top + subjH * 0.35);                                   // never more than a third
          const band = rows.filter(r => r.y >= top && r.y <= bandEnd);

          // Prefer the FACE itself. Silhouette mass — even restricted to the head
          // band — is dragged sideways by long hair falling to one side, which
          // over-corrects and pushes the face past centre the other way. Skin tone
          // finds the face directly. Search the upper 45% of the subject so hands
          // and forearms can't contribute.
          let cx = null;
          const faceLimit = top + subjH * 0.45;
          const sx = [];
          for (let y = top; y <= Math.min(bot, faceLimit); y++) {
            const base = y * c.width;
            for (let x = 0; x < c.width; x++) {
              const i = (base + x) * 4;
              if (d[i + 3] <= 24) continue;                        // transparent
              const r = d[i], g = d[i + 1], b = d[i + 2];
              const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
              if (r > 95 && g > 40 && b > 20 && (mx - mn) > 15 &&
                  Math.abs(r - g) > 15 && r > g && r > b &&
                  !(r > 235 && g > 235 && b > 235)) {
                sx.push(x);
              }
            }
          }
          if (sx.length >= 40) {
            sx.sort((a, b2) => a - b2);
            // trim the tails: warm highlights on hair/clothing are not the face
            const lo = sx[Math.floor(sx.length * 0.05)];
            const hi = sx[Math.floor(sx.length * 0.95)];
            const core = sx.filter(v => v >= lo && v <= hi);
            cx = core.reduce((a, v) => a + v, 0) / core.length;
          }

          // Fallbacks when skin detection finds too little (unusual lighting, very
          // dark skin tones, a masked face): head band centroid, then silhouette.
          if (cx === null) {
            if (band.length) {
              const mass = band.reduce((a, r) => a + r.count, 0);
              cx = mass > 0 ? band.reduce((a, r) => a + r.sumX, 0) / mass
                            : (gMinX + gMaxX) / 2;
            } else {
              cx = (gMinX + gMaxX) / 2;
            }
          }
          frac = cx / c.width;                                     // face centre, 0..1 of the source
        } catch (e) { return; }

        // object-fit: cover scales the source by k and centres it in the box
        const bw = box.clientWidth, bh = box.clientHeight;
        const k = Math.max(bw / img.naturalWidth, bh / img.naturalHeight);
        const renderedW = img.naturalWidth * k;

        // keep whatever scale the template defines rather than hardcoding 1.2
        let sc = 1;
        try {
          const m = new DOMMatrixReadOnly(getComputedStyle(img).transform);
          if (m && m.a) sc = m.a;
        } catch (e) {}

        // translateX sits INSIDE scale(), so its visual effect is sc x the value
        let t = renderedW * (0.5 - frac);

        // How far we may shift before the empty placeholder shows at an edge:
        //   |t| <= renderedW/2 - bw/(2*sc)
        const room = (z) => Math.max(0, renderedW / 2 - bw / (2 * z));

        // A strongly off-centre subject needs more overscan than the template's zoom
        // provides. Rather than give up and leave the face off-centre, zoom in just
        // enough to buy the headroom — solving the above for sc. `transform-origin`
        // is `center top`, so the extra zoom crops the waist, never the head.
        if (Math.abs(t) > room(sc)) {
          const denom = renderedW - 2 * Math.abs(t);
          const need = denom > 0 ? bw / denom : Infinity;
          sc = Math.min(Math.max(sc, need), sc * 1.6, 2.2);   // bounded: no runaway zoom
        }
        t = Math.max(-room(sc), Math.min(room(sc), t));
        img.style.setProperty('transform', `scale(${sc.toFixed(4)}) translateX(${t.toFixed(1)}px)`, 'important');
      });
    }

    // Pre-downscale big portraits with real filtering.
    // Chromium POINT-SAMPLES a very large image when compositing it into a much
    // smaller box: a 2615x5489 portrait in the 529x607 polaroid came out matching
    // NEAREST-neighbour exactly (noise 14.1 vs 5.7 for a filtered downscale, and
    // noisier than the 8.4 of the source itself), because sensor noise is sampled
    // instead of averaged. Resample on a canvas by successive halving — each step
    // is <=2x, which filters cleanly — down to the exact size the element renders
    // at, so the browser then draws ~1:1 and resamples nothing.
    //
    // Runs AFTER the centring pass so the final transform scale is known, and the
    // centring measurement still gets to read the full-resolution pixels.
    await page.evaluate(async () => {
      const step = (src, w, h) => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(src, 0, 0, w, h);
        return c;
      };

      for (const img of Array.from(document.images)) {
        if (!img.naturalWidth || !img.naturalHeight) continue;
        const bw = img.clientWidth, bh = img.clientHeight;
        if (!bw || !bh) continue;

        let sc = 1;
        try {
          const m = new DOMMatrixReadOnly(getComputedStyle(img).transform);
          if (m && m.a) sc = Math.abs(m.a);
        } catch (e) {}

        // object-fit: cover renders the source at naturalSize * k, then the transform
        const k = Math.max(bw / img.naturalWidth, bh / img.naturalHeight);
        const targetW = Math.max(1, Math.ceil(img.naturalWidth  * k * sc));
        const targetH = Math.max(1, Math.ceil(img.naturalHeight * k * sc));

        // Only worth it when the source is meaningfully larger than it is drawn.
        // The 1920px template background is already 1:1 and is skipped here.
        if (img.naturalWidth < targetW * 1.3 && img.naturalHeight < targetH * 1.3) continue;

        try {
          let cur = img, cw = img.naturalWidth, ch = img.naturalHeight;
          const need = () => Math.max(targetW / cw, targetH / ch);
          while (need() <= 0.5) {                 // halve while more than 2x too big
            cw = Math.max(1, Math.round(cw / 2));
            ch = Math.max(1, Math.round(ch / 2));
            cur = step(cur, cw, ch);
          }
          const f = need();
          if (f < 1) {                            // final sub-2x step onto the target
            cw = Math.max(1, Math.round(cw * f));
            ch = Math.max(1, Math.round(ch * f));
            cur = step(cur, cw, ch);
          }
          if (cur === img) continue;              // nothing to do
          const url = cur.toDataURL('image/png');
          await new Promise((res) => {
            img.onload = res; img.onerror = res;
            img.src = url;
          });
          if (img.decode) { try { await img.decode(); } catch (e) {} }
        } catch (e) { /* tainted canvas / OOM — leave the original in place */ }
      }
    });

    // Auto-fit text overlays: measure the real rendered text width and shrink
    // the font 1px at a time until it fits its column, so long names stay
    // centered/contained instead of overflowing. `max` is an explicit pixel
    // limit for overlays whose element is wider than the safe text area;
    // without it the parent column width is used.
    // `lines: 2` = the element may wrap to 2 lines (template has no nowrap);
    // shrink only when it exceeds 2 lines or a single word overflows the column.
    // Entries without `lines` are single-line nowrap overlays measured via Range.
    // Entries sharing a `group` are equalized after fitting — all members take
    // the smallest fitted size (first/last name must always match).
    // `singleLineMin`: prefer a single line — shrink down to this size first;
    // only fall back to wrapping (then shrinking) if it still doesn't fit.
    const AUTOFIT = {
      'new-employee': [{ sel: '.employee-name', lines: 2, singleLineMin: 32 }],
      'birthday':     [{ sel: '.employee-name', lines: 2 }],
      'anniversary':  [{ sel: '.employee-firstname', max: 970, group: 'name' }, { sel: '.employee-lastname', max: 970, group: 'name' }],
      'calling-card': [{ sel: '.name-overlay', max: 1400 }, { sel: '.position-overlay', max: 1400 }],
      'multisys-id':  [{ sel: '.first-name', max: 1700, group: 'name' }, { sel: '.last-name', max: 1700, group: 'name' }, { sel: '.position-text', max: 1700 }],
    };
    if (AUTOFIT[templateKey]) {
      await page.evaluate((fits, tKey) => {
        const textWidth = (el) => {
          const r = document.createRange();
          r.selectNodeContents(el);
          return r.getBoundingClientRect().width;
        };
        const lineCount = (el) => {
          const lh = parseFloat(getComputedStyle(el).lineHeight);
          return Math.max(1, Math.round(el.getBoundingClientRect().height / lh));
        };
        const fitted = [];
        for (const { sel, max, lines, group, singleLineMin } of fits) {
          const el = document.querySelector(sel);
          if (!el || !el.textContent.trim()) continue;
          const limit = max || el.parentElement.clientWidth;
          let size = parseFloat(getComputedStyle(el).fontSize);
          if (singleLineMin) {
            // Try to keep it on one line by shrinking down to singleLineMin
            const orig = size;
            el.style.whiteSpace = 'nowrap';
            while (textWidth(el) > limit && size > singleLineMin) {
              size -= 1;
              el.style.setProperty('font-size', size + 'px', 'important');
            }
            if (textWidth(el) <= limit) { fitted.push({ el, size, group }); continue; }
            // Still too wide at the minimum — revert and let it wrap instead
            el.style.whiteSpace = '';
            size = orig;
            el.style.setProperty('font-size', size + 'px', 'important');
          }
          const overflows = lines > 1
            ? () => el.scrollWidth > limit || lineCount(el) > lines
            : () => textWidth(el) > limit;
          while (overflows() && size > 16) {
            size -= 1;
            el.style.setProperty('font-size', size + 'px', 'important');
          }
          fitted.push({ el, size, group });
        }
        // Equalize grouped elements to the smallest fitted size
        const groups = {};
        for (const f of fitted) if (f.group) (groups[f.group] = groups[f.group] || []).push(f);
        for (const list of Object.values(groups)) {
          const min = Math.min(...list.map(f => f.size));
          for (const f of list) f.el.style.setProperty('font-size', min + 'px', 'important');
        }
        // Birthday: when the name wraps, lift the whole text block by HALF the
        // extra line height — splits the crowding between the "Happy Birthday"
        // art above and #MomentsAtMultisys below
        if (tKey === 'birthday') {
          const name = document.querySelector('.employee-name');
          const block = document.querySelector('.text-block');
          if (name && block) {
            const lh = parseFloat(getComputedStyle(name).lineHeight);
            const extra = Math.max(0, name.getBoundingClientRect().height - lh);
            if (extra > 0) block.style.top = (block.getBoundingClientRect().top - extra / 2) + 'px';
          }
        }
      }, AUTOFIT[templateKey], templateKey);
    }

    // Two frames so the decoded bitmaps are actually composited before capture
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

    const screenshot = await page.screenshot({ type: 'png', fullPage: false });

    return screenshot;
    } finally {
      // Close the page even on error — leaked pages accumulate in the
      // long-lived browser (esp. from failed /regenerate calls)
      activeRenders--;
      await page.close().catch(() => {});
    }
  } catch (error) {
    throw new Error(`Failed to render poster: ${error.message}`);
  }
}

async function renderPdf(frontBuffer, backBuffer, opts = {}) {
  const pageW = opts.pageWidth  || '508mm';
  const pageH = opts.pageHeight || '807mm';

  const frontB64 = frontBuffer.toString('base64');
  const backB64  = backBuffer ? backBuffer.toString('base64') : null;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    @page { margin: 0; size: ${pageW} ${pageH}; }
    * { margin: 0; padding: 0; }
    body { background: #fff; }
    img { width: ${pageW}; height: ${pageH}; display: block; page-break-after: always; }
  </style></head><body>
    <img src="data:image/png;base64,${frontB64}" />
    ${backB64 ? `<img src="data:image/png;base64,${backB64}" />` : ''}
  </body></html>`;

  const pdfBrowser = await puppeteer.launch(LAUNCH_OPTIONS);
  try {
    const page = await pdfBrowser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const pdfBuffer = await page.pdf({
      width: pageW,
      height: pageH,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    await page.close();
    return pdfBuffer;
  } finally {
    await pdfBrowser.close();
  }
}

// Batch variant of renderPdf: one browser for the whole set instead of one per
// PDF. Used by the ZIP download, where a launch-per-employee would dominate the
// request time. `pairs` = [{ front: Buffer, back: Buffer|null }].
async function renderPdfBatch(pairs, opts = {}) {
  const pageW = opts.pageWidth  || '508mm';
  const pageH = opts.pageHeight || '807mm';
  if (!pairs.length) return [];

  const pdfBrowser = await puppeteer.launch(LAUNCH_OPTIONS);
  try {
    const page = await pdfBrowser.newPage();
    const out = [];
    for (const { front, back } of pairs) {
      const backB64 = back ? back.toString('base64') : null;
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
        @page { margin: 0; size: ${pageW} ${pageH}; }
        * { margin: 0; padding: 0; }
        body { background: #fff; }
        img { width: ${pageW}; height: ${pageH}; display: block; page-break-after: always; }
      </style></head><body>
        <img src="data:image/png;base64,${front.toString('base64')}" />
        ${backB64 ? `<img src="data:image/png;base64,${backB64}" />` : ''}
      </body></html>`;
      await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
      // Same decode guard as renderPoster — a mid-decode image prints blank
      await page.evaluate(async () => {
        await Promise.all(Array.from(document.images).map(async (img) => {
          if (!img.complete) await new Promise(res => { img.onload = res; img.onerror = res; });
          if (img.decode) { try { await img.decode(); } catch {} }
        }));
      });
      out.push(await page.pdf({
        width: pageW,
        height: pageH,
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      }));
    }
    await page.close();
    return out;
  } finally {
    await pdfBrowser.close();
  }
}

module.exports = { renderPoster, closeBrowser, renderPdf, renderPdfBatch, normalizePhone };
