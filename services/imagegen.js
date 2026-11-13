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

// baseImage থাকলে (Buffer) সেটা বদলে/সাজিয়ে নতুন ছবি বানায়; না থাকলে শুধু বর্ণনা থেকে
async function generateImage({ settings, prompt, baseImage }) {
  const slot = getSlots(settings).find(s => s.provider === 'gemini');
  if (!slot) throw new Error('ছবি তৈরির জন্য Settings-এ একটা Gemini API Key লাগবে (Google AI Studio থেকে বিনামূল্যে পাওয়া যায়)');
  const parts = [{ text: String(prompt).slice(0, 1500) }];
  if (baseImage) parts.push({ inlineData: { mimeType: 'image/jpeg', data: baseImage.toString('base64') } });
  let res;
  try {
    res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${slot.apiKey}`,
      { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 });
  } catch (err) {
    const m = err.response && err.response.data && err.response.data.error && err.response.data.error.message;
    throw new Error('ছবি তৈরি হয়নি: ' + String(m || err.message).slice(0, 150));
  }
  const ps = (res.data.candidates && res.data.candidates[0] && res.data.candidates[0].content && res.data.candidates[0].content.parts) || [];
  const img = ps.find(p => (p.inlineData || p.inline_data));
  const d = img && (img.inlineData || img.inline_data);
  if (!d || !d.data) throw new Error('AI ছবি দেয়নি (এই Key-তে ছবি তৈরি চালু নাও থাকতে পারে)');
  return toJpeg(Buffer.from(d.data, 'base64'));
}

module.exports = { generateImage, hasGemini };
