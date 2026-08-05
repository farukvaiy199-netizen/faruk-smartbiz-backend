// ছোট ব্যবসার জন্য সহজ JSON-ফাইল ভিত্তিক ডেটাবেস।
// বড় স্কেলে গেলে এটাকে MongoDB/PostgreSQL দিয়ে বদলে দিন।

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

const ALGO = 'aes-256-cbc';
const KEY = crypto.createHash('sha256').update(config.encryptionKey).digest(); // 32 bytes

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(payload) {
  if (!payload) return '';
  try {
    const [ivHex, dataHex] = payload.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    return '';
  }
}

function defaultDb() {
  return {
    orders: [],
    customers: [],
    broadcasts: [],
    conversations: {}, // { customerId: [{role:'user'|'assistant', text, ts}] }
    settings: {
      fbToken: '',
      fbPageId: '',
      fbAppId: '',
      waToken: '',
      waPhoneNumberId: '',
      sheetLink: '',
      sheetScriptUrl: '',
      sheetScriptToken: '',
      aiKey: '',
      aiProvider: 'groq', // 'groq' or 'openai'
      aiAutoReply: true,
      connected: { fb: false, wa: false, sheet: false, ai: false }
    },
    nextOrderSeq: 232
  };
}

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    writeDb(defaultDb());
  }
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  return JSON.parse(raw);
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

/* ---------- Settings (tokens encrypted at rest) ---------- */
function getSettings() {
  const db = readDb();
  const s = db.settings;
  return {
    fbToken: decrypt(s.fbToken),
    fbPageId: s.fbPageId || '',
    fbAppId: s.fbAppId || '',
    waToken: decrypt(s.waToken),
    waPhoneNumberId: s.waPhoneNumberId || '',
    sheetLink: s.sheetLink || '',
    sheetScriptUrl: s.sheetScriptUrl || '',
    sheetScriptToken: s.sheetScriptToken || '',
    aiKey: decrypt(s.aiKey),
    aiProvider: s.aiProvider || 'groq',
    aiAutoReply: s.aiAutoReply !== undefined ? s.aiAutoReply : true,
    connected: s.connected || { fb: false, wa: false, sheet: false, ai: false }
  };
}

function saveSettings(partial) {
  const db = readDb();
  const s = db.settings;
  if (partial.fbToken !== undefined) { s.fbToken = encrypt(partial.fbToken); s.connected.fb = !!partial.fbToken; }
  if (partial.fbPageId !== undefined) s.fbPageId = partial.fbPageId;
  if (partial.fbAppId !== undefined) s.fbAppId = partial.fbAppId;
  if (partial.waToken !== undefined) { s.waToken = encrypt(partial.waToken); s.connected.wa = !!partial.waToken; }
  if (partial.waPhoneNumberId !== undefined) s.waPhoneNumberId = partial.waPhoneNumberId;
  if (partial.sheetLink !== undefined) { s.sheetLink = partial.sheetLink; s.connected.sheet = !!partial.sheetLink; }
  if (partial.sheetScriptUrl !== undefined) s.sheetScriptUrl = partial.sheetScriptUrl;
  if (partial.sheetScriptToken !== undefined) s.sheetScriptToken = partial.sheetScriptToken;
  if (partial.aiKey !== undefined) { s.aiKey = encrypt(partial.aiKey); s.connected.ai = !!partial.aiKey; }
  if (partial.aiProvider !== undefined) s.aiProvider = partial.aiProvider;
  if (partial.aiAutoReply !== undefined) s.aiAutoReply = !!partial.aiAutoReply;
  db.settings = s;
  writeDb(db);
  return getSettings();
}

/* ---------- Customers ---------- */
function findOrCreateCustomer({ platform, platformId, name, phone }) {
  const db = readDb();
  let customer = db.customers.find(c => c.platformId === platformId && c.platform === platform);
  if (!customer) {
    customer = {
      id: 'C-' + (1000 + db.customers.length + 1),
      platform,
      platformId,
      name: name || 'অজানা কাস্টমার',
      phone: phone || '',
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

// AI-এর সাথে কথা বলার সময় কাস্টমার নাম/ফোন জানালে প্রোফাইল আপডেট করি
function updateCustomerContact(id, { name, phone }) {
  const db = readDb();
  const c = db.customers.find(x => x.id === id);
  if (!c) return null;
  if (name && name.trim()) c.name = name.trim();
  if (phone && phone.trim()) c.phone = phone.trim();
  writeDb(db);
  return c;
}

/* ---------- Conversations ---------- */
function appendMessage(customerId, role, text) {
  const db = readDb();
  if (!db.conversations[customerId]) db.conversations[customerId] = [];
  db.conversations[customerId].push({ role, text, ts: new Date().toISOString() });
  // শুধু শেষ ২০টা মেসেজ রাখি (AI context এর জন্য যথেষ্ট)
  db.conversations[customerId] = db.conversations[customerId].slice(-20);
  writeDb(db);
}

function getConversation(customerId) {
  const db = readDb();
  return db.conversations[customerId] || [];
}

/* ---------- Orders ---------- */
function createOrder({ customerId, name, phone, address, product, qty, price, source }) {
  const db = readDb();
  const id = 'ORD-' + String(db.nextOrderSeq).padStart(6, '0');
  db.nextOrderSeq += 1;
  const order = {
    id, customerId, name,
    phone: phone || '',
    address: address || '',
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

  // ফোন নাম্বার দিয়ে আগের কাস্টমার খুঁজি, না পেলে নতুন বানাই — যাতে Customers ট্যাবেও দেখা যায়
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

module.exports = {
  getSettings, saveSettings,
  findOrCreateCustomer, getCustomers, setCustomerAI, updateCustomerContact,
  appendMessage, getConversation,
  createOrder, createWebsiteOrder, getOrders, updateOrderStatus,
  addBroadcast, getBroadcasts
};
