const { parse } = require('csv-parse/sync');

const HEADER_KEYWORDS = ['name', 'full name', 'fullname', 'position', 'title', 'department', 'dept', 'division', 'birthday', 'date', 'years', 'email', 'mobile', 'phone', 'employee', 'address', 'sss', 'tin', 'hdmf', 'pag-ibig', 'pagibig'];

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const dp = Array.from({length: a.length + 1}, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
  return dp[a.length][b.length];
}

function correctMonthSpelling(dateStr) {
  if (!dateStr) return dateStr;
  const firstWord = dateStr.split(/[\s\/\-,]+/)[0];
  if (!firstWord || /^\d/.test(firstWord)) return dateStr; // numeric format — skip

  // Exact match (fix capitalisation)
  const exact = MONTHS.find(m => m.toLowerCase() === firstWord.toLowerCase());
  if (exact) return dateStr.replace(firstWord, exact);

  // Unambiguous prefix (≥3 chars): Sep → September
  if (firstWord.length >= 3) {
    const hits = MONTHS.filter(m => m.toLowerCase().startsWith(firstWord.toLowerCase()));
    if (hits.length === 1) return dateStr.replace(firstWord, hits[0]);
  }

  // Fuzzy match via Levenshtein — threshold scales with word length so short
  // non-dates ("TBD", "N/A", "TBA") can't be silently corrected into a month
  if (firstWord.length >= 4) {
    let best = null, bestDist = Infinity;
    for (const m of MONTHS) {
      const d = levenshtein(firstWord, m);
      if (d < bestDist) { bestDist = d; best = m; }
    }
    const maxDist = Math.min(3, Math.floor(firstWord.length / 2));
    if (bestDist <= maxDist) return dateStr.replace(firstWord, best);
  }

  return dateStr; // unrecognisable — leave as-is
}

function stripYear(dateStr) {
  if (!dateStr) return dateStr;

  // ISO-style: YYYY-MM-DD or YYYY/MM/DD → Month DD
  const iso = dateStr.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (iso) {
    const m = MONTHS[parseInt(iso[2], 10) - 1];
    return m ? `${m} ${iso[3].padStart(2, '0')}` : dateStr;
  }

  // Numeric MM/DD/YYYY, MM-DD-YYYY, MM/DD/YY
  const num = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-]\d{2,4}$/);
  if (num) {
    const m = MONTHS[parseInt(num[1], 10) - 1];
    return m ? `${m} ${num[2].padStart(2, '0')}` : dateStr;
  }

  // Text format with trailing 2- or 4-digit year: "May 01 1990", "May 01, 90"
  return dateStr.replace(/,?\s+(\d{4}|\d{2})$/, (match, yr, offset) => {
    // Don't strip a 2-digit day mistaken for a year: only strip 2 digits when
    // something date-like already precedes them (e.g. "May 01 90" has day 01)
    if (yr.length === 2 && !/\d/.test(dateStr.slice(0, offset))) return match;
    return '';
  }).trim();
}

function looksLikeHeader(row) {
  return row.some(cell => HEADER_KEYWORDS.includes(cell.toLowerCase().trim()));
}

function parseCSV(buffer, templateKey = 'new-employee') {
  const records = parse(buffer, {
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    relax_column_count: true, // Excel omits trailing empty cells — a short row must not abort the upload
    bom: true,                // strip UTF-8 BOM so the first cell doesn't gain an invisible char
  });

  if (records.length === 0) return [];

  // Skip header row if detected
  const start = looksLikeHeader(records[0]) ? 1 : 0;

  return records.slice(start).map((row, i) => {
    if (templateKey === 'birthday') {
      // Birthday CSV: Birthday, Full Name, Position, Division, Department
      return {
        rowNumber: start + i + 1,
        birthdayDate: stripYear(correctMonthSpelling(row[0] || '')),
        fullName: row[1] || '',
        position: row[2] || '',
        department: row[3] || '',
        division: row[4] || '',
      };
    }
    if (templateKey === 'anniversary') {
      // Anniversary CSV: Date Hired, Years, Full Name, Position, Division, Department
      return {
        rowNumber: start + i + 1,
        dateHired: stripYear(correctMonthSpelling(row[0] || '')),
        anniversaryYears: row[1] || '',
        fullName: row[2] || '',
        position: row[3] || '',
        division: row[4] || '',
        department: row[5] || '',
      };
    }
    if (templateKey === 'calling-card') {
      // Calling Card CSV: Full Name, Position, Email Address, Mobile Number
      return {
        rowNumber: start + i + 1,
        fullName: row[0] || '',
        position: row[1] || '',
        email: row[2] || '',
        mobile: row[3] || '',
      };
    }
    if (templateKey === 'multisys-id') {
      // Multisys ID CSV: Employee Number, Full Name, Position, Address, Phone Number, SSS Number, TIN, Pag-ibig, PhilHealth Number, Emergency Contact Name, Emergency Contact Address, Emergency Contact Number
      return {
        rowNumber: start + i + 1,
        employeeNumber: row[0] || '',
        fullName: row[1] || '',
        position: row[2] || '',
        address: row[3] || '',
        phoneNumber: row[4] || '',
        sss: row[5] || '',
        tin: row[6] || '',
        hdmf: row[7] || '',
        philhealth: row[8] || '',
        contactName: row[9] || '',
        contactAddress: row[10] || '',
        contactNumber: row[11] || '',
      };
    }
    // New Employee CSV: Full Name, Position, Department
    return {
      rowNumber: start + i + 1,
      fullName: row[0] || '',
      position: row[1] || '',
      department: row[2] || '',
      division: row[3] || '',
      birthdayDate: row[4] || '',
    };
  }).filter(r => r.fullName.trim());
}

module.exports = { parseCSV };
