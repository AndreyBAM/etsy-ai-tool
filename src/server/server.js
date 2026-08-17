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
const { generateListing } = require('../core/generateListing');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

// --- воронка demand-теста ---------------------------------------------
// Ссылка на оплату (LemonSqueezy/Gumroad checkout URL). Настраивается
// через .env, чтобы не хардкодить и не пересобирать на каждое изменение.
const PAYMENT_URL = process.env.PAYMENT_URL || 'https://example.com/checkout';
// Сколько бесплатных генераций даём одному анонимному uid до пейволла.
const FREE_LIMIT = parseInt(process.env.FREE_LIMIT || '3', 10);

// Простой счётчик в памяти процесса. НЕ переживает рестарт сервера —
// это осознанное упрощение для короткого (несколько дней) demand-теста.
// Если тест приживётся и понадобится собирать историю дольше — здесь же
// заменить Map на Supabase (TODO из плана, раздел 6).
const usage = new Map(); // uid -> count

function logEvent(name, data) {
  // Дешёвая замена полноценной аналитике на время теста: события видно
  // прямо в логах хостинга (Railway/Render). Один event = одна строка.
  console.log(`[event] ${name}`, JSON.stringify(data));
}

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
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

  // --- сколько бесплатных генераций осталось у этого uid ---
  if (req.method === 'GET' && url.pathname === '/api/usage') {
    const uid = url.searchParams.get('uid') || 'anonymous';
    const used = usage.get(uid) || 0;
    const remaining = Math.max(0, FREE_LIMIT - used);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ remaining }));
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
    if (used >= FREE_LIMIT) {
      logEvent('paywall_hit', { uid, variant: body.variant });
      res.writeHead(402, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'limit_reached', paymentUrl: PAYMENT_URL }));
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
    const remaining = Math.max(0, FREE_LIMIT - (used + 1));
    logEvent('generated', { uid, variant: body.variant, remaining });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...listing, remaining }));
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

server.listen(PORT, () => {
  console.log(`Backend proxy listening on http://localhost:${PORT}`);
  console.log(`Free limit: ${FREE_LIMIT} generations. Payment URL: ${PAYMENT_URL}`);
});
