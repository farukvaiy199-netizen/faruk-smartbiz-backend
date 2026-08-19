const axios = require('axios');
const config = require('../config');

// আগে SMTP (nodemailer) ব্যবহার হতো, কিন্তু Render ফ্রি প্ল্যানে outbound SMTP পোর্ট
// (৪৬৫ ও ৫৮৭ দুটোই) ব্লক থাকায় সবসময় "Connection timeout" হচ্ছিল।
// Resend একটা সাধারণ HTTPS API (পোর্ট ৪৪৩), তাই ব্লক হওয়ার কথা না।
function isEmailConfigured() {
  return !!config.resendApiKey;
}

async function sendOrderConfirmationEmail({ to, order }) {
  if (!isEmailConfigured()) return { sent: false, reason: 'সার্ভারে RESEND_API_KEY সেট করা নেই' };
  if (!to) return { sent: false, reason: 'কাস্টমারের ইমেইল পাওয়া যায়নি' };

  const subject = `আপনার অর্ডার কনফার্ম হয়েছে — ${order.id}`;
  const total = (order.price || 0) * (order.qty || 1);
  const html = `
    <div style="font-family:sans-serif; max-width:480px;">
      <h2>ধন্যবাদ, ${order.name || 'প্রিয় কাস্টমার'}!</h2>
      <p>আপনার অর্ডারটি সফলভাবে গ্রহণ করা হয়েছে।</p>
      <table style="border-collapse:collapse; width:100%;">
        <tr><td style="padding:5px 8px; color:#555;">অর্ডার আইডি</td><td style="padding:5px 8px;"><b>${order.id}</b></td></tr>
        <tr><td style="padding:5px 8px; color:#555;">প্রোডাক্ট</td><td style="padding:5px 8px;">${order.product} x${order.qty}</td></tr>
        <tr><td style="padding:5px 8px; color:#555;">মোট মূল্য</td><td style="padding:5px 8px;">৳${total}</td></tr>
        <tr><td style="padding:5px 8px; color:#555;">ডেলিভারি ঠিকানা</td><td style="padding:5px 8px;">${order.address || ''}</td></tr>
      </table>
      <p style="margin-top:16px;">যেকোনো প্রশ্নে যোগাযোগ করুন: <b>01792872209</b></p>
    </div>
  `;

  try {
    await axios.post('https://api.resend.com/emails', {
      from: 'Faruk\'s SmartBiz <onboarding@resend.dev>',
      to: [to],
      subject,
      html
    }, {
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    return { sent: true };
  } catch (err) {
    const reason = err.response?.data?.message || err.message;
    console.error('অর্ডার কনফার্মেশন ইমেইল পাঠাতে ব্যর্থ:', reason);
    return { sent: false, reason };
  }
}

module.exports = { sendOrderConfirmationEmail, isEmailConfigured };
