// আগে অর্ডার/কাস্টমার/কথোপকথন লোকাল db.json ফাইলে রাখা হতো — কিন্তু Render ফ্রি প্ল্যানে
// প্রতিটা নতুন deploy-তে সেই ফাইল মুছে যায় (ephemeral disk), ফলে ডেটা হারিয়ে যাচ্ছিল।
// এখন সবকিছু MongoDB-তে স্থায়ীভাবে সেভ হয় — redeploy হলেও আর হারাবে না।

const { MongoClient } = require('mongodb');
const config = require('../config');

let clientPromise = null;
async function getDb() {
  if (!config.mongoUri) {
    throw new Error('সার্ভারে MONGO_URI সেট করা নেই — Render Environment-এ যোগ করুন');
  }
  if (!clientPromise) {
    const client = new MongoClient(config.mongoUri);
    clientPromise = client.connect().then(c => c.db());
  }
  return clientPromise;
}

function stripId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return rest;
}

function defaultSettings() {
  return {
    fbToken: '', fbPageId: '', fbAppId: '',
    waToken: '', waPhoneNumberId: '', waBusinessId: '', waConfigId: '', waAppId: '',
    sheetLink: '', faqSheetLink: '',
    aiKey: '', aiProvider: 'groq', aiAutoReply: true,
    // ব্যাকআপ AI Key — প্রধানটা কোটা/রেট-লিমিটে আটকে গেলে এটা ব্যবহার হবে
    aiKey2: '', aiProvider2: 'groq'
  };
}

function computeConnected(s) {
  return {
    fb: !!s.fbToken,
    wa: !!(s.waToken && s.waPhoneNumberId),
    sheet: !!s.sheetLink,
    ai: !!s.aiKey,
    ai2: !!s.aiKey2
  };
}

/* ---------- Settings ---------- */
async function getSettings() {
  const db = await getDb();
  const doc = await db.collection('meta').findOne({ _id: 'settings' });
  const merged = { ...defaultSettings(), ...stripId(doc) };
  return { ...merged, connected: computeConnected(merged) };
}

async function saveSettings(partial) {
  const db = await getDb();
  const current = await getSettings();
  delete current.connected;
  const merged = { ...current, ...partial };
  await db.collection('meta').updateOne({ _id: 'settings' }, { $set: merged }, { upsert: true });
  return { ...merged, connected: computeConnected(merged), sheetSaved: true, sheetError: null };
}

/* ---------- Customers ---------- */
async function findOrCreateCustomer({ platform, platformId, name, phone, photoUrl }) {
  const db = await getDb();
  const col = db.collection('customers');
  let customer = await col.findOne({ platform, platformId });
  if (!customer) {
    const count = await col.countDocuments();
    customer = {
      id: 'C-' + (1000 + count + 1),
      platform, platformId,
      name: name || 'অজানা কাস্টমার',
      phone: phone || '',
      photoUrl: photoUrl || '',
      orders: 0,
      ai: true,
      createdAt: new Date().toISOString()
    };
    await col.insertOne(customer);
  }
  return stripId(customer);
}

async function getCustomers() {
  const db = await getDb();
  const list = await db.collection('customers').find().sort({ createdAt: -1 }).toArray();
  return list.map(stripId);
}

async function setCustomerAI(id, aiOn) {
  const db = await getDb();
  const col = db.collection('customers');
  await col.updateOne({ id }, { $set: { ai: aiOn } });
  return stripId(await col.findOne({ id }));
}

async function updateCustomerContact(id, { name, phone, photoUrl }) {
  const db = await getDb();
  const col = db.collection('customers');
  const set = {};
  if (name && name.trim()) set.name = name.trim();
  if (phone && phone.trim()) set.phone = phone.trim();
  if (photoUrl) set.photoUrl = photoUrl;
  if (Object.keys(set).length) await col.updateOne({ id }, { $set: set });
  return stripId(await col.findOne({ id }));
}

/* ---------- Conversations ---------- */
async function getConversation(customerId) {
  const db = await getDb();
  const doc = await db.collection('conversations').findOne({ customerId });
  return (doc && doc.messages) || [];
}

async function appendMessage(customerId, role, text) {
  const db = await getDb();
  const current = await getConversation(customerId);
  // সাম্প্রতিক ১৬টা মেসেজ রাখি — এতে প্রতিটা AI রিকোয়েস্টে কম টোকেন লাগে
  const updated = [...current, { role, text, ts: new Date().toISOString() }].slice(-16);
  await db.collection('conversations').updateOne(
    { customerId },
    { $set: { messages: updated } },
    { upsert: true }
  );
}

/* ---------- Orders ---------- */
async function nextOrderId() {
  const db = await getDb();
  const result = await db.collection('counters').findOneAndUpdate(
    { _id: 'orderSeq' },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const seq = (result && result.value && result.value.value) || 1;
  return 'ORD-' + String(1000 + seq).padStart(6, '0');
}

async function createOrder({ customerId, name, phone, address, product, qty, price, email, source }) {
  const db = await getDb();
  const id = await nextOrderId();
  const order = {
    id, customerId, name,
    phone: phone || '',
    address: address || '',
    email: email || '',
    product, qty: qty || 1, price: price || 0,
    status: 'Pending', source,
    createdAt: new Date().toISOString()
  };
  await db.collection('orders').insertOne(order);
  await db.collection('customers').updateOne({ id: customerId }, { $inc: { orders: 1 } });
  return stripId(order);
}

async function getOrders() {
  const db = await getDb();
  const list = await db.collection('orders').find().sort({ createdAt: -1 }).toArray();
  return list.map(stripId);
}

async function getOrdersByCustomer(customerId) {
  const db = await getDb();
  const list = await db.collection('orders').find({ customerId }).sort({ createdAt: -1 }).toArray();
  return list.map(stripId);
}

async function attachEmailToLatestOrder(customerId, email) {
  const db = await getDb();
  const col = db.collection('orders');
  const order = await col.find({ customerId, $or: [{ email: '' }, { email: { $exists: false } }] })
    .sort({ createdAt: -1 }).limit(1).next();
  if (!order) return null;
  await col.updateOne({ id: order.id }, { $set: { email } });
  return stripId(await col.findOne({ id: order.id }));
}

/* ---------- বাইরের ওয়েবসাইট (Bazaar Admin) থেকে ওয়েবহুকের মাধ্যমে আসা অর্ডার ---------- */
async function createWebsiteOrder(payload = {}) {
  const db = await getDb();
  const id = payload.orderId ? String(payload.orderId) : await nextOrderId();

  const items = Array.isArray(payload.items) ? payload.items : [];
  const productSummary = items.length
    ? items.map(it => `${it.name || it.product || 'পণ্য'}${it.qty ? ' x' + it.qty : ''}`).join(', ')
    : (payload.product || 'ওয়েবসাইট অর্ডার');
  const qty = items.length ? items.reduce((sum, it) => sum + (Number(it.qty) || 1), 0) : (Number(payload.qty) || 1);
  const price = Number(payload.total) || Number(payload.subtotal) || 0;

  let customer = null;
  if (payload.phone) {
    const col = db.collection('customers');
    customer = await col.findOne({ phone: payload.phone, platform: 'website' });
    if (!customer) {
      const count = await col.countDocuments();
      customer = {
        id: 'C-' + (1000 + count + 1),
        platform: 'website',
        platformId: payload.phone,
        name: payload.customer || 'ওয়েবসাইট কাস্টমার',
        phone: payload.phone,
        photoUrl: '',
        orders: 0, ai: true,
        createdAt: new Date().toISOString()
      };
      await col.insertOne(customer);
    }
    await col.updateOne({ id: customer.id }, { $inc: { orders: 1 } });
  }

  const order = {
    id,
    customerId: customer ? customer.id : null,
    name: payload.customer || (customer ? customer.name : 'ওয়েবসাইট কাস্টমার'),
    product: productSummary, qty, price,
    status: 'Pending', source: 'Bazaar Admin',
    address: payload.address || '', email: payload.email || '',
    payment: payload.payment || '', transactionId: payload.transactionId || '',
    createdAt: payload.date ? new Date(payload.date).toISOString() : new Date().toISOString()
  };
  await db.collection('orders').insertOne(order);
  return stripId(order);
}

async function updateOrderStatus(id, status) {
  const db = await getDb();
  const col = db.collection('orders');
  await col.updateOne({ id }, { $set: { status } });
  return stripId(await col.findOne({ id }));
}

/* ---------- Broadcasts ---------- */
async function addBroadcast(record) {
  const db = await getDb();
  const withDate = { ...record, createdAt: new Date().toISOString() };
  await db.collection('broadcasts').insertOne(withDate);
  return stripId(withDate);
}

async function getBroadcasts() {
  const db = await getDb();
  const list = await db.collection('broadcasts').find().sort({ createdAt: -1 }).toArray();
  return list.map(stripId);
}

/* ---------- Email Logs ---------- */
async function addEmailLog(entry) {
  const db = await getDb();
  const withDate = { ...entry, createdAt: new Date().toISOString() };
  await db.collection('emailLogs').insertOne(withDate);
  return stripId(withDate);
}

async function getEmailLogs() {
  const db = await getDb();
  const list = await db.collection('emailLogs').find().sort({ createdAt: -1 }).limit(200).toArray();
  return list.map(stripId);
}

module.exports = {
  getSettings, saveSettings,
  findOrCreateCustomer, getCustomers, setCustomerAI, updateCustomerContact,
  appendMessage, getConversation,
  createOrder, createWebsiteOrder, getOrders, getOrdersByCustomer, updateOrderStatus, attachEmailToLatestOrder,
  addBroadcast, getBroadcasts,
  addEmailLog, getEmailLogs
};
