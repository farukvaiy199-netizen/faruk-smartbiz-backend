// ছোট ব্যবসার জন্য সহজ JSON-ফাইল ভিত্তিক ডেটাবেস (অর্ডার/কাস্টমার/মেসেজের জন্য)।
// কিন্তু সেটিংস (AI Key, Facebook Token ইত্যাদি) আলাদাভাবে Google Sheet-এ স্থায়ীভাবে রাখা হয়,
// কারণ Render Free সার্ভিসে লোকাল ফাইল প্রতি ডিপ্লয়ে মুছে যায় (ephemeral disk)।

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('../config');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function defaultDb() {
  return {
    orders: [],
    customers: [],
    broadcasts: [],
    conversations: {}, // { customerId: [{role:'user'|'assistant', text, ts}] }
    emailLogs: [], // অর্ডার কনফার্মেশন ইমেইল পাঠানোর হিস্টোরি (নতুন)
    nextOrderSeq: 232
  };
}

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    writeDb(defaultDb());
  }
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  const db = JSON.parse(raw);
  if (!db.emailLogs) db.emailLogs = []; // পুরনো db.json ফাইলে এই ফিল্ড নাও থাকতে পারে
  return db;
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function defaultSettings() {
  return {
    fbToken: '', fbPageId: '', fbAppId: '',
    waToken: '', waPhoneNumberId: '', waBusinessId: '', waConfigId: '', waAppId: '',
    sheetLink: '', faqSheetLink: '',
    aiKey: '', aiProvider: 'groq', aiAutoReply: true,
    // ============ ব্যাকআপ AI Key (নতুন) — প্রধানটা কোটা/রেট-লিমিটে আটকে গেলে এটা ব্যবহার হবে ============
    aiKey2: '', aiProvider2: 'groq'
  };
}

/* ---------- Settings — Google Sheet-এ স্থায়ীভাবে সেভ হয় (server redeploy হলেও হারায় না) ---------- */
let cachedSettings = null;

function computeConnected(s) {
  return {
    fb: !!s.fbToken,
    wa: !!(s.waToken && s.waPhoneNumberId),
    sheet: !!s.sheetLink,
    ai: !!s.aiKey,
    ai2: !!s.aiKey2
  };
}

async function postToScript(payload, timeout1 = 10000, timeout2 = 20000) {
  try {
    return await axios.post(config.sheetScriptUrl, payload, { timeout: timeout1 });
  } catch (err) {
    return await axios.post(config.sheetScriptUrl, payload, { timeout: timeout2 });
  }
}

async function getSettings() {
  if (cachedSettings) return { ...cachedSettings, connected: computeConnected(cachedSettings) };

  if (config.sheetScriptUrl) {
    try {
      const res = await postToScript({ token: config.sheetScriptToken, type: 'settings_get' });
      const remote = (res.data && res.data.settings) || {};
      cachedSettings = { ...defaultSettings(), ...remote };
      return { ...cachedSettings, connected: computeConnected(cachedSettings) };
    } catch (err) {
      console.error('Google Sheet থেকে সেটিংস আনতে ব্যর্থ:', err.message);
    }
  }

  const db = readDb();
  cachedSettings = { ...defaultSettings(), ...(db.settings || {}) };
  return { ...cachedSettings, connected: computeConnected(cachedSettings) };
}

async function saveSettings(partial) {
  const current = cachedSettings || (await getSettings());
  const merged = { ...current, ...partial };
  delete merged.connected;
  cachedSettings = merged;

  let sheetSaved = true;
  let sheetError = null;

  if (config.sheetScriptUrl) {
    try {
      await postToScript({ token: config.sheetScriptToken, type: 'settings_save', settings: merged });
    } catch (err) {
      sheetSaved = false;
      sheetError = err.message;
      console.error('Google Sheet-এ সেটিংস সেভ করতে ব্যর্থ:', err.message);
    }
  }

  const db = readDb();
  db.settings = merged;
  writeDb(db);

  return { ...merged, connected: computeConnected(merged), sheetSaved, sheetError };
}

/* ---------- Customers ---------- */
function findOrCreateCustomer({ platform, platformId, name, phone, photoUrl }) {
  const db = readDb();
  let customer = db.customers.find(c => c.platformId === platformId && c.platform === platform);
  if (!customer) {
    customer = {
      id: 'C-' + (1000 + db.customers.length + 1),
      platform,
      platformId,
      name: name || 'অজানা কাস্টমার',
      phone: phone || '',
      photoUrl: photoUrl || '', // কাস্টমারের প্রোফাইল ছবি (এখন পর্যন্ত শুধু Facebook থেকে পাওয়া যায়)
      orders: 0,
      ai: true,
      createdAt: new Date().toISOString()
    };
    db.customers.push(customer);
    writeDb(db);
  }
  return customer;
}

function getCustomers() {
  return readDb().customers;
}

function setCustomerAI(id, aiOn) {
  const db = readDb();
  const c = db.customers.find(x => x.id === id);
  if (!c) return null;
  c.ai = aiOn;
  writeDb(db);
  return c;
}

// AI-এর সাথে কথা বলার সময় কাস্টমার নাম/ফোন জানালে, অথবা Facebook থেকে প্রোফাইল ছবি পেলে
// প্রোফাইল আপডেট করি
function updateCustomerContact(id, { name, phone, photoUrl }) {
  const db = readDb();
  const c = db.customers.find(x => x.id === id);
  if (!c) return null;
  if (name && name.trim()) c.name = name.trim();
  if (phone && phone.trim()) c.phone = phone.trim();
  if (photoUrl) c.photoUrl = photoUrl;
  writeDb(db);
  return c;
}

/* ---------- Conversations — Google Sheet-এ স্থায়ীভাবে সেভ হয় (স্মৃতি হারায় না) ---------- */
let convCache = {};

async function getConversation(customerId) {
  if (convCache[customerId]) return convCache[customerId];

  if (config.sheetScriptUrl) {
    try {
      const res = await postToScript({ token: config.sheetScriptToken, type: 'conversation_get', customerId });
      const msgs = (res.data && res.data.messages) || [];
      convCache[customerId] = msgs;
      return msgs;
    } catch (err) {
      console.error('Google Sheet থেকে কথোপকথন আনতে ব্যর্থ:', err.message);
    }
  }

  const db = readDb();
  return (db.conversations && db.conversations[customerId]) || [];
}

async function appendMessage(customerId, role, text) {
  const current = await getConversation(customerId);
  // আগে শেষ ২০টা রাখা হতো, এখন ১৬টা — এতে প্রতিটা AI রিকোয়েস্টে কম টোকেন লাগে,
  // রেট-লিমিটে ধাক্কা লাগার সম্ভাবনা কমে (কথোপকথনের সাম্প্রতিক প্রসঙ্গ ঠিকই থাকে)
  const updated = [...current, { role, text, ts: new Date().toISOString() }].slice(-16);
  convCache[customerId] = updated;

  if (config.sheetScriptUrl) {
    postToScript({ token: config.sheetScriptToken, type: 'conversation_save', customerId, messages: updated })
      .catch(err => console.error('Google Sheet-এ কথোপকথন সেভ করতে ব্যর্থ:', err.message));
  }

  const db = readDb();
  if (!db.conversations) db.conversations = {};
  db.conversations[customerId] = updated;
  writeDb(db);
}

/* ---------- Orders ---------- */
function createOrder({ customerId, name, phone, address, product, qty, price, email, source }) {
  const db = readDb();
  const id = 'ORD-' + String(db.nextOrderSeq).padStart(6, '0');
  db.nextOrderSeq += 1;
  const order = {
    id, customerId, name,
    phone: phone || '',
    address: address || '',
    email: email || '', // ঐচ্ছিক — কাস্টমার নিজে থেকে দিলে তবেই থাকবে
    product,
    qty: qty || 1, price: price || 0,
    status: 'Pending', source,
    createdAt: new Date().toISOString()
  };
  db.orders.unshift(order);
  const cust = db.customers.find(c => c.id === customerId);
  if (cust) cust.orders += 1;
  writeDb(db);
  return order;
}

function getOrders() {
  return readDb().orders;
}

function getOrdersByCustomer(customerId) {
  return readDb().orders.filter(o => o.customerId === customerId);
}

// অর্ডার কনফার্ম হয়ে যাওয়ার পরে কাস্টমার আলাদাভাবে ইমেইল পাঠালে, তার সবচেয়ে সাম্প্রতিক
// (এখনো ইমেইল যোগ হয়নি এমন) অর্ডারে সেটা জুড়ে দেয়
function attachEmailToLatestOrder(customerId, email) {
  const db = readDb();
  const order = db.orders.find(o => o.customerId === customerId && !o.email);
  if (!order) return null;
  order.email = email;
  writeDb(db);
  return order;
}

/* ---------- বাইরের ওয়েবসাইট (Bazaar Admin) থেকে ওয়েবহুকের মাধ্যমে আসা অর্ডার ---------- */
function createWebsiteOrder(payload = {}) {
  const db = readDb();
  const id = payload.orderId ? String(payload.orderId) : ('ORD-' + String(db.nextOrderSeq).padStart(6, '0'));
  if (!payload.orderId) db.nextOrderSeq += 1;

  const items = Array.isArray(payload.items) ? payload.items : [];
  const productSummary = items.length
    ? items.map(it => `${it.name || it.product || 'পণ্য'}${it.qty ? ' x' + it.qty : ''}`).join(', ')
    : (payload.product || 'ওয়েবসাইট অর্ডার');
  const qty = items.length ? items.reduce((sum, it) => sum + (Number(it.qty) || 1), 0) : (Number(payload.qty) || 1);
  const price = Number(payload.total) || Number(payload.subtotal) || 0;

  let customer = null;
  if (payload.phone) {
    customer = db.customers.find(c => c.phone === payload.phone && c.platform === 'website');
    if (!customer) {
      customer = {
        id: 'C-' + (1000 + db.customers.length + 1),
        platform: 'website',
        platformId: payload.phone,
        name: payload.customer || 'ওয়েবসাইট কাস্টমার',
        phone: payload.phone,
        photoUrl: '',
        orders: 0,
        ai: true,
        createdAt: new Date().toISOString()
      };
      db.customers.push(customer);
    }
    customer.orders += 1;
  }

  const order = {
    id,
    customerId: customer ? customer.id : null,
    name: payload.customer || (customer ? customer.name : 'ওয়েবসাইট কাস্টমার'),
    product: productSummary,
    qty,
    price,
    status: 'Pending',
    source: 'Bazaar Admin',
    address: payload.address || '',
    email: payload.email || '',
    payment: payload.payment || '',
    transactionId: payload.transactionId || '',
    createdAt: payload.date ? new Date(payload.date).toISOString() : new Date().toISOString()
  };
  db.orders.unshift(order);
  writeDb(db);
  return order;
}

function updateOrderStatus(id, status) {
  const db = readDb();
  const o = db.orders.find(x => x.id === id);
  if (!o) return null;
  o.status = status;
  writeDb(db);
  return o;
}

/* ---------- Broadcasts ---------- */
function addBroadcast(record) {
  const db = readDb();
  db.broadcasts.unshift(record);
  writeDb(db);
  return record;
}

function getBroadcasts() {
  return readDb().broadcasts;
}

/* ---------- Email Logs (নতুন) — অর্ডার কনফার্মেশন ইমেইল কাকে পাঠানো হয়েছে তার হিস্টোরি ---------- */
function addEmailLog(entry) {
  const db = readDb();
  db.emailLogs.unshift(entry);
  db.emailLogs = db.emailLogs.slice(0, 200); // বেশি বড় না হয়ে যায়
  writeDb(db);
  return entry;
}

function getEmailLogs() {
  return readDb().emailLogs;
}

module.exports = {
  getSettings, saveSettings,
  findOrCreateCustomer, getCustomers, setCustomerAI, updateCustomerContact,
  appendMessage, getConversation,
  createOrder, createWebsiteOrder, getOrders, getOrdersByCustomer, updateOrderStatus, attachEmailToLatestOrder,
  addBroadcast, getBroadcasts,
  addEmailLog, getEmailLogs
};
