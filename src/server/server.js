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
 * v2 (сентябрь 2026): добавлен персистентный журнал генераций
 * (generationLog) с timestamp/category/variant для каждой записи —
 * раньше в state.json хранился только "плоский" счётчик usage без
 * привязки ко времени, из-за чего нельзя было отделить, сколько
 * генераций пришло за конкретную рекламную кампанию/неделю/месяц.
 * Плюс новый защищённый эндпоинт /api/stats с фильтром по периоду.
 * Существующая логика usage/paidCredits/paywall/Paddle НЕ менялась.
 *
 * Запуск:
 * ANTHROPIC_API_KEY=sk-ant-... node src/server/server.js
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

// Секрет для доступа к /api/stats — без него отдаём 403. Обязательно
// задать своё значение в Railway → Variables перед тем, как делиться
// ссылкой на статистику с кем-либо ещё, помимо себя.
const STATS_SECRET = process.env.STATS_SECRET || 'change-me-to-something-random';

// Простые счётчики в памяти процесса, дополнительно сохраняемые на диск
// (см. loadState/saveState ниже), чтобы переживать рестарты и передеплои
// Railway. Если тест приживётся и понадобится собирать историю дольше —
// здесь же заменить на Supabase (TODO из плана, раздел 6).
const usage = new Map(); // uid -> сколько генераций уже использовано всего
const paidCredits = new Map(); // uid -> сколько платных генераций начислено (кумулятивно)
const processedTransactions = new Set(); // transaction.id, чтобы не начислить дважды при повторной доставке webhook-а

// Журнал КАЖДОЙ отдельной генерации с меткой времени — в отличие от
// usage (просто число), это позволяет позже отфильтровать "сколько
// генераций было за последнюю неделю" или "сколько пришло именно
// с 3-й рекламной кампании", не путая их с историей всего проекта.
// Растёт линейно (несколько десятков КБ даже при сотнях генераций
// в месяц) — Railway Volume это не напряжёт, поэтому старые записи
// не удаляются автоматически.
let generationLog = []; // [{ uid, timestamp, category, variant }, ...]

// Журнал отзывов с формы обратной связи после генерации (кнопки
// "Evet yeterli" / "Biraz düzenlerim" / "Baştan yazarım" + опциональный
// email). Раньше такого массива в коде не было вообще — фронтенд уже
// отправлял POST на /api/feedback, но на сервере не было обработчика,
// поэтому email реально нигде не сохранялся. Теперь сохраняется.
let feedbackLog = []; // [{ uid, rating, email, timestamp }, ...]

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
    // Старые state.json (до этого апдейта) не содержат generationLog —
    // это нормально, просто начинаем журнал с этого момента вперёд.
    generationLog = Array.isArray(parsed.generationLog) ? parsed.generationLog : [];
    feedbackLog = Array.isArray(parsed.feedbackLog) ? parsed.feedbackLog : [];
    console.log(
      `State loaded from ${STATE_FILE}: ${usage.size} uid(s), ${paidCredits.size} with credits, ${generationLog.length} logged generation(s), ${feedbackLog.length} feedback entr(ies).`
    );
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
      generationLog,
      feedbackLog,
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

// --- разбор параметров периода для /api/stats ---------------------------
// Поддерживает ?days=7 (последние N дней от текущего момента) ИЛИ
// ?from=2026-09-15&to=2026-09-22 (конкретный диапазон, обе границы
// включительно). Если не передано ни то, ни другое — период не
// ограничен (вся история проекта), как раньше.
function resolvePeriod(searchParams) {
  const days = searchParams.get('days');
  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');

  let from = null;
  let to = null;

  if (days) {
    const n = parseInt(days, 10);
    if (!isNaN(n) && n > 0) {
      to = new Date();
      from = new Date(to.getTime() - n * 24 * 60 * 60 * 1000);
    }
  } else if (fromParam || toParam) {
    from = fromParam ? new Date(fromParam) : null;
    to = toParam ? new Date(toParam + 'T23:59:59.999Z') : new Date();
  }

  return { from, to };
}

function filterLogByPeriod(log, from, to) {
  if (!from && !to) return log;
  return log.filter((entry) => {
    const t = new Date(entry.timestamp);
    if (from && t < from) return false;
    if (to && t > to) return false;
    return true;
  });
}

function summarizeLog(log) {
  const uniqueUsers = new Set(log.map((e) => e.uid));
  const byVariant = {};
  const byDay = {};

  log.forEach((e) => {
    const v = e.variant || 'none';
    byVariant[v] = (byVariant[v] || 0) + 1;

    // группировка по дню (YYYY-MM-DD) — удобно смотреть недельную/
    // месячную динамику без внешних инструментов аналитики
    const day = (e.timestamp || '').slice(0, 10);
    if (!byDay[day]) byDay[day] = { generations: 0, uniqueUsers: new Set() };
    byDay[day].generations += 1;
    byDay[day].uniqueUsers.add(e.uid);
  });

  const byDayArray = Object.keys(byDay)
    .sort()
    .map((day) => ({
      date: day,
      generations: byDay[day].generations,
      uniqueUsers: byDay[day].uniqueUsers.size,
    }));

  return {
    totalGenerations: log.length,
    totalUsers: uniqueUsers.size,
    byVariant,
    byDay: byDayArray,
  };
}

// Аналог summarizeLog, но для отзывов с формы обратной связи: считает
// разбивку по оценке (good/minor_edits/rewrite) и отдаёт сами записи
// (с email, если продавец его оставил) для ручного просмотра.
function summarizeFeedback(log) {
  const byRating = { good: 0, minor_edits: 0, rewrite: 0, other: 0 };
  log.forEach((e) => {
    const key = byRating.hasOwnProperty(e.rating) ? e.rating : 'other';
    byRating[key] += 1;
  });

  return {
    totalResponses: log.length,
    byRating,
    emailsCollected: log.filter((e) => e.email).length,
    entries: [...log].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)),
  };
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
  '/favicon.png': { file: 'favicon.png', type: 'image/png' },
  '/favicon.ico': { file: 'favicon.ico', type: 'image/x-icon' },
  '/logo-tag.png': { file: 'logo-tag.png', type: 'image/png' },
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

  // --- защищённая статистика с фильтром по периоду ---
  // Примеры:
  //   /api/stats?key=SECRET               — вся история проекта
  //   /api/stats?key=SECRET&days=7        — последняя неделя
  //   /api/stats?key=SECRET&days=30       — последний месяц
  //   /api/stats?key=SECRET&from=2026-09-01&to=2026-09-08  — конкретная кампания
  if (req.method === 'GET' && url.pathname === '/api/stats') {
    if (url.searchParams.get('key') !== STATS_SECRET) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Forbidden' }));
    }

    const { from, to } = resolvePeriod(url.searchParams);

    const filteredGenerations = filterLogByPeriod(generationLog, from, to);
    const periodSummary = summarizeLog(filteredGenerations);
    const allTimeSummary = summarizeLog(generationLog);

    const filteredFeedback = filterLogByPeriod(feedbackLog, from, to);
    const feedbackSummary = summarizeFeedback(filteredFeedback);

    // Сырые записи каждой генерации (не только агрегаты по дням) —
    // видно точное время конкретной генерации, отсортировано от
    // старых к новым, чтобы удобно читать как ленту событий.
    const generationsSorted = [...filteredGenerations].sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      // 2 — отступ в пробелах: без него весь ответ выводится одной
      // сплошной строкой, что тяжело читать глазами прямо в браузере.
      JSON.stringify(
        {
          period: {
            from: from ? from.toISOString() : null,
            to: to ? to.toISOString() : null,
          },
          ...periodSummary,
          generations: generationsSorted,
          payingUsers: [...paidCredits.keys()].length,
          totalPaidCredits: [...paidCredits.values()].reduce((a, b) => a + b, 0),
          feedback: feedbackSummary,
          allTime: allTimeSummary,
        },
        null,
        2
      )
    );
  }

  // --- фидбек после генерации: оценка + опциональный email ---
  // Раньше форма на фронтенде уже отправляла сюда POST, но этого
  // обработчика в коде не было вообще — запрос просто улетал в 404,
  // и email нигде не сохранялся. Теперь пишется в feedbackLog.
  if (req.method === 'POST' && url.pathname === '/api/feedback') {
    try {
      const body = await readJsonBody(req);
      const uid = body.uid || 'anonymous';
      const allowedRatings = ['good', 'minor_edits', 'rewrite'];
      const rating = allowedRatings.includes(body.rating) ? body.rating : 'other';
      const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null;

      feedbackLog.push({ uid, rating, email, timestamp: new Date().toISOString() });
      saveState();
      logEvent('feedback_submitted', { uid, rating, email });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
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

    const timestamp = new Date().toISOString();
    generationLog.push({ uid, timestamp, category: body.category || null, variant: body.variant || 'none' });

    saveState();
    logEvent('generated', { uid, variant: body.variant, category: body.category, timestamp, remaining: remainingFor(uid) });

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
  if (STATS_SECRET === 'change-me-to-something-random') {
    console.warn('WARNING: STATS_SECRET not set — using an insecure default. Set it in Railway → Variables before sharing the /api/stats link with anyone.');
  }
});
