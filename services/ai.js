const axios = require('axios');

const ENDPOINTS = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions'
};

const MODELS = {
  groq: 'llama-3.3-70b-versatile',
  openai: 'gpt-4o-mini'
};

async function getAIReply({ apiKey, provider = 'groq', customerMessage, history = [], sheetContext = '', businessInfo = '' }) {
  const endpoint = ENDPOINTS[provider] || ENDPOINTS.groq;
  const model = MODELS[provider] || MODELS.groq;

  const systemPrompt = `
তুমি "Faruk's SmartBiz" নামের একটা অনলাইন দোকানের কাস্টমার সাপোর্ট সহকারী।
বাংলায়, সংক্ষেপে, বন্ধুত্বপূর্ণভাবে উত্তর দাও।
${businessInfo ? 'দোকানের তথ্য:\n' + businessInfo : ''}
${sheetContext ? sheetContext : ''}

শুধুমাত্র নিচের JSON ফরম্যাটে উত্তর দাও, অন্য কিছু লিখো না:
{
  "reply": "কাস্টমারকে পাঠানোর মেসেজ",
  "order": null অথবা { "product": "...", "qty": সংখ্যা, "price": সংখ্যা }
}
কাস্টমার স্পষ্টভাবে একটা প্রোডাক্ট অর্ডার করতে চাইলেই শুধু "order" পূরণ করো, নাহলে null রাখো।
`.trim();

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text })),
    { role: 'user', content: customerMessage }
  ];

  const res = await axios.post(
    endpoint,
    {
      model,
      messages,
      temperature: 0.4,
      response_format: { type: 'json_object' }
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );

  const raw = res.data.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = { reply: raw, order: null };
  }
  return {
    reply: parsed.reply || 'দুঃখিত, একটু পরে আবার চেষ্টা করুন।',
    order: parsed.order || null
  };
}

module.exports = { getAIReply };
