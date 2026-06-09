const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const credentialsPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './credentials.json';

function getAuthClient() {
  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Service account credentials not found at ${credentialsPath}. Please set up Google authentication.`);
  }

  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/drive',
    ],
  });

  return auth;
}

function getSheetsClient() {
  const auth = getAuthClient();
  return google.sheets({ version: 'v4', auth });
}

function getDriveClient() {
  const auth = getAuthClient();
  return google.drive({ version: 'v3', auth });
}

module.exports = {
  getAuthClient,
  getSheetsClient,
  getDriveClient,
};
