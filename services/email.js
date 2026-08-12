const nodemailer = require('nodemailer');
const config = require('../config');

function isEmailConfigured() {
  return !!(config.emailUser && config.emailPass);
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    // 'service: gmail' শর্টকাট ডিফল্টভাবে পোর্ট 465 ব্যবহার করে, যেটা Render-এর মতো
    // কিছু ফ্রি হোস্টিং প্ল্যাটফর্মে ব্লক থাকতে পারে (Connection timeout এরর দেয়)।
    // পোর্ট 587 (STARTTLS) সাধারণত বেশি জায়গায় খোলা থাকে, তাই এটা স্পষ্টভাবে বসানো হলো।
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // STARTTLS ব্যবহার হবে, পোর্ট 587-এর জন্য এটাই সঠিক
      requireTLS: true,
      auth: { user: config.emailUser, pass: config.emailPass },
      connectionTimeout: 15000
    });
  }
  return transporter;
}

// অর্ডার কনফার্ম হলে কাস্টমারের ইমেইলে (দিলে) একটা সুন্দর কনফার্মেশন পাঠায়।
// EMAIL_USER/EMAIL_PASS Render Environment-এ সেট না থাকলে চুপচাপ কিছুই করবে না —
// মেসেজ (Messenger/WhatsApp) কনফার্মেশন এর উপর নির্ভর করে না, সেটা সবসময় কাজ করবে।
async function sendOrderConfirmationEmail({ to, order }) {
  if (!isEmailConfigured()) return { sent: false, reason: 'সার্ভারে EMAIL_USER/EMAIL_PASS সেট করা নেই' };
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
    await getTransporter().sendMail({ from: config.emailFrom, to, subject, html });
    return { sent: true };
  } catch (err) {
    console.error('অর্ডার কনফার্মেশন ইমেইল পাঠাতে ব্যর্থ:', err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendOrderConfirmationEmail, isEmailConfigured };
