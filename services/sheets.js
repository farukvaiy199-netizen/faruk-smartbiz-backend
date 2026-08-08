const axios = require('axios');

// ইউজার সাধারণ শেয়ার লিংক দেবে, যেমন:
// https://docs.google.com/spreadsheets/d/1AbCDefGhIJKLmnop/edit?usp=sharing
// সেটাকে CSV এক্সপোর্ট লিংকে বদলে দেই।
// শর্ত: শিটটা "Anyone with the link" - Viewer/Editor করে শেয়ার করা থাকতে হবে।
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
    // সাধারণ CSV split (কমার ভেতরে quoted কমা থাকলে আরও ভালো parser লাগবে,
    // কিন্তু প্রোডাক্ট শিটের জন্য এটা যথেষ্ট)
    line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''))
  );
}

// শিটের ডেটা টেক্সট আকারে ফেরত দেয়, যেটা AI কে prompt এর ভেতর context হিসেবে দেওয়া হবে
// label দিয়ে বোঝানো হয় এটা কোন ধরনের শিট (প্রোডাক্ট নাকি সাধারণ প্রশ্ন-উত্তর)
async function getSheetContext(sheetLink, label = 'দোকানের প্রোডাক্ট/অফার শিট') {
  if (!sheetLink) return '';
  const csvUrl = toCsvExportUrl(sheetLink);
  if (!csvUrl) return '';
  try {
    const res = await axios.get(csvUrl, { timeout: 8000 });
    const rows = parseCsv(res.data);
    if (!rows.length) return '';
    const header = rows[0];
    const dataRows = rows.slice(1, 60); // বেশি বড় শিট হলে টোকেন বাঁচাতে প্রথম ৬০ সারি
    const lines = dataRows.map(r =>
      header.map((h, i) => `${h}: ${r[i] || ''}`).join(', ')
    );
    return `নিচে ${label} থেকে নেওয়া তথ্য:\n` + lines.join('\n');
  } catch (err) {
    console.error(`Google Sheet fetch failed (${label}):`, err.message);
    return '';
  }
}

// দুটো শিট (প্রোডাক্ট + FAQ) একসাথে পড়ে একটাই কম্বাইন্ড context বানায়
async function getCombinedSheetContext(inventoryLink, faqLink) {
  const [inventoryText, faqText] = await Promise.all([
    getSheetContext(inventoryLink, 'দোকানের প্রোডাক্ট/অফার শিট'),
    getSheetContext(faqLink, 'দোকানের সাধারণ প্রশ্ন-উত্তর (FAQ) শিট')
  ]);
  return [inventoryText, faqText].filter(Boolean).join('\n\n');
}

module.exports = { getSheetContext, getCombinedSheetContext, writeOrderToSheet, writeCustomerToSheet };

/* ---------- Apps Script দিয়ে শিটে লেখা (order/customer) ---------- */
async function writeOrderToSheet({ scriptUrl, scriptToken, order }) {
  if (!scriptUrl) return;
  try {
    await axios.post(scriptUrl, {
      token: scriptToken,
      type: 'order',
      orderId: order.id,
      customerName: order.name,
      phone: order.phone,
      address: order.address,
      product: order.product,
      quantity: order.qty,
      unitPrice: order.price,
      totalPrice: (order.price || 0) * (order.qty || 1),
      paymentMethod: order.payment || 'COD',
      status: order.status,
      source: order.source
    }, { timeout: 10000 });
  } catch (err) {
    console.error('Sheet-এ অর্ডার লিখতে ব্যর্থ:', err.message);
  }
}

async function writeCustomerToSheet({ scriptUrl, scriptToken, customer }) {
  if (!scriptUrl) return;
  try {
    await axios.post(scriptUrl, {
      token: scriptToken,
      type: 'customer',
      customerId: customer.id,
      name: customer.name,
      phone: customer.phone,
      messengerId: customer.platform === 'facebook' ? customer.platformId : '',
      whatsapp: customer.platform === 'whatsapp' ? customer.platformId : '',
      language: 'বাংলা',
      aiStatus: customer.ai ? 'চালু' : 'বন্ধ'
    }, { timeout: 10000 });
  } catch (err) {
    console.error('Sheet-এ কাস্টমার লিখতে ব্যর্থ:', err.message);
  }
}
