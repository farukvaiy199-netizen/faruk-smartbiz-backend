/* অর্ডার আইডি ও কাস্টমারের তথ্য — মালিকের Google Sheet-এ।
   শিটে আগে থেকে ধাপে ধাপে অর্ডার আইডি লেখা থাকে (ORD-1001, ORD-1002 …); ওয়েবসাইট বা AI যে অর্ডারই নিক,
   শিটের "প্রথম ফাঁকা ঘরের" আইডিটা নেয় এবং ঐ সারিতে তথ্য লিখে দেয়। ফলে আইডি কখনো দুবার বা এলোমেলো হয় না।
   শিটের Apps Script লিংক ORDER_SHEET_URL (আর গোপন কী ORDER_SHEET_KEY) নামে Render-এ বসাতে হয়। */
const axios = require('axios');

const enabled = () => !!process.env.ORDER_SHEET_URL;

async function call(body) {
  const r = await axios.post(process.env.ORDER_SHEET_URL, JSON.stringify(Object.assign({ key: process.env.ORDER_SHEET_KEY || '' }, body)), {
    timeout: 25000, maxRedirects: 5, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, validateStatus: s => s < 500
  });
  let d = r.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
  return d;
}

// ফাঁকা সারির আইডি নিয়ে সারিতে অর্ডারের তথ্য লেখে। ব্যর্থ হলে null (তখন ডাকার জায়গা নিজের ব্যবস্থা নেয়)।
async function claim(order) {
  if (!enabled()) return null;
  try {
    const d = await call({ action: 'claim', order });
    if (d && d.ok && d.id) return String(d.id);
    console.error('অর্ডার শিট: আইডি পাওয়া যায়নি —', d && d.error ? d.error : 'অজানা উত্তর');
  } catch (e) { console.error('অর্ডার শিটে সংযোগ হয়নি:', e.message); }
  return null;
}

// অর্ডার শেষ পর্যন্ত না হলে সারিটা আবার ফাঁকা করে দেয় (আইডিটা পরের অর্ডারের জন্য থেকে যায়)
async function release(id) {
  if (!enabled() || !id) return;
  try { await call({ action: 'release', id }); } catch (e) { console.error('অর্ডার শিট release ব্যর্থ:', e.message); }
}

// স্ট্যাটাস বদলালে শিটেও বদলায় (ঐচ্ছিক, ব্যর্থ হলে চুপচাপ)
async function setStatus(id, status) {
  if (!enabled() || !id) return;
  try { await call({ action: 'status', id, status }); } catch (e) {}
}

module.exports = { enabled, claim, release, setStatus };
