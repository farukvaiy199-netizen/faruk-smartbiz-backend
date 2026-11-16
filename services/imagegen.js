// AI দিয়ে পোস্টের ছবি তৈরি — Gemini-র ছবি-মডেল (আপনার Gemini API Key থাকলে)। ফলাফল সবসময় JPEG করে ফেরত (Instagram শুধু JPEG নেয়)।
const axios = require('axios');
const { spawn } = require('child_process');
const { getSlots } = require('./ai');

const MODEL = 'gemini-2.5-flash-image';

function toJpeg(buf) {
  return new Promise((resolve, reject) => {
    let bin;
    try { bin = require('ffmpeg-static'); } catch (e) { return reject(new Error('ffmpeg নেই')); }
    if (!bin) return reject(new Error('ffmpeg নেই'));
    const p = spawn(bin, ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', 'pipe:1']);
    const out = []; let err = '';
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error('ছবি রূপান্তর ব্যর্থ: ' + err.slice(0, 100))));
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  });
}

function hasGemini(settings) { return getSlots(settings).some(s => s.provider === 'gemini'); }

const short = e => String(e && e.message || e).replace(/^ছবি তৈরি হয়নি: /, '').slice(0, 140);

async function viaGemini(slot, prompt, baseImage) {
  const parts = [{ text: String(prompt).slice(0, 1500) }];
  if (baseImage) parts.push({ inlineData: { mimeType: 'image/jpeg', data: baseImage.toString('base64') } });
  let res;
  try {
    res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${slot.apiKey}`,
      { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 });
  } catch (err) {
    const m = err.response && err.response.data && err.response.data.error && err.response.data.error.message;
    throw new Error(String(m || err.message).slice(0, 150));
  }
  const ps = (res.data.candidates && res.data.candidates[0] && res.data.candidates[0].content && res.data.candidates[0].content.parts) || [];
  const img = ps.find(p => (p.inlineData || p.inline_data));
  const d = img && (img.inlineData || img.inline_data);
  if (!d || !d.data) throw new Error('AI ছবি দেয়নি');
  return Buffer.from(d.data, 'base64');
}

// Together AI-র ফ্রি FLUX মডেল (Together-এর Key বসানো থাকলে)
async function viaTogether(slot, prompt) {
  try {
    const r = await axios.post('https://api.together.xyz/v1/images/generations',
      { model: 'black-forest-labs/FLUX.1-schnell-Free', prompt: String(prompt).slice(0, 1000), width: 1024, height: 1024, steps: 4, n: 1, response_format: 'b64_json' },
      { headers: { Authorization: 'Bearer ' + slot.apiKey, 'Content-Type': 'application/json' }, timeout: 60000 });
    const d = r.data && r.data.data && r.data.data[0];
    if (!d || !d.b64_json) throw new Error('ছবি আসেনি');
    return Buffer.from(d.b64_json, 'base64');
  } catch (err) {
    const m = err.response && err.response.data && (err.response.data.error && (err.response.data.error.message || err.response.data.error));
    throw new Error(String(m || err.message).slice(0, 150));
  }
}

// fal.ai — FLUX (fal.ai-র Key বসানো থাকলে; সাইনআপে কিছু ফ্রি ক্রেডিট দেয়)
async function viaFal(slot, prompt) {
  const model = String(slot.model || 'fal-ai/flux/schnell').replace(/^\/+|\/+$/g, '');
  try {
    const r = await axios.post('https://fal.run/' + model, { prompt: String(prompt).slice(0, 1000), image_size: 'square_hd', num_images: 1 },
      { headers: { Authorization: 'Key ' + slot.apiKey, 'Content-Type': 'application/json' }, timeout: 60000 });
    const img = r.data && r.data.images && r.data.images[0];
    if (!img || !img.url) throw new Error('ছবি আসেনি');
    const dl = await axios.get(img.url, { responseType: 'arraybuffer', timeout: 30000, maxContentLength: 12 * 1024 * 1024 });
    return Buffer.from(dl.data);
  } catch (err) {
    const d = err.response && err.response.data;
    const m = d && (d.detail && (typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail)) || d.message || d.error);
    throw new Error(String(m || err.message).slice(0, 150));
  }
}

// Pollinations — Key ছাড়া বিনামূল্যে ছবি (FLUX)। শুধু বর্ণনা থেকে বানায়।
async function viaPollinations(prompt) {
  const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(String(prompt).slice(0, 800))
    + '?width=1024&height=1024&nologo=true&model=flux&seed=' + Math.floor(Math.random() * 1e6);
  try {
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 70000, maxContentLength: 12 * 1024 * 1024 });
    const ct = String(r.headers['content-type'] || '');
    if (!/^image\//.test(ct)) throw new Error('ছবির বদলে অন্য কিছু এসেছে');
    return Buffer.from(r.data);
  } catch (err) { throw new Error(String(err.message).slice(0, 150)); }
}

// baseImage থাকলে (Buffer) সেটা বদলে/সাজিয়ে নতুন ছবি বানায়; না থাকলে শুধু বর্ণনা থেকে।
// ক্রম: Gemini (Key + ছবির কোটা থাকলে) → fal.ai (Key থাকলে) → Together ফ্রি FLUX → Pollinations (Key লাগে না)
async function generateImage({ settings, prompt, baseImage }) {
  const slots = getSlots(settings, true);
  const fal = slots.find(s => s.provider === 'fal');
  const gem = slots.find(s => s.provider === 'gemini');
  const tog = slots.find(s => s.provider === 'together');
  const errors = [];
  const attempts = [];
  if (gem) attempts.push(['Gemini', () => viaGemini(gem, prompt, baseImage)]);
  if (fal && !baseImage) attempts.push(['fal.ai', () => viaFal(fal, prompt)]);
  if (!baseImage) {
    if (tog) attempts.push(['Together', () => viaTogether(tog, prompt)]);
    attempts.push(['Pollinations', () => viaPollinations(prompt)]);
  }
  // বর্ণনা থেকে নতুন ছবি বানাতে মান ও পরিষ্কার ছবির নির্দেশ জুড়ে দিই (মালিকের বর্ণনা অক্ষত থাকে)
  if (!baseImage && !/photo|realistic|illustration|render|painting|style/i.test(prompt)) {
    prompt = String(prompt).trim() + ', professional product photography, soft natural light, sharp focus, high detail, clean composition';
  }
  if (!baseImage) prompt = String(prompt).trim() + ', no text, no watermark, no logo';
  for (const [name, run] of attempts) {
    try {
      const raw = await run();
      const jpg = await toJpeg(raw);
      jpg.source = name; jpg.failed = errors.slice(); // কোনটা থেকে এলো আর আগেরগুলো কেন ব্যর্থ
      return jpg;
    } catch (e) { errors.push(name + ': ' + short(e)); }
  }
  throw new Error('ছবি তৈরি হয়নি — ' + errors.join(' | '));
}

// ছবি ছোট করে (সর্বোচ্চ maxPx) JPEG বানায় — ওয়েবসাইটের ডেটাবেসে রাখার জন্য (১MB সীমার নিচে)
function shrinkJpeg(buf, maxPx = 900, q = 6) {
  return new Promise((resolve, reject) => {
    let bin;
    try { bin = require('ffmpeg-static'); } catch (e) { return reject(new Error('ffmpeg নেই')); }
    const p = spawn(bin, ['-v', 'error', '-i', 'pipe:0', '-vf', `scale='min(${maxPx},iw)':'min(${maxPx},ih)':force_original_aspect_ratio=decrease`, '-frames:v', '1', '-q:v', String(q), '-f', 'mjpeg', 'pipe:1']);
    const out = []; let err = '';
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error('ছবি ছোট করা যায়নি: ' + err.slice(0, 100))));
    p.stdin.on('error', () => {});
    p.stdin.end(buf);
  });
}

module.exports = { generateImage, hasGemini, shrinkJpeg };
