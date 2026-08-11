const axios = require('axios');
const FormData = require('form-data');

// শুধু Groq আর OpenAI-এর Whisper endpoint একই ফরম্যাটে কাজ করে (multipart/form-data)।
// Gemini/OpenRouter-এর জন্য আলাদা সেটআপ লাগবে, তাই আপাতত সাপোর্ট করা হয়নি —
// ভয়েস মেসেজের জন্য অন্তত একটা Groq বা OpenAI Key থাকা দরকার (প্রধান অথবা ব্যাকআপ হিসেবে)।
const WHISPER_ENDPOINTS = {
  groq: 'https://api.groq.com/openai/v1/audio/transcriptions',
  openai: 'https://api.openai.com/v1/audio/transcriptions'
};
const WHISPER_MODELS = {
  groq: 'whisper-large-v3',
  openai: 'whisper-1'
};

function isWhisperCapable(provider) {
  return provider === 'groq' || provider === 'openai';
}

async function transcribeAudio({ apiKey, provider, audioBuffer, filename = 'voice.ogg' }) {
  const endpoint = WHISPER_ENDPOINTS[provider];
  if (!endpoint) return null;

  const form = new FormData();
  form.append('file', audioBuffer, filename);
  form.append('model', WHISPER_MODELS[provider]);
  form.append('language', 'bn'); // বাংলা ভয়েস মেসেজ ধরে নিচ্ছি, ভুল হলেও Whisper স্বয়ংক্রিয়ভাবে ভাষা বুঝে নেয়

  const res = await axios.post(endpoint, form, {
    headers: { Authorization: `Bearer ${apiKey}`, ...form.getHeaders() },
    timeout: 30000
  });

  return res.data.text || '';
}

module.exports = { transcribeAudio, isWhisperCapable };
