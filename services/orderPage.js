'use strict';
// অর্ডার-কার্ড পেজ (orderPage.html) — টোকেন বসিয়ে পাঠায়
const fs = require('fs'), path = require('path');
let html = null;
module.exports = function (token, valid) {
  if (!html) html = fs.readFileSync(path.join(__dirname, 'orderPage.html'), 'utf8');
  return html.replace('__TOKEN__', valid ? String(token).replace(/[^A-Za-z0-9._-]/g, '') : '');
};
