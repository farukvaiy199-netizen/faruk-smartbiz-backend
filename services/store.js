const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

const ALGO = 'aes-256-cbc';
const KEY = crypto.createHash('sha256').update(config.encryptionKey).digest();

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
    conversations: {},
    settings: {
      fbToken: '',
      fbPageId: '',
      waToken: '',
      waPhoneNumberId: '',
      sheetLink: '',
      aiKey: '',
      aiProvider: 'groq',
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

function getSettings() {
  const db = readDb();
  const s = db.settings;
  return {
    fbToken: decrypt(s.fbToken),
    fbPageId: s.fbPageId || '',
    waToken: decrypt(s.waToken),
    waPhoneNumberId: s.waPhoneNumberId || '',
    sheetLink: s.sheetLink || '',
    aiKey: decrypt(s.aiKey),
    aiProvider: s.aiProvider || 'groq',
    connected: s.connected || { fb: false, wa: false, sheet: false, ai: false }
  };
}

function saveSettings(partial) {
  const db = readDb();
  const s = db.settings;
  if (partial.fbToken !== undefined) { s.fbToken = encrypt(partial.fbToken); s.connected.fb = !!partial.fbToken; }
  if (partial.fbPageId !== undefined) s.fbPageId = partial.fbPageId;
  if (partial.waToken !== undefined) { s.waToken = encrypt(partial.waToken); s.connected.wa = !!partial.waToken; }
  if (partial.waPhoneNumberId !== undefined) s.waPhoneNumberId = partial.waPhoneNumberId;
  if (partial.sheetLink !== undefined) { s.sheetLink = partial.sheetLink; s.connected.sheet = !!partial.sheetLink; }
  if (partial.aiKey !== undefined) { s.aiKey = encrypt(partial.aiKey); s.connected.ai = !!partial.aiKey; }
  if (partial.aiProvider !== undefined) s.aiProvider = partial.aiProvider;
  db.settings = s;
  writeDb(db);
  return getSettings();
}

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

function appendMessage(customerId, role, text) {
  const db = readDb();
  if (!db.conversations[customerId]) db.conversations[customerId] = [];
  db.conversations[customerId].push({ role, text, ts: new Date().toISOString() });
  db.conversations[customerId] = db.conversations[customerId].slice(-20);
  writeDb(db);
}

function getConversation(customerId) {
  const db = readDb();
  return db.conversations[customerId] || [];
}

function createOrder({ customerId, name, product, qty, price, source }) {
  const db = readDb();
  const id = 'ORD-' + String(db.nextOrderSeq).padStart(6, '0');
  db.nextOrderSeq += 1;
  const order = {
    id, customerId, name, product,
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

function updateOrderStatus(id, status) {
  const db = readDb();
  const o = db.orders.find(x => x.id === id);
  if (!o) return null;
  o.status = status;
  writeDb(db);
  return o;
}

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
  findOrCreateCustomer, getCustomers, setCustomerAI,
  appendMessage, getConversation,
  createOrder, getOrders, updateOrderStatus,
  addBroadcast, getBroadcasts
};
