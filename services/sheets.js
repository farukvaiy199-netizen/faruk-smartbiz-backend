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

// শিট বারবার (প্রতিটা কাস্টমার মেসেজে) ফেচ না করে অল্প সময়ের জন্য ক্যাশে রাখি —
// এতে টোকেন খরচ কমে না, কিন্তু রেসপন্স দ্রুত হয় আর শিটে বেশি রিকোয়েস্ট যায় না
const sheetCache = {}; // { csvUrl: { rows, fetchedAt } }
const CACHE_TTL_MS = 3 * 60 * 1000; // ৩ মিনিট

async function fetchSheetRows(sheetLink) {
  const csvUrl = toCsvExportUrl(sheetLink);
  if (!csvUrl) return null;

  const cached = sheetCache[csvUrl];
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rows;
  }

  const res = await axios.get(csvUrl, { timeout: 8000 });
  const rows = parseCsv(res.data);
  sheetCache[csvUrl] = { rows, fetchedAt: Date.now() };
  return rows;
}

// কাস্টমারের মেসেজের সাথে সবচেয়ে প্রাসঙ্গিক সারিগুলো বেছে নেয় —
// পুরো শিট (হয়তো শত শত প্রোডাক্ট/লাইন) প্রতিটা মেসেজে AI-কে পাঠানোর বদলে
// শুধু প্রাসঙ্গিক অংশ পাঠালে টোকেন খরচ অনেক কমে যায়, তাই রেট-লিমিটেও কম ধাক্কা লাগে।
function pickRelevantRows(dataRows, query, maxRows) {
  const words = (query || '')
    .toLowerCase()
    .split(/[\s,।.!?]+/)
    .filter(w => w.length >= 2);

  // মেসেজে বোঝার মতো শব্দ না থাকলে (যেমন শুধু ইমোজি) শুরুর কয়েকটা সারি দিয়ে দিই
  if (!words.length) return dataRows.slice(0, Math.min(maxRows, 10));

  const scored = dataRows.map(row => {
    const rowText = row.join(' ').toLowerCase();
    let score = 0;
    words.forEach(w => { if (rowText.includes(w)) score++; });
    return { row, score };
  });

  const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  if (matched.length) return matched.slice(0, maxRows).map(s => s.row);

  // কাস্টমারের মেসেজে কোনো প্রোডাক্ট/কীওয়ার্ড না মিললে (যেমন শুধু "সালাম", "ধন্যবাদ")
  // পুরো শিট না পাঠিয়ে শুরুর কয়েকটা সারি নমুনা হিসেবে পাঠাই, যাতে AI চাইলে
  // "আমাদের কাছে এই ধরনের প্রোডাক্ট আছে" বলে কথোপকথন শুরু করতে পারে
  return dataRows.slice(0, Math.min(maxRows, 10));
}

// শিটের ডেটা টেক্সট আকারে ফেরত দেয়, যেটা AI কে prompt এর ভেতর context হিসেবে দেওয়া হবে।
// query দিলে (কাস্টমারের বর্তমান মেসেজ) শুধু প্রাসঙ্গিক সারিগুলোই পাঠানো হয়, পুরো শিট না।
async function getSheetContext(sheetLink, label = 'দোকানের প্রোডাক্ট/অফার শিট', query = '', maxRows = 15) {
  if (!sheetLink) return '';
  try {
    const rows = await fetchSheetRows(sheetLink);
    if (!rows || !rows.length) return '';

    const header = rows[0];
    const dataRows = rows.slice(1, 300); // শিট থেকে সর্বোচ্চ ৩০০ সারি পর্যন্ত বিবেচনা করি
    const relevant = pickRelevantRows(dataRows, query, maxRows);

    const lines = relevant.map(r =>
      header.map((h, i) => `${h}: ${r[i] || ''}`).join(', ')
    );
    return `নিচে ${label} থেকে প্রাসঙ্গিক তথ্য (মোট ${dataRows.length}টার মধ্যে ${relevant.length}টা দেখানো হচ্ছে):\n` + lines.join('\n');
  } catch (err) {
    console.error(`Google Sheet fetch failed (${label}):`, err.message);
    return '';
  }
}

// দুটো শিট (প্রোডাক্ট + FAQ) একসাথে পড়ে একটাই কম্বাইন্ড context বানায়
async function getCombinedSheetContext(inventoryLink, faqLink, query = '') {
  const [inventoryText, faqText] = await Promise.all([
    getSheetContext(inventoryLink, 'দোকানের প্রোডাক্ট/অফার শিট', query, 15),
    getSheetContext(faqLink, 'দোকানের সাধারণ প্রশ্ন-উত্তর (FAQ) শিট', query, 10)
  ]);
  return [inventoryText, faqText].filter(Boolean).join('\n\n');
}

// শিটে "Stock"/"স্টক"/"Quantity" নামের কলাম থাকলে, প্রোডাক্টের নাম দিয়ে বর্তমান স্টক খুঁজে বের করে।
// এমন কলাম না থাকলে (বা শিট সংযুক্ত না থাকলে) null রিটার্ন করে — তখন স্টক চেক স্কিপ হয়ে যায়,
// অর্ডার নেওয়া আটকায় না।
async function getProductStock(sheetLink, productName) {
  if (!sheetLink || !productName) return null;
  try {
    const rows = await fetchSheetRows(sheetLink);
    if (!rows || rows.length < 2) return null;

    const header = rows[0].map(h => (h || '').toLowerCase());
    const stockIdx = header.findIndex(h => h.includes('stock') || h.includes('স্টক') || h.includes('quantity'));
    const nameIdx = header.findIndex(h => h.includes('name') || h.includes('নাম') || h.includes('product') || h.includes('প্রোডাক্ট'));
    if (stockIdx === -1 || nameIdx === -1) return null;

    const target = productName.toLowerCase();
    const dataRows = rows.slice(1);
    const match = dataRows.find(r =>
      (r[nameIdx] || '').toLowerCase().includes(target) || target.includes((r[nameIdx] || '').toLowerCase())
    );
    if (!match) return null;

    const stockVal = parseInt(match[stockIdx], 10);
    return isNaN(stockVal) ? null : stockVal;
  } catch (err) {
    console.error('স্টক চেক করতে ব্যর্থ:', err.message);
    return null;
  }
}

module.exports = { getSheetContext, getCombinedSheetContext, getProductStock, writeOrderToSheet, writeCustomerToSheet };

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
