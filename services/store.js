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

function defaultSettings() {
  return {
    fbToken: '', fbPageId: '', fbAppId: '',
    waToken: '', waPhoneNumberId: '',
    sheetLink: '',
    aiKey: '', aiProvider: 'groq', aiAutoReply: true
  };
}

/* ---------- Settings — Google Sheet-এ স্থায়ীভাবে সেভ হয় (server redeploy হলেও হারায় না) ---------- */
let cachedSettings = null; // এই সার্ভার ইনস্ট্যান্স চালু থাকা অবস্থায় বারবার শিটে না গিয়ে দ্রুত সাড়া দিতে

function computeConnected(s) {
  return {
    fb: !!s.fbToken,
    wa: !!(s.waToken && s.waPhoneNumberId),
    sheet: !!s.sheetLink,
    ai: !!s.aiKey
  };
}

async function getSettings() {
  if (cachedSettings) return { ...cachedSettings, connected: computeConnected(cachedSettings) };

  if (config.sheetScriptUrl) {
    try {
      const res = await axios.post(config.sheetScriptUrl, {
        token: config.sheetScriptToken,
        type: 'settings_get'
      }, { timeout: 10000 });
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

  if (config.sheetScriptUrl) {
    try {
      await axios.post(config.sheetScriptUrl, {
        token: config.sheetScriptToken,
        type: 'settings_save',
        settings: merged
      }, { timeout: 10000 });
    } catch (err) {
      console.error('Google Sheet-এ সেটিংস সেভ করতে ব্যর্থ:', err.message);
    }
  }

  const db = readDb();
  db.settings = merged;
  writeDb(db);

  return { ...merged, connected: computeConnected(merged) };
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
