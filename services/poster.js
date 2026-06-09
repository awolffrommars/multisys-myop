const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return browser;
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

async function renderPoster(data, photoData, templateBase64, config, templateKey = 'new-employee') {
  try {
    const htmlFile = templateKey === 'birthday'    ? 'poster-birthday.html'
                   : templateKey === 'anniversary' ? 'poster-anniversary.html'
                   : 'poster.html';
    const templatePath = path.join(__dirname, '../templates', htmlFile);
    let html = fs.readFileSync(templatePath, 'utf8');

    const templateSrc = templateBase64
      ? `data:image/png;base64,${templateBase64}`
      : '';

    let photoSrc = '';
    if (photoData && photoData.base64) {
      const mimeType = `image/${photoData.format || 'png'}`;
      photoSrc = `data:${mimeType};base64,${photoData.base64}`;
    }

    html = html
      .replaceAll('{{TEMPLATE_BASE64}}', templateSrc)
      .replaceAll('{{PHOTO_BASE64}}', photoSrc)
      .replaceAll('{{FULL_NAME}}', data.fullName || '')
      .replaceAll('{{POSITION}}', data.position || '')
      .replaceAll('{{DEPARTMENT}}', data.department || '')
      .replaceAll('{{DIVISION}}', data.division || '')
      .replaceAll('{{BIRTHDAY_DATE}}', data.birthdayDate || '')
      .replaceAll('{{ANNIVERSARY_YEARS}}', data.anniversaryYears || '')
      .replaceAll('{{DATE_HIRED}}', data.dateHired || '');

    // Anniversary: split full name into first name (all but last word) and last name (last word)
    if (templateKey === 'anniversary') {
      const parts = (data.fullName || '').trim().split(/\s+/);
      if (parts.length < 2) {
        console.warn(`[poster] Anniversary name has only one word: "${data.fullName}" — last-name overlay will be blank`);
      }
      const lastName  = parts.length > 1 ? parts[parts.length - 1] : '';
      const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : (data.fullName || '');
      html = html.replaceAll('{{FIRST_NAME}}', firstName).replaceAll('{{LAST_NAME}}', lastName);
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

    await page.setViewport({ width: 1920, height: 1081 });
    // New-employee: reduce font size by 50% when name exceeds 24 characters
    if (templateKey === 'new-employee' && (data.fullName || '').length > 24) {
      console.log(`[poster] Long name (${(data.fullName||'').length} chars) — reducing font to 28px: "${data.fullName}"`);
      html = html.replace('</head>', '<style>.employee-name { font-size: 29px !important; text-align: center !important; }</style></head>');
    }

    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.evaluate(async () => { await document.fonts.ready; });

    const screenshot = await page.screenshot({ type: 'png', fullPage: false });

    await page.close();
    return screenshot;
  } catch (error) {
    throw new Error(`Failed to render poster: ${error.message}`);
  }
}

module.exports = { renderPoster, closeBrowser };
