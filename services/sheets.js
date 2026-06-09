const { getSheetsClient } = require('./google-auth');

async function readSheet(sheetUrl) {
  try {
    // Extract sheet ID from URL
    const sheetIdMatch = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!sheetIdMatch) {
      throw new Error('Invalid Google Sheets URL format');
    }
    const spreadsheetId = sheetIdMatch[1];

    const sheets = getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Sheet1!A2:D',
    });

    const rows = response.data.values || [];
    return rows.map((row, index) => ({
      rowNumber: index + 2,
      photoLink: row[0] || '',
      fullName: row[1] || '',
      position: row[2] || '',
      department: row[3] || '',
    }));
  } catch (error) {
    throw new Error(`Failed to read sheet: ${error.message}`);
  }
}

module.exports = {
  readSheet,
};
