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
  const digits = num.replace(/^\+63/, '');
  if (digits.length === 10) return '+63' + digits.slice(0,3) + '-' + digits.slice(3,6) + '-' + digits.slice(6);
  if (digits.length === 9)  return '+63' + digits.slice(0,2) + '-' + digits.slice(2,5) + '-' + digits.slice(5);
  return num;
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (/^09\d{9}$/.test(digits)) return 'tel:+63' + digits.slice(1);
  if (/^639\d{9}$/.test(digits)) return 'tel:+' + digits;
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

let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch(LAUNCH_OPTIONS);
  }
  return browser;
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

async function renderPoster(data, photoData, templateBase64, config, templateKey = 'new-employee', signatureData = null) {
  try {
    let html = htmlCache[templateKey] || htmlCache['new-employee'];

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

    let positionValue = data.position || '';
    let anniversaryPositionTwoLines = false;
    if (templateKey === 'anniversary' && positionValue.length > 30) {
      const breakIdx = positionValue.lastIndexOf(' ', 30);
      if (breakIdx > 0) {
        positionValue = positionValue.slice(0, breakIdx) + '<br>' + positionValue.slice(breakIdx + 1);
        anniversaryPositionTwoLines = true;
      }
    }

    html = html
      .replaceAll('{{TEMPLATE_BASE64}}', templateSrc)
      .replaceAll('{{PHOTO_BASE64}}', photoSrc)
      .replaceAll('{{FULL_NAME}}', data.fullName || '')
      .replaceAll('{{POSITION}}', positionValue)
      .replaceAll('{{DEPARTMENT}}', data.department || '')
      .replaceAll('{{DIVISION}}', data.division || '')
      .replaceAll('{{BIRTHDAY_DATE}}', data.birthdayDate || '')
      .replaceAll('{{ANNIVERSARY_YEARS}}', data.anniversaryYears || '')
      .replaceAll('{{DATE_HIRED}}', data.dateHired || '')
      .replaceAll('{{EMAIL}}', data.email || '')
      .replaceAll('{{MOBILE}}', data.mobile || '')
      .replaceAll('{{QR_BASE64}}', qrDataUrl)
      .replaceAll('{{LOGO_BASE64}}', logoDataUrl)
      .replaceAll('{{EMPLOYEE_NUMBER}}', data.employeeNumber || '')
      .replaceAll('{{ADDRESS}}', data.address || '')
      .replaceAll('{{PHONE_NUMBER}}', data.phoneNumber || '')
      .replaceAll('{{PHILHEALTH}}', data.philhealth || '')
      .replaceAll('{{SSS}}', data.sss || '')
      .replaceAll('{{TIN}}', data.tin || '')
      .replaceAll('{{HDMF}}', data.hdmf || '')
      .replaceAll('{{CONTACT_NAME}}', data.contactName || '')
      .replaceAll('{{CONTACT_ADDRESS}}', data.contactAddress || '')
      .replaceAll('{{CONTACT_NUMBER}}', data.contactNumber || '')
      .replaceAll('{{SIGNATURE_BASE64}}', signatureSrc)
      .replaceAll('{{HOME_ICON_BASE64}}', homeIconDataUrl)
      .replaceAll('{{CONTACT_ICON_BASE64}}', contactIconDataUrl)
      .replaceAll('{{PERSON_ICON_BASE64}}', personIconDataUrl);

    // Calling card: build phone lines HTML and adjust font for long names / multiple numbers
    if (templateKey === 'calling-card') {
      const mobileNumbers = (data.mobile || '').split(/\s*\/\s*/).map(n => n.trim()).filter(Boolean)
        .map(n => n.startsWith('+63') ? n : n.startsWith('0') ? '+63' + n.slice(1) : '+63' + n)
        .map(formatPhoneDisplay);
      const phoneLines = `<div class="phone">${mobileNumbers.join(' / ')}</div>`;
      html = html.replaceAll('{{PHONE_LINES}}', phoneLines);
      if (mobileNumbers.length >= 3) {
        html = html.replace('</head>', '<style>.phone { font-size: 28px !important; }</style></head>');
      }
      const nameLen = (data.fullName || '').length;
      if (nameLen > 26) {
        html = html.replace('</head>', '<style>.name-overlay { font-size: 55px !important; }</style></head>');
      } else if (nameLen > 20) {
        html = html.replace('</head>', '<style>.name-overlay { font-size: 70px !important; }</style></head>');
      }
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
      html = html.replaceAll('{{FIRST_NAME}}', firstName).replaceAll('{{LAST_NAME}}', lastName);
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
    const page = await browserInstance.newPage();

    const VIEWPORTS = {
      'calling-card':      { width: 1920, height: 1152 },
      'calling-card-back': { width: 1920, height: 1152 },
      'multisys-id':       { width: 1920, height: 3050 },
      'multisys-id-back':  { width: 1920, height: 3050 },
    };
    const vp = VIEWPORTS[templateKey] || { width: 1920, height: 1081 };
    await page.setViewport(vp);
    // New-employee: reduce font size by 50% when name exceeds 24 characters
    if (templateKey === 'new-employee' && (data.fullName || '').length > 24) {
      console.log(`[poster] Long name (${(data.fullName||'').length} chars) — reducing font to 28px: "${data.fullName}"`);
      html = html.replace('</head>', '<style>.employee-name { font-size: 29px !important; text-align: center !important; }</style></head>');
    }

    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    await page.evaluate(async () => { await document.fonts.ready; });

    const screenshot = await page.screenshot({ type: 'png', fullPage: false });

    await page.close();
    return screenshot;
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

module.exports = { renderPoster, closeBrowser, renderPdf, normalizePhone };
