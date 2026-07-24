require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  webhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN || 'change_me',
  encryptionKey: process.env.SETTINGS_ENCRYPTION_KEY || 'change_this_to_a_long_random_string'
};
