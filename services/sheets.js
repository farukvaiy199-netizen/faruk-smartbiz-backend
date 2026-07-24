const axios = require('axios');

function toCsvExportUrl(sheetLink) {
  const match = sheetLink.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) return null;
  const sheetId = match[1];
  const gidMatch = sheetLink.match(/gid=([0-9]+)/);
  const gid = gidMatch ? gidMatch[1] : '0';
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
}

function parseCsv(csvText) {
  const lines = csvText.trim().split('\n').filter(Boolean);
  return lines.map(line =>
    line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''))
  );
}

async function getSheetContext(sheetLink) {
  if (!sheetLink) return '';
  const csvUrl = toCsvExportUrl(sheetLink);
  if (!csvUrl) return '';
  try {
    const res = await axios.get(csvUrl, { timeout: 8000 });
    const rows = parseCsv(res.data);
    if (!rows.length) return '';
    const header = rows[0];
    const dataRows = rows.slice(1, 60);
    const lines = dataRows.map(r =>
      header.map((h, i) => `${h}: ${r[i] || ''}`).join(', ')
    );
    return 'নিচে দোকানের প্রোডাক্ট/অফার শিট থেকে নেওয়া তথ্য:\n' + lines.join('\n');
  } catch (err) {
    console.error('Google Sheet fetch failed:', err.message);
    return '';
  }
}

module.exports = { getSheetContext };
