/**
 * server.js
 * ---------------------------------------------------------------------
 * Минимальный backend-прокси. Единственная причина, по которой он
 * существует: Anthropic API key нельзя класть в код расширения
 * (он был бы виден любому пользователю через DevTools).
 *
 * Специально без Express и без npm-зависимостей — только встроенный
 * http, чтобы прототип запускался сразу через `node server.js`
 * без npm install. Когда дойдёте до реального деплоя на Vercel/Railway,
 * это легко переносится в serverless-функцию.
 *
 * Запуск:
 *   ANTHROPIC_API_KEY=sk-ant-... node src/server/server.js
 * ---------------------------------------------------------------------
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateListing } = require('../core/generateListing');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

// --- воронка demand-теста ---------------------------------------------
// Сколько бесплатных генераций даём одному анонимному uid до пейволла.
const FREE_LIMIT = parseInt(process.env.FREE_LIMIT || '3', 10);

// Сколько генераций начисляем за одну успешную оплату Paddle (продукт
// "20 Etsy listings — $5"). Если цена/пакет когда-нибудь изменится —
// поменять здесь.
const CREDITS_PER_PURCHASE = parseInt(process.env.CREDITS_PER_PURCHASE || '20', 10);

// Секретный ключ webhook-а Paddle (Developer Tools → Notifications →
// открыть destination → Secret key). Нужен, чтобы убедиться, что
// запрос на /api/paddle-webhook реально пришёл от Paddle, а не от
// кого угодно в интернете, кто узнал наш URL.
const PADDLE_WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET;

// Простые счётчики в памяти процесса, дополнительно сохраняемые на диск
// (см. loadState/saveState ниже), чтобы переживать рестарты и передеплои
// Railway. Если тест приживётся и понадобится собирать историю дольше —
// здесь же заменить на Supabase (TODO из плана, раздел 6).
const usage = new Map(); // uid -> сколько генераций уже использовано всего
const paidCredits = new Map(); // uid -> сколько платных генераций начислено (кумулятивно)
const processedTransactions = new Set(); // transaction.id, чтобы не начислить дважды при повторной доставке webhook-а

// --- персистентность на диск -------------------------------------------
// Railway по умолчанию стирает файловую систему при каждом передеплое —
// ЗА ИСКЛЮЧЕНИЕМ директории, примонтированной как persistent Volume.
// DATA_DIR должен указывать именно на такую директорию (см. инструкцию
// по добавлению Volume в Railway → Settings → Volumes, mount path /data).
const DATA_DIR = process.env.DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    (parsed.usage || []).forEach(([k, v]) => usage.set(k, v));
    (parsed.paidCredits || []).forEach(([k, v]) => paidCredits.set(k, v));
    (parsed.processedTransactions || []).forEach((id) => processedTransactions.add(id));
    console.log(`State loaded from ${STATE_FILE}: ${usage.size} uid(s), ${paidCredits.size} with credits.`);
  } catch (err) {
    console.log(`No existing state file at ${STATE_FILE} (this is normal on first run). Starting fresh.`);
  }
}

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = {
      usage: [...usage.entries()],
      paidCredits: [...paidCredits.entries()],
      processedTransactions: [...processedTransactions],
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data));
  } catch (err) {
    // Если Volume не подключен, запись может не сработать — не роняем
    // сервер из-за этого, но громко предупреждаем в логах.
    console.error('Failed to save state to disk:', err.message);
  }
}

loadState();

function logEvent(name, data) {
  // Дешёвая замена полноценной аналитике на время теста: события видно
  // прямо в логах хостинга (Railway/Render). Один event = одна строка.
  console.log(`[event] ${name}`, JSON.stringify(data));
}

function allowedFor(uid) {
  return FREE_LIMIT + (paidCredits.get(uid) || 0);
}

function remainingFor(uid) {
  const used = usage.get(uid) || 0;
  return Math.max(0, allowedFor(uid) - used);
}

// --- проверка подписи webhook-а Paddle ---------------------------------
// Paddle подписывает каждый webhook заголовком Paddle-Signature вида
// "ts=1700000000;h1=<hex-hmac>". Подпись считается как
// HMAC-SHA256(secret, `${ts}:${rawBody}`), где rawBody — ТОЧНО тот же
// текст, что пришёл в теле запроса (поэтому читаем raw, а не парсим
// JSON заранее).
function verifyPaddleSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(';').map((p) => p.split('='))
  );
  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return false;

  const signedPayload = `${ts}:${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  // timingSafeEqual требует буферы одинаковой длины
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(h1, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
  '/terms.html': { file: 'terms.html', type: 'text/html; charset=utf-8' },
  '/privacy.html': { file: 'privacy.html', type: 'text/html; charset=utf-8' },
  '/refund.html': { file: 'refund.html', type: 'text/html; charset=utf-8' },
  '/pricing.html': { file: 'pricing.html', type: 'text/html; charset=utf-8' },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS — нужно, т.к. в будущем запрос может прийти и со страницы etsy.com
  // через content script расширения, не только с самого лендинга.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // --- статика лендинга ---
  if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
    const { file, type } = STATIC_FILES[url.pathname];
    return fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end('Failed to load ' + file);
      }
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  }

  // --- сколько генераций осталось у этого uid (бесплатных + оплаченных) ---
  if (req.method === 'GET' && url.pathname === '/api/usage') {
    const uid = url.searchParams.get('uid') || 'anonymous';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ remaining: remainingFor(uid) }));
  }

  // --- webhook от Paddle: сюда Paddle сам стучится после успешной оплаты ---
  if (req.method === 'POST' && url.pathname === '/api/paddle-webhook') {
    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch (err) {
      res.writeHead(400);
      return res.end('Bad body');
    }

    const signatureHeader = req.headers['paddle-signature'];
    const isValid = verifyPaddleSignature(rawBody, signatureHeader, PADDLE_WEBHOOK_SECRET);

    if (!isValid) {
      logEvent('webhook_invalid_signature', {});
      res.writeHead(401);
      return res.end('Invalid signature');
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch (err) {
      res.writeHead(400);
      return res.end('Invalid JSON');
    }

    // Нас интересует только успешно завершённая оплата.
    if (event.event_type === 'transaction.completed') {
      const txId = event.data && event.data.id;
      const customData = (event.data && event.data.custom_data) || {};
      const uid = customData.uid;

      if (txId && !processedTransactions.has(txId) && uid) {
        processedTransactions.add(txId);
        paidCredits.set(uid, (paidCredits.get(uid) || 0) + CREDITS_PER_PURCHASE);
        saveState();
        logEvent('payment_completed', { uid, txId, creditsAdded: CREDITS_PER_PURCHASE });
      } else {
        logEvent('webhook_skipped', { txId, uid, reason: !uid ? 'no_uid' : 'duplicate' });
      }
    }

    // Paddle ждёт 200 OK в ответ — иначе будет повторять доставку.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ received: true }));
  }

  if (req.method !== 'POST' || url.pathname !== '/api/generate') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not found' }));
  }

  if (!API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Server misconfigured: ANTHROPIC_API_KEY not set' }));
  }

  try {
    const body = await readJsonBody(req);
    const uid = body.uid || 'anonymous';

    const used = usage.get(uid) || 0;
    if (used >= allowedFor(uid)) {
      logEvent('paywall_hit', { uid, variant: body.variant });
      res.writeHead(402, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'limit_reached' }));
    }

    // TODO(после demand-теста): заменить Map на Supabase, если тест
    // покажет, что стоит строить полноценную авторизацию/подписку.

    const listing = await generateListing(
      {
        rawText: body.rawText,
        sourceLang: body.sourceLang, // необязательно — если не передано, Claude определит язык сам
        category: body.category,
        extraContext: body.extraContext,
      },
      { apiKey: API_KEY, marketplace: body.marketplace || 'etsy' }
    );

    usage.set(uid, used + 1);
    saveState();
    logEvent('generated', { uid, variant: body.variant, remaining: remainingFor(uid) });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...listing, remaining: remainingFor(uid) }));
  } catch (err) {
    console.error(err);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Отдельно от readJsonBody: возвращает СЫРОЙ текст тела запроса без
// парсинга. Нужен для проверки подписи webhook-а Paddle — HMAC
// считается именно по исходным байтам, а не по JSON.parse/stringify
// версии (которая может отличаться порядком ключей/пробелами).
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

server.listen(PORT, () => {
  console.log(`Backend proxy listening on http://localhost:${PORT}`);
  console.log(`Free limit: ${FREE_LIMIT} generations. Credits per purchase: ${CREDITS_PER_PURCHASE}.`);
  if (!PADDLE_WEBHOOK_SECRET) {
    console.warn('WARNING: PADDLE_WEBHOOK_SECRET not set — payments will not be credited automatically.');
  }
});
