const axios = require('axios');
const store = require('./store');

// প্রতিটা সফল AI কলের টোকেন ও অনুরোধ সংখ্যা গুনে রাখি, আর কোটা/অথ এরর হলে সেটাও মনে রাখি —
// ড্যাশবোর্ডের "AI" ট্যাবে এগুলো দেখানো হয়
function trackUsage(provider, tokens, headers) {
  store.addAiUsage(provider, tokens).catch(() => {});
  if (headers) {
    const rate = {};
    ['x-ratelimit-remaining-requests', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-tokens', 'x-ratelimit-limit-tokens']
      .forEach(k => { if (headers[k] !== undefined) rate[k] = String(headers[k]); });
    if (Object.keys(rate).length) store.setAiRateInfo(provider, rate).catch(() => {});
  }
}

function trackError(provider, err) {
  const status = err.response && err.response.status;
  if (status === 429 || status === 402 || status === 401 || status === 403) {
    const e = err.response.data && err.response.data.error;
    const msg = (e && (e.message || (typeof e === 'string' ? e : JSON.stringify(e)))) || err.message;
    store.setAiLastError(provider, `${status}: ${msg}`).catch(() => {});
  }
}

async function postTracked(provider, url, body, cfg) {
  let res;
  try {
    res = await axios.post(url, body, cfg);
  } catch (err) {
    trackError(provider, err);
    throw err;
  }
  const d = res.data || {};
  const tokens = (d.usage && d.usage.total_tokens) || (d.usageMetadata && d.usageMetadata.totalTokenCount) || 0;
  trackUsage(provider, tokens, res.headers);
  return res;
}

/* ---------- মডেলের নাম নিজে ঠিক করে নেওয়া ----------
   প্রোভাইডাররা পুরনো মডেল বন্ধ করে দেয় (যেমন gemini-2.0-flash)। তখন "মডেল নেই" ধরনের এরর এলে
   প্রোভাইডারের নিজের মডেল-তালিকা থেকে একটা চালু মডেল বেছে আবার চেষ্টা করি, আর মনে রাখি। */
const healed = new Map(); // "provider|পুরনো মডেল" -> চালু মডেল

function isModelError(err) {
  const st = err && err.response && err.response.status;
  if (st !== 404 && st !== 400) return false;
  const msg = JSON.stringify((err.response && err.response.data) || err.message || '').toLowerCase();
  return /model/.test(msg) && /(not found|no longer|does not exist|not exist|unsupported|deprecated|invalid model|not available|unavailable|decommission|retired|not supported)/.test(msg);
}

function isTimeout(err) { return !!err && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || /timeout/i.test(err.message || '')); }

function isOverloaded(err) {
  const st = err && err.response && err.response.status;
  const msg = JSON.stringify((err && err.response && err.response.data) || '').toLowerCase();
  return st === 503 || /high demand|overloaded|unavailable/.test(msg) && st !== 404 && st !== 400;
}

async function listModels(provider, apiKey, baseUrl) {
  if (provider === 'gemini') {
    const r = await axios.get('https://generativelanguage.googleapis.com/v1beta/models', { params: { key: apiKey, pageSize: 200 }, timeout: 10000 });
    return (r.data.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => String(m.name).replace(/^models\//, ''));
  }
  const ep = resolveEndpoint(provider, baseUrl).replace(/\/chat\/completions\/?$/, '');
  const r = await axios.get(ep + '/models', { headers: { Authorization: 'Bearer ' + apiKey }, timeout: 10000 });
  const arr = r.data.data || r.data.models || (Array.isArray(r.data) ? r.data : []);
  return arr.map(m => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
}

function pickModel(provider, ids, bad) {
  const skip = /embed|tts|audio|image|imagen|veo|whisper|guard|moderation|aqa|robotics|live|realtime|transcri|rerank|search|computer-use|learnlm/i;
  let pool = ids.filter(id => id !== bad && !skip.test(id));
  if (!pool.length) return '';
  if (provider === 'gemini') {
    if (pool.includes('gemini-flash-latest')) return 'gemini-flash-latest';
    const flash = pool.filter(id => /^gemini-[\d.]+-flash$/.test(id) || /^gemini-[\d.]+-flash-\d+$/.test(id));
    const ver = id => parseFloat((id.match(/^gemini-([\d.]+)/) || [0, 0])[1]) || 0;
    const list = (flash.length ? flash : pool.filter(id => /flash/.test(id) && !/lite|8b/.test(id))).sort((a, b) => ver(b) - ver(a));
    if (list.length) return list[0];
  }
  const cheap = pool.filter(id => /mini|small|flash|instant|haiku|versatile|lite|8b|turbo/i.test(id));
  return (cheap.length ? cheap : pool)[0];
}

async function heal(provider, apiKey, baseUrl, model, fn) {
  const start = healed.get(provider + '|' + model) || model;
  try {
    return await fn(start);
  } catch (err) {
    // সার্ভার সাময়িক ব্যস্ত (503) — একটু থেমে আবার; তাতেও না হলে Gemini-র হালকা মডেলে একবার
    if (isTimeout(err) && provider === 'gemini' && !/lite/.test(start)) {
      return await fn('gemini-flash-lite-latest'); // ধীর/ব্যস্ত — হালকা ও দ্রুত মডেলে সরাসরি
    }
    if (isOverloaded(err)) {
      await new Promise(r => setTimeout(r, 1500));
      try { return await fn(start); } catch (e2) {
        if (!isOverloaded(e2) || provider !== 'gemini') throw e2;
        return await fn('gemini-flash-lite-latest');
      }
    }
    if (!isModelError(err)) throw err;
    let ids;
    try { ids = await listModels(provider, apiKey, baseUrl); } catch (e) { throw err; }
    const next = pickModel(provider, ids, start);
    if (!next) throw err;
    console.log(`AI মডেল বদলানো হলো (${provider}): ${start} → ${next}`);
    healed.set(provider + '|' + model, next);
    return await fn(next);
  }
}

const ENDPOINTS = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  // ফ্রি টোকেন দেয় এমন আরও কিছু AI (সবই OpenAI-র মতো chat/completions)
  cerebras: 'https://api.cerebras.ai/v1/chat/completions',
  sambanova: 'https://api.sambanova.ai/v1/chat/completions',
  nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
  github: 'https://models.github.ai/inference/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/chat/completions',
  xai: 'https://api.x.ai/v1/chat/completions',
  together: 'https://api.together.xyz/v1/chat/completions'
  // gemini আলাদাভাবে হ্যান্ডেল হয়, নিচে দেখুন। "custom" এর ঠিকানা মালিক নিজে দেন।
};

const MODELS = {
  groq: 'llama-3.3-70b-versatile',
  openai: 'gpt-4o-mini',
  openrouter: 'openai/gpt-4o-mini',
  gemini: 'gemini-flash-latest',
  deepseek: 'deepseek-chat',
  mistral: 'mistral-small-latest',
  // মডেলের নাম প্রোভাইডাররা মাঝে মাঝে বদলায় — ডিফল্ট কাজ না করলে অ্যাপে মডেলের নাম নিজে বসিয়ে "টেস্ট" চাপুন
  cerebras: 'llama3.1-8b',
  sambanova: 'Meta-Llama-3.3-70B-Instruct',
  nvidia: 'meta/llama-3.3-70b-instruct',
  github: 'openai/gpt-4o-mini',
  anthropic: 'claude-haiku-5-5',
  xai: 'grok-4',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo'
};
const EXTRA_PROVIDERS = new Set(['cerebras', 'sambanova', 'nvidia', 'github', 'anthropic', 'xai', 'together']);
const MAX_SLOTS = 8;

// সেটিংসে আটটা AI Key-র ঘর আছে (aiKey, aiKey2 … aiKey8)। যেগুলোতে Key বসানো আছে সেগুলো ক্রমানুসারে সাজিয়ে দেয়।
// প্রতিটা ঘরে প্রোভাইডার, ঐচ্ছিক মডেলের নাম আর (custom হলে) Base URL থাকে।
function getSlots(settings, includeImageOnly = false) {
  const slots = [];
  for (const sfx of ['', ...Array.from({ length: MAX_SLOTS - 1 }, (_, i) => String(i + 2))]) {
    const apiKey = settings['aiKey' + sfx];
    if (!apiKey) continue;
    if (!includeImageOnly && settings['aiProvider' + sfx] === 'fal') continue; // fal.ai শুধু ছবির জন্য, চ্যাটে নয়
    slots.push({
      apiKey,
      provider: settings['aiProvider' + sfx] || 'groq',
      model: (settings['aiModel' + sfx] || '').trim(),
      baseUrl: (settings['aiBaseUrl' + sfx] || '').trim()
    });
  }
  return slots;
}

// ক্রমানুসারে প্রতিটা ঘর চেষ্টা করে — একটা কোটা/রেট-লিমিট/এররে আটকালে পরেরটা।
// যে ঘর সম্প্রতি আটকেছে সেটা কিছুক্ষণ বিশ্রামে (cooldown) থাকে, যাতে প্রতিটা মেসেজে আবার আটকে সময় নষ্ট না হয়।
const slotCooldown = new Map(); // key -> ফেরত চালু হওয়ার সময় (ms)
const slotKey = s => `${s.provider}|${s.model || ''}|${String(s.apiKey || '').slice(-8)}`;
function cooldownFor(err) {
  const st = err && err.response && err.response.status;
  const txt = JSON.stringify((err && err.response && err.response.data) || '') + ' ' + ((err && err.message) || '');
  if (st === 401 || st === 403) return 30 * 60000;            // Key ভুল/অনুমতি নেই
  if (st === 402 || /quota|exceeded|insufficient|billing|daily/i.test(txt)) return 10 * 60000; // দৈনিক/টাকার সীমা
  if (st === 429) return 60000;                                // সাময়িক রেট-লিমিট
  if (st >= 500) return 30000;
  return 0;
}
async function withSlots(settings, fn) {
  const all = getSlots(settings);
  if (!all.length) throw new Error('কোনো AI Key সংযুক্ত নেই');
  const now = Date.now();
  const ready = all.filter(sl => (slotCooldown.get(slotKey(sl)) || 0) <= now);
  const slots = ready.length ? ready : all; // সবই বিশ্রামে থাকলে তবু সবগুলো চেষ্টা করি
  let lastErr;
  for (let i = 0; i < slots.length; i++) {
    try {
      return await fn(slots[i]);
    } catch (err) {
      lastErr = err;
      const cd = cooldownFor(err);
      if (cd) slotCooldown.set(slotKey(slots[i]), Date.now() + cd);
      const more = i < slots.length - 1;
      console.warn(`AI Key (${slots[i].provider}) ব্যর্থ: ${(err.response && err.response.status) || ''} ${err.message}${cd ? ` — ${Math.round(cd / 1000)} সেকেন্ড বিশ্রামে` : ''}${more ? ' — পরের Key চেষ্টা করা হচ্ছে' : ''}`);
    }
  }
  throw lastErr;
}

function resolveEndpoint(provider, baseUrl) {
  if (provider === 'custom') {
    let u = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!u) throw new Error('Custom AI-র Base URL দেওয়া নেই');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    if (!/\/chat\/completions$/.test(u)) u += '/chat/completions';
    return u;
  }
  return ENDPOINTS[provider] || ENDPOINTS.groq;
}

// ছবি বোঝার (vision) ক্ষমতা শুধু এই প্রোভাইডারগুলোর আছে — Groq-এর টেক্সট মডেল ছবি দেখতে পারে না
function isVisionCapable(provider) {
  return provider === 'openai' || provider === 'openrouter' || provider === 'gemini';
}

/**
 * কাস্টমারের মেসেজ পড়ে AI দিয়ে রিপ্লাই বানায়।
 * AI কে বলা হয় JSON আকারে ফেরত দিতে: { reply, order }
 */
async function getAIReply({ apiKey, provider = 'groq', model = '', baseUrl = '', customerMessage, history = [], sheetContext = '', businessInfo = '', ownerRules = [], ownerImages = [], stockList = [], shopContext = '', customerMemory = '' }) {
  // অ্যাপের স্টক পেজ থেকে মালিকের বসানো বর্তমান স্টক — এটাই সবচেয়ে নির্ভরযোগ্য
  const stockBlock = stockList.length
    ? `\n=== বর্তমান স্টক (অ্যাপ থেকে, সবচেয়ে নির্ভরযোগ্য) ===\nনিচের তালিকায় যে প্রোডাক্ট আছে তার স্টক শুধু এখান থেকে বলবে (শিটের Stock কলামের চেয়ে এটা বেশি সঠিক)। ০ হলে "স্টকে নেই" বলবে, আর অর্ডার নেবে না:\n${stockList.map(e => `- ${e.name}: ${e.qty > 0 ? e.qty + 'টি আছে' : 'স্টক শেষ'}`).join('\n')}\n`
    : '';
  // দোকান মালিক অ্যাপের "AI শেখান" ট্যাব থেকে যেসব নির্দেশনা দিয়েছেন — সর্বোচ্চ অগ্রাধিকার
  const rulesBlock = ownerRules.length
    ? `\n=== দোকান মালিকের সরাসরি নির্দেশনা (সর্বোচ্চ অগ্রাধিকার) ===\nনিচের নির্দেশনাগুলো দোকান মালিক নিজে দিয়েছেন। এগুলো শিটের তথ্য এবং আগের কথোপকথনে দেওয়া পুরনো উত্তরের চেয়েও বেশি গুরুত্বপূর্ণ — কোনো বিরোধ থাকলে এগুলোই মানবে:\n${ownerRules.map((r, i) => `${i + 1}) ${r}`).join('\n')}\n`
    : '';
  // মালিক যেসব প্রোডাক্টের ছবি আপলোড করেছেন — কাস্টমার ছবি চাইলে এখান থেকে পাঠানো হবে
  const imagesBlock = ownerImages.length
    ? `\n=== মালিকের আপলোড করা প্রোডাক্ট ছবি ===\nকাস্টমার কোনো প্রোডাক্টের ছবি দেখতে চাইলে নিচের তালিকায় মিল থাকলে সেই ছবির ID "imageId"-তে বসাবে। ছবি সিস্টেম নিজেই পাঠিয়ে দেবে, তুমি কোনো লিংক বানাবে না:\n${ownerImages.map(i => `- ID: ${i.id} → ${i.label}`).join('\n')}\n`
    : '';
  const systemPrompt = `
তুমি "Faruk's SmartBiz" নামের একটা অনলাইন দোকানের কাস্টমার সাপোর্ট সহকারী।
বাংলায়, সংক্ষেপে উত্তর দাও।
${businessInfo ? 'দোকানের তথ্য:\n' + businessInfo : ''}
${sheetContext ? sheetContext : ''}
${rulesBlock}${imagesBlock}${stockBlock}${shopContext}${customerMemory ? `
=== এই কাস্টমার সম্পর্কে আগের স্মৃতি (আগের কথোপকথন ও অর্ডার থেকে) ===
${customerMemory}
এই তথ্য মনে রেখে কথা বলবে — যা আগেই জানা (নাম, ঠিকানা, পছন্দ, আগের অর্ডার) তা আবার জিজ্ঞেস করবে না; বরং "আগের ঠিকানাতেই পাঠাব?" ধরনের স্বাভাবিক কথা বলবে। স্মৃতিতে ভুল মনে হলে কাস্টমারের নতুন কথাই মানবে।
` : ''}
=== স্টক ও প্রাপ্যতা ===
কোনো প্রোডাক্ট আছে কি নেই — এটা শুধু বর্তমান শিটের তথ্য, ওয়েবসাইটের লাইভ তথ্য (থাকলে) আর মালিকের নির্দেশনা দেখে বলবে। আগের কথোপকথনে তুমি বা অন্য কেউ "স্টকে নেই" বলে থাকলেও সেটা পুরনো হতে পারে, তাই সেটার উপর ভরসা করে আবার "নেই" বলবে না।

=== ব্যবহার ও ভদ্রতা ===
- সবসময় নম্র, ভদ্র ও আন্তরিকভাবে কথা বলবে, কখনো রূঢ় বা তাড়াহুড়ার সুরে না।
- কাস্টমারের নাম/লেখার ধরন থেকে ছেলে/মেয়ে বোঝা গেলে সেভাবে সম্বোধন করবে —
  ছেলে হলে "ভাইয়া", মেয়ে হলে "আপু"। বোঝা না গেলে নিরপেক্ষভাবে সম্মানসূচক ভাষায় (আপনি/জি)।
- ধন্যবাদ, দোয়া, সালামের জবাব — এসব স্বাভাবিক সৌজন্যতা বজায় রাখবে।

=== সক্রিয়ভাবে কথা বলা (খুবই গুরুত্বপূর্ণ) ===
তুমি শুধু প্রশ্নের যান্ত্রিক উত্তরদাতা না, একজন সক্রিয় ও আন্তরিক বিক্রয়কর্মীর মতো আচরণ করবে।
- কাস্টমার যদি শুধু "সালাম", "আসসালামু আলাইকুম", "হাই", "হ্যালো", "কেমন আছেন" এই ধরনের
  সাধারণ শুভেচ্ছা দিয়ে কথা শুরু করে (এখনো কোনো প্রোডাক্ট/অর্ডারের কথা না বলে), তাহলে শুধু
  সালামের জবাব দিয়েই থেমে যাবে না — সাথে সাথেই আন্তরিকভাবে জিজ্ঞেস করবে সে কী খুঁজছে বা
  তাকে কীভাবে সাহায্য করা যায়। উপরে প্রোডাক্টের তথ্য থাকলে ২-৩টা প্রোডাক্টের নাম উদাহরণ
  হিসেবে বলতে পারো, যাতে কথোপকথন এগিয়ে যায়।
  উদাহরণ: "ওয়ালাইকুম আসসালাম ভাইয়া! স্বাগতম আমাদের দোকানে 😊 আপনি কী ধরনের প্রোডাক্ট
  খুঁজছেন, বলুন তো একটু সাহায্য করি।"
- কাস্টমার কোনো প্রোডাক্টে আগ্রহ দেখালে শুধু দাম/তথ্য বলেই থেমো না — প্রাসঙ্গিক হলে
  কালার/সাইজ/পরিমাণের মতো যা জানা দরকার সেটা জিজ্ঞেস করবে।
- কখনো একটা শুকনো/ছোট জবাব দিয়ে চুপ করে থাকবে না — অর্ডার নিশ্চিত না হওয়া পর্যন্ত বা
  কাস্টমার নিজে কথা শেষ না করা পর্যন্ত, প্রতিটা রিপ্লাইয়ের শেষে কথোপকথন এগিয়ে নেওয়ার
  মতো একটা প্রশ্ন বা প্রস্তাব জুড়ে দেবে।

=== জটিল/অজানা প্রশ্নের ক্ষেত্রে ===
প্রশ্নটা দোকানের তথ্য দিয়ে উত্তর দেওয়া সম্ভব না হলে, বা জটিল/স্পর্শকাতর বিষয় (রিফান্ড
বিরোধ, ক্ষতিগ্রস্ত প্রোডাক্ট, বিশেষ অনুরোধ) হলে, অনুমান করে উত্তর না দিয়ে ভদ্রভাবে বলবে
সরাসরি সাপোর্ট প্রতিনিধির সাথে কথা বলতে, নাম্বার: 01792872209

=== মালিকের সাহায্য দরকার হলে (handoff) ===
শুধু এই ক্ষেত্রগুলোতে "handoff"-এ ছোট একটা কারণ লিখবে (যেমন "রিফান্ড চাইছে", "ক্ষতিগ্রস্ত পণ্য নিয়ে রাগ করছে", "মানুষের সাথে কথা চায়", "উত্তর জানি না"):
- কাস্টমার রেগে আছে বা অভিযোগ করছে, রিফান্ড/ফেরত/ক্ষতিগ্রস্ত বা ভুল পণ্য নিয়ে কথা বলছে
- কাস্টমার স্পষ্টভাবে মানুষের সাথে কথা বলতে চাইছে
- প্রশ্নের উত্তর শিট, স্টক বা মালিকের নির্দেশনায় নেই এবং অনুমান করা ঠিক হবে না
এসব ক্ষেত্রে reply-তে ভদ্রভাবে জানাবে যে আমাদের প্রতিনিধি শীঘ্রই কথা বলবেন, আর সাপোর্ট নাম্বার দেবে। সমস্যাটা নিজে মেটানোর চেষ্টা করবে না।
দাম, ডেলিভারি, স্টক, অর্ডারের মতো সাধারণ প্রশ্নে কখনো handoff দেবে না — অকারণে দিলে মালিককে বিরক্ত করা হয়।

=== অর্ডার নেওয়ার নিয়ম (কঠোরভাবে মানতে হবে) ===
[ওয়েবসাইটের তথ্যের মধ্যে "অর্ডার নেওয়ার নীতি" থাকলে আগে সেটা মানবে — কাস্টমার এখানে অর্ডার দিতে চাইলে তবেই নিচের নিয়ম প্রযোজ্য]
১) কাস্টমার যা টাইপ করে পাঠায় তা হুবহু (word-for-word) কপি করে "order" এ বসাবে —
   নাম/ফোন/ঠিকানা কখনো অনুবাদ/সংক্ষেপ/অনুমান করবে না।
২) কখনোই কোনো তথ্য নিজে থেকে অনুমান করে বসাবে না। কাস্টমার স্পষ্ট না বললে সেই ফিল্ড খালি থাকবে।
৩) অর্ডার নিশ্চিত করার আগে এই ৪টা তথ্য একটার পর একটা (এক মেসেজে সব না চেয়ে) জেনে নেবে:
   পুরো নাম, মোবাইল নাম্বার, ডেলিভারি ঠিকানা, প্রোডাক্টের নাম ও পরিমাণ (qty)।
৪) এর মধ্যে কোনো একটা এখনো না পাওয়া গেলে "order" null রাখবে, reply-তে বাকি থাকা
   তথ্যটাই জিজ্ঞেস করবে (একসাথে সব না চেয়ে)।
৫) চারটাই পাওয়া গেলে হুবহু বসিয়ে "order" পূরণ করবে, reply-তে সারাংশ দেখিয়ে কনফার্ম করবে।
   এই একই কনফার্মেশন মেসেজের শেষে একবার ভদ্রভাবে জিজ্ঞেস করবে: "চাইলে আপনার ইমেইল
   ঠিকানাটা দিতে পারেন, কনফার্মেশনের একটা কপি ইমেইলেও পাঠিয়ে দেব।" — এটা সম্পূর্ণ ঐচ্ছিক,
   শুধু একবারই জিজ্ঞেস করবে; কাস্টমার উত্তর না দিলে, এড়িয়ে গেলে, বা "লাগবে না" বললে আর
   কখনো এই নিয়ে চাপাচাপি করবে না — অর্ডার এমনিতেই কনফার্ম হয়ে গেছে বলে ধরে নেবে।
৬) কাস্টমার যদি কথোপকথনে কখনো নিজে থেকেই বা জিজ্ঞেস করার পর একটা ইমেইল ঠিকানা দেয়,
   সেটা হুবহু "order" এর "email" ফিল্ডে বসাবে, না দিলে null রাখবে।
৭) [অত্যন্ত গুরুত্বপূর্ণ, ডুপ্লিকেট অর্ডার ঠেকাতে] কথোপকথনের আগের কোনো reply-তে যদি
   ইতিমধ্যে "✅"/"কনফার্ম হয়েছে" জাতীয় কিছু দিয়ে এই একই প্রোডাক্ট/অর্ডার একবার কনফার্ম করে
   ফেলা হয়ে থাকে, তাহলে কাস্টমার এখন নতুন করে ভিন্ন প্রোডাক্ট বা নতুন পরিমাণ স্পষ্টভাবে না
   চাইলে "order" অবশ্যই null রাখবে — সালাম, ধন্যবাদ, প্রশ্ন, বা অন্য যেকোনো সাধারণ মেসেজে
   আগের অর্ডারটা আবার তৈরি/কনফার্ম করবে না। শুধু কাস্টমার স্পষ্টভাবে নতুন প্রোডাক্ট/পরিমাণ
   অর্ডার করতে চাইলে তবেই নতুন "order" object পূরণ করবে।
৮) কাস্টমার যদি অর্ডার কনফার্ম হয়ে যাওয়ার পরে (নতুন করে প্রোডাক্ট/অর্ডারের কথা না বলে)
   শুধু একটা ইমেইল ঠিকানা পাঠায় (যেমন শুধু "example@gmail.com" টাইপের কিছু), তাহলে সেটা
   আগের অর্ডারের জন্যই ইমেইল দিচ্ছে ধরে নেবে। এই ক্ষেত্রে "order" এ শুধু
   {"emailOnly": true, "email": "সেই ইমেইল হুবহু"} বসাবে।

=== প্রোডাক্টের ছবি পাঠানো ===
কাস্টমার প্রোডাক্টের ছবি চাইলে, প্রথমে মালিকের আপলোড করা ছবির তালিকা (থাকলে) দেখবে — মিল পেলে "imageId" বসাবে। না পেলে শিটের তথ্যে সেই প্রোডাক্টের সারিতে ছবি-সংক্রান্ত কলামে
(নামে "image"/"photo"/"picture"/"ছবি" থাকা যেকোনো কলাম) লিংক থাকলে হুবহু কপি করে
"imageUrl" এ বসাবে। নিজে থেকে লিংক বানাবে না। না পেলে "imageUrl" null রেখে ভদ্রভাবে জানাবে।

শুধুমাত্র নিচের JSON ফরম্যাটে উত্তর দাও, অন্য কিছু লিখো না:
{
  "reply": "কাস্টমারকে পাঠানোর মেসেজ",
  "imageUrl": null অথবা "শিট থেকে পাওয়া হুবহু ছবির লিংক",
  "imageId": null অথবা "মালিকের ছবির তালিকা থেকে হুবহু ID",
  "shopProductId": null অথবা "ওয়েবসাইটের প্রোডাক্ট-তালিকার [ID] থেকে হুবহু ID (শুধু ছবি পাঠাতে)",
  "handoff": null অথবা "মালিকের সাহায্য কেন দরকার তার ছোট কারণ",
  "order": null, অথবা {
    "name": "কাস্টমার হুবহু যা লিখেছে",
    "phone": "কাস্টমার হুবহু যা লিখেছে",
    "address": "কাস্টমার হুবহু যা লিখেছে",
    "product": "প্রোডাক্টের নাম",
    "qty": সংখ্যা,
    "price": সংখ্যা,
    "email": null অথবা "কাস্টমার দিলে হুবহু ইমেইল",
    "district": null অথবা "কাস্টমারের জেলা (বাংলায়) — ডেলিভারি ও পেমেন্টের নিয়ম থাকলে অবশ্যই",
    "payment": null অথবা "cod" / "bkash" / "nagad",
    "transactionId": null অথবা "অগ্রিম পেমেন্টের TrxID হুবহু"
  }, অথবা (আগে কনফার্ম হওয়া অর্ডারে পরে শুধু ইমেইল যোগ করার ক্ষেত্রে) {
    "emailOnly": true,
    "email": "কাস্টমার হুবহু যা লিখেছে"
  }
}
`.trim();

  if (provider === 'gemini') {
    return getGeminiReply({ apiKey, model, systemPrompt, customerMessage, history });
  }
  return getOpenAiCompatibleReply({ apiKey, provider, model, baseUrl, systemPrompt, customerMessage, history });
}

// প্রধান AI Key ব্যর্থ হলে (rate limit/quota/এরর) স্বয়ংক্রিয়ভাবে পরের ঘরের Key দিয়ে আবার চেষ্টা করে
async function getAIReplyWithFallback({ settings, customerMessage, history, sheetContext, businessInfo, ownerRules = [], ownerImages = [], stockList = [], shopContext = '', customerMemory = '' }) {
  return withSlots(settings, (slot) => getAIReply({
    ...slot, customerMessage, history, sheetContext, businessInfo, ownerRules, ownerImages, stockList, shopContext, customerMemory
  }));
}

/* ---------- ছবি দেখে প্রোডাক্ট মেলানো (নতুন) ---------- */
async function getVisionReply(args) {
  const base = args.provider === 'gemini' ? MODELS.gemini : (args.provider === 'openrouter' ? MODELS.openrouter : MODELS.openai);
  return heal(args.provider, args.apiKey, '', base, m => visionCall({ ...args, _model: m }));
}
async function visionCall({ apiKey, provider, imageBase64, mimeType, sheetContext = '', businessInfo = '', _model }) {
  const visionPrompt = `
তুমি "Faruk's SmartBiz" দোকানের সহকারী। কাস্টমার একটা প্রোডাক্টের ছবি পাঠিয়েছে।
${businessInfo ? 'দোকানের তথ্য:\n' + businessInfo : ''}
${sheetContext || 'দোকানের কোনো প্রোডাক্ট শিট সংযুক্ত নেই।'}

ছবিটা ভালোভাবে দেখে উপরের শিটের প্রোডাক্টগুলোর সাথে মেলাও।
- ছবিটা শিটের কোনো প্রোডাক্টের সাথে স্পষ্টভাবে মিললে, সেই প্রোডাক্টের নাম, দাম ও সংক্ষিপ্ত
  বিবরণ বলবে।
- ছবিটা অস্পষ্ট, ভুয়া, বা শিটের কোনো প্রোডাক্টের সাথে না মিললে, ভদ্রভাবে স্পষ্ট করে বলবে
  "এই প্রোডাক্টটি আমাদের কাছে নেই" — নিজে থেকে দাম/তথ্য বানিয়ে বলবে না।
- নিশ্চিত না হলে অতি-আত্মবিশ্বাসী হয়ে অনুমান করবে না, বরং কাস্টমারকে প্রোডাক্টের নাম
  লিখে জানাতে বলবে।

শুধু নিচের JSON ফরম্যাটে উত্তর দাও:
{ "reply": "কাস্টমারকে পাঠানোর মেসেজ", "matched": true অথবা false }
`.trim();

  if (provider === 'gemini') {
    const model = _model;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const res = await postTracked('gemini', endpoint, {
      contents: [{
        role: 'user',
        parts: [
          { text: visionPrompt },
          { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } }
        ]
      }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
    const raw = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    return parseAIJson(raw);
  }

  const endpoint = ENDPOINTS[provider] || ENDPOINTS.openai;
  const model = _model;
  const res = await postTracked(provider, endpoint, {
    model,
    messages: [
      { role: 'system', content: visionPrompt },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` } }
      ] }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 20000 });

  const raw = res.data.choices?.[0]?.message?.content || '{}';
  return parseAIJson(raw);
}

/* ---------- Groq / OpenAI / OpenRouter / DeepSeek / Mistral / Custom (একই ফরম্যাট) ---------- */
async function getOpenAiCompatibleReply(args) {
  const useModel = args.model || MODELS[args.provider] || (args.provider === 'custom' ? '' : MODELS.groq);
  if (!useModel) throw new Error('Custom AI-র মডেলের নাম দেওয়া নেই');
  return heal(args.provider, args.apiKey, args.baseUrl, useModel, m => openAiCompatibleCall({ ...args, model: m }));
}
async function openAiCompatibleCall({ apiKey, provider, model = '', baseUrl = '', systemPrompt, customerMessage, history, rawJson = false }) {
  const endpoint = resolveEndpoint(provider, baseUrl);
  const useModel = model;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text })),
    { role: 'user', content: customerMessage }
  ];

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://smartbiz.local';
    headers['X-Title'] = "Faruk's SmartBiz";
  }

  const body = { model: useModel, messages, temperature: 0.15, response_format: { type: 'json_object' } };
  // OpenRouter ডিফল্টে অনেক বড় max_tokens ধরে নেয় — ক্রেডিট কম থাকলে 402 দেয়। উত্তর ছোট, তাই সীমা বেঁধে দিই
  if (provider === 'openrouter') body.max_tokens = 1500;
  let res;
  try {
    res = await postTracked(provider, endpoint, body, { headers, timeout: 20000 });
  } catch (err) {
    // কাস্টম/নতুন প্রোভাইডার অনেক সময় response_format বোঝে না (400) — ওটা ছাড়া আরেকবার চেষ্টা
    if ((provider === 'custom' || EXTRA_PROVIDERS.has(provider)) && err.response && err.response.status === 400) {
      const { response_format, ...plain } = body;
      res = await postTracked(provider, endpoint, plain, { headers, timeout: 20000 });
    } else {
      throw err;
    }
  }

  const raw = (res.data.choices && res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content) || '{}';
  return rawJson ? parseRawJson(raw) : parseAIJson(raw);
}

/* ---------- Google Gemini (আলাদা ফরম্যাট) ---------- */
async function getGeminiReply(args) {
  return heal('gemini', args.apiKey, '', args.model || MODELS.gemini, m => geminiCall({ ...args, model: m }));
}
async function geminiCall({ apiKey, model, systemPrompt, customerMessage, history, rawJson = false }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contents = [
    ...history.map(h => ({
      role: h.role === 'user' ? 'user' : 'model',
      parts: [{ text: h.text }]
    })),
    { role: 'user', parts: [{ text: customerMessage }] }
  ];

  const res = await postTracked('gemini', 
    endpoint,
    {
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.15, responseMimeType: 'application/json' }
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 12000 }
  );

  const raw = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return rawJson ? parseRawJson(raw) : parseAIJson(raw);
}

// কাস্টমার-চ্যাটের বাইরের কাজের জন্য (যেমন পোস্টের খসড়া): JSON যেমন আছে তেমনই ফেরত দেয়
function parseRawJson(raw) {
  try { return JSON.parse(raw); } catch (e) {}
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return {};
}

async function getJsonReply({ settings, systemPrompt, userMessage }) {
  return withSlots(settings, (slot) => slot.provider === 'gemini'
    ? getGeminiReply({ apiKey: slot.apiKey, model: slot.model, systemPrompt, customerMessage: userMessage, history: [], rawJson: true })
    : getOpenAiCompatibleReply({ ...slot, systemPrompt, customerMessage: userMessage, history: [], rawJson: true }));
}

function parseAIJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // কিছু AI JSON-এর আগে-পরে অতিরিক্ত লেখা বা ```json বসায় — ভেতরের { ... } অংশটা তুলে নিই
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; } }
    if (!parsed) parsed = { reply: raw, order: null };
  }
  return {
    reply: parsed.reply || 'দুঃখিত, একটু পরে আবার চেষ্টা করুন।',
    imageUrl: parsed.imageUrl || null,
    order: parsed.order || null,
    rule: parsed.rule || null,
    imageId: parsed.imageId || null,
    shopProductId: parsed.shopProductId || null,
    handoff: parsed.handoff || null,
    imageLabel: parsed.imageLabel || null
  };
}

/* ---------- মালিকের সাথে কথা বলে নির্দেশনা শেখা (নতুন) ---------- */
async function getOwnerChatReply({ settings, message, history = [], rules = [], hasImage = false }) {
  const systemPrompt = `
তুমি "Faruk's SmartBiz"-এর সহকারী। এখন যিনি কথা বলছেন তিনি দোকানের মালিক, কাস্টমার না।
মালিক তোমাকে শেখাচ্ছেন কাস্টমারদের সাথে কথা বলার সময় কী করতে বা বলতে হবে — যেমন কোন প্রোডাক্ট এখন স্টকে আছে বা নেই, নির্দিষ্ট প্রশ্নের কী জবাব দেবে, অফার, ডেলিভারির নিয়ম ইত্যাদি।

এখন পর্যন্ত সংরক্ষিত নির্দেশনা:
${rules.length ? rules.map((r, i) => `${i + 1}) ${r.text}`).join('\n') : '(এখনো কোনোটা নেই)'}

তোমার কাজ:
- মালিকের মেসেজে নতুন নির্দেশনা বা তথ্য থাকলে সেটাকে পরিষ্কার, সংক্ষিপ্ত একটা নিয়ম হিসেবে বাংলায় লিখে "rule"-এ দাও, যেন কাস্টমারের সাথে কথা বলার সময় AI সরাসরি মানতে পারে (যেমন: "পিউর সুন্দরবন মধু ১কেজি এখন স্টকে আছে, কাস্টমার চাইলে অর্ডার নিন")। মালিক যা বলেননি তা যোগ করবে না, দাম বা সংখ্যা নিজে থেকে বানাবে না।
- "reply"-তে মালিককে সংক্ষেপে জানাও কী সংরক্ষণ করলে।
- মেসেজ অস্পষ্ট হলে, শুধু প্রশ্ন হলে, বা নির্দেশনা না হয়ে সাধারণ কথা হলে "rule" null রাখো এবং "reply"-তে ভদ্রভাবে উত্তর দাও বা স্পষ্ট করে জিজ্ঞেস করো।
- মালিক আগের কোনো নির্দেশনা বদলাতে বা বাতিল করতে চাইলে তুমি নিজে মুছতে পারো না। "reply"-তে বলো নিচের তালিকায় ওটার পাশের "মুছুন" বাটনে চাপতে, তারপর নতুনটা বলতে। এ ক্ষেত্রে "rule" null।

${hasImage ? `
এই মেসেজের সাথে মালিক একটা ছবি সংযুক্ত করেছেন। তুমি ছবিটা দেখতে পাচ্ছ না, মালিকের লেখা থেকে বুঝবে ওটা কোন প্রোডাক্টের ছবি।
- লেখায় প্রোডাক্টের নাম স্পষ্ট থাকলে "imageLabel"-এ ছোট একটা নাম দাও (যেমন "পিউর সুন্দরবন মধু ১কেজি")। এতে ছবিটা সংরক্ষিত হবে, আর কাস্টমার ছবি চাইলে AI এটাই পাঠাবে।
- স্পষ্ট না হলে "imageLabel" null রাখো আর "reply"-তে জিজ্ঞেস করো ছবিটা কোন প্রোডাক্টের।
- ছবির জন্য আলাদা করে "rule" বানানোর দরকার নেই, null রাখো।` : ''}

শুধুমাত্র এই JSON ফরম্যাটে উত্তর দাও: {"reply": "মালিককে বলার কথা", "rule": null অথবা "সংরক্ষণের নিয়ম"${hasImage ? ', "imageLabel": null অথবা "প্রোডাক্টের ছোট নাম"' : ''}}
`.trim();

  return withSlots(settings, (slot) => slot.provider === 'gemini'
    ? getGeminiReply({ apiKey: slot.apiKey, model: slot.model, systemPrompt, customerMessage: message, history })
    : getOpenAiCompatibleReply({ ...slot, systemPrompt, customerMessage: message, history }));
}

// কাস্টমারের স্মৃতি নতুন করে সংক্ষেপে লেখে (পুরনো স্মৃতি + সাম্প্রতিক কথোপকথন থেকে)
async function summarizeCustomerMemory({ settings, previous = '', history = [], orders = '' }) {
  const convo = history.slice(-20).map(h => `${h.role === 'user' ? 'কাস্টমার' : 'দোকান'}: ${String(h.text).slice(0, 200)}`).join('\n');
  const systemPrompt = `তুমি একটা দোকানের কাস্টমার-নোট লেখক। নিচের পুরনো স্মৃতি ও সাম্প্রতিক কথোপকথন মিলিয়ে এই কাস্টমার সম্পর্কে দরকারি তথ্য বাংলায় সর্বোচ্চ ৬০০ অক্ষরে লেখো: নাম, ফোন, ঠিকানা, কোন পণ্যে আগ্রহ/কী কিনেছেন, কোনো বিশেষ চাহিদা বা অভিযোগ, কী নিয়ে শেষ কথা হয়েছে। শুধু যা সত্যিই বলা হয়েছে তা লিখবে, অনুমান নয়। পুরনো তথ্য এখনো ঠিক থাকলে রাখবে, নতুন তথ্য দিলে বদলাবে। শুধু JSON: {"memory":"..."}`;
  const userMessage = `পুরনো স্মৃতি: ${previous || '(নেই)'}\nঅর্ডার: ${orders || '(নেই)'}\n\nসাম্প্রতিক কথোপকথন:\n${convo}`;
  const r = await getJsonReply({ settings, systemPrompt, userMessage });
  return String((r && r.memory) || '').slice(0, 900).trim();
}

// এক ঘরের Key কাজ করছে কিনা যাচাই (অ্যাপের "টেস্ট" বাটন) — খুব ছোট একটা মেসেজ পাঠিয়ে দেখে
async function testSlot(settings, sfx) {
  const apiKey = settings['aiKey' + sfx];
  if (!apiKey) throw new Error('এই ঘরে API Key বসানো নেই');
  const slot = {
    apiKey,
    provider: settings['aiProvider' + sfx] || 'groq',
    model: (settings['aiModel' + sfx] || '').trim(),
    baseUrl: (settings['aiBaseUrl' + sfx] || '').trim()
  };
  if (slot.provider === 'fal') return { ok: true, ms: 0, provider: 'fal', model: 'ছবি তৈরি', reply: 'এটা শুধু ছবি বানানোর Key — চ্যাটে ব্যবহার হয় না। আসল পরীক্ষা: সহকারীকে ছবি বানাতে বলুন।' };
  const t0 = Date.now();
  const r = await getAIReply({ ...slot, customerMessage: 'হ্যালো', history: [] });
  return { ok: true, ms: Date.now() - t0, provider: slot.provider, model: healed.get(slot.provider + '|' + (slot.model || MODELS[slot.provider] || '')) || slot.model || MODELS[slot.provider] || '', reply: String(r.reply || '').slice(0, 120) };
}

module.exports = { testSlot, summarizeCustomerMemory, getAIReply, getAIReplyWithFallback, getVisionReply, isVisionCapable, getOwnerChatReply, getSlots, getJsonReply };
