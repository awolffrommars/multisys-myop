const { getDriveClient } = require('./google-auth');
const { Readable } = require('stream');

function extractFileId(driveLink) {
  // Extract file ID from various Google Drive URL formats
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9-_]+)/,
    /id=([a-zA-Z0-9-_]+)/,
    /^([a-zA-Z0-9-_]+)$/, // Just the ID
  ];

  for (const pattern of patterns) {
    const match = driveLink.match(pattern);
    if (match) return match[1];
  }

  throw new Error(`Could not extract file ID from: ${driveLink}`);
}

function detectImageFormat(buffer) {
  // Check file signature (magic bytes)
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'webp';
  return 'jpeg'; // Default to JPEG
}

async function downloadPhoto(driveLink) {
  try {
    const fileId = extractFileId(driveLink);
    const drive = getDriveClient();

    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    );

    const buffer = Buffer.from(response.data);
    return {
      buffer,
      format: detectImageFormat(buffer),
    };
  } catch (error) {
    throw new Error(`Failed to download photo: ${error.message}`);
  }
}

async function uploadPng(folderId, fileName, pngBuffer) {
  try {
    const drive = getDriveClient();
    const fileMetadata = {
      name: fileName,
      parents: [folderId],
    };

    const media = {
      mimeType: 'image/png',
      body: Readable.from(pngBuffer),
    };

    const response = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id, webViewLink',
    });

    return response.data;
  } catch (error) {
    throw new Error(`Failed to upload PNG: ${error.message}`);
  }
}

module.exports = {
  downloadPhoto,
  uploadPng,
  extractFileId,
};
