/**
 * Root entrypoint — always run the master TRON + Telegram backend
 * so /send-trx, /check-balance, /api/telegram stay aligned with the frontend.
 *
 * Prefer:  cd tronscantelegram-main && npm start
 * Or from root (with deps installed in tronscantelegram-main):
 *   node telegram-server.js
 */
module.exports = require('./tronscantelegram-main/telegram-server.js');
