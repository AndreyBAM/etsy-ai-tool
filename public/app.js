/**
 * app.js — funnel frontend
 * ---------------------------------------------------------------------
 * Ничего не хранит на сервере, кроме анонимного uid (localStorage).
 *
 * v3 (сентябрь 2026):
 *  - backend теперь отдаёт ОДИН заголовок и ОДНО описание (не массивы),
 *    плюс перевод title/description/каждого тега на язык продавца —
 *    рендерим их рядом с английским текстом.
 *  - по итогам анализа двух кампаний решили использовать в рекламе
 *    только "Вариант 3" (эмоциональный стиль, без упоминания AI) —
 *    варианты 1 и 2 удалены из кода, чтобы не путать; если ссылка
 *    придёт без ?v= или с другим значением, просто показывается
 *    дефолтный (статический) заголовок из index.html.
 * ---------------------------------------------------------------------
 */

// --- единственный активный вариант объявления (см. решение по итогам
// кампании 2: Вариант 3 стабильно забирал 85–95% показов и весь трафик
// до генерации в обеих кампаниях) ---
const VARIANTS = {
  3: {
    headline: 'İngilizceniz <em>Etsy\'de satış yapmanıza</em> engel mi oluyor?',
    sub: 'İngilizceniz güçlü olmasa bile doğal, native gibi görünen bir metin alın — üstelik Türkçe çevirisiyle birlikte, kendiniz kontrol edebilirsiniz.',
  },
};

(function applyVariant() {
  const params = new URLSearchParams(window.location.search);
  const v = params.get('v');
  if (v && VARIANTS[v]) {
    document.getElementById('headline').innerHTML = VARIANTS[v].headline;
    document.getElementById('subheadline').textContent = VARIANTS[v].sub;
  }
})();

// --- анонимный идентификатор пользователя (не требует регистрации) ---
function getUid() {
  let uid = localStorage.getItem('etsy_tool_uid');
  if (!uid) {
    uid = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    localStorage.setItem('etsy_tool_uid', uid);
  }
  return uid;
}
const uid = getUid();

// --- Paddle checkout (overlay) ---
// Client-side token — публичный, безопасно хранить прямо в коде фронтенда
// (в отличие от ANTHROPIC_API_KEY, который остаётся только на сервере).
const PADDLE_TOKEN = 'live_12ecdcebbf1137f9b667aa1e554';
const PADDLE_PRICE_ID = 'pri_01m0jph2vm9zakjq5m7w4qas58'; // "20 Etsy listings — $5"
const PURCHASE_VALUE = 5.00;
const PURCHASE_CURRENCY = 'USD';

// Флаг, чтобы случайно не отправить Purchase дважды на одно и то же событие
// (Paddle иногда может прислать checkout.completed повторно при повторном рендере overlay).
let purchaseFired = false;

if (window.Paddle) {
  Paddle.Initialize({
    token: PADDLE_TOKEN,
    eventCallback: function (event) {
      // Ловим именно завершение оплаты внутри overlay — это самый надёжный
      // клиентский сигнал "деньги реально прошли" для Meta Pixel.
      if (event.name === 'checkout.completed' && !purchaseFired) {
        purchaseFired = true;
        if (window.fbq) {
          fbq('track', 'Purchase', {
            value: PURCHASE_VALUE,
            currency: PURCHASE_CURRENCY,
            content_name: '20 Etsy listings',
          });
        }
      }
    },
  });
}

document.getElementById('payBtn').addEventListener('click', () => {
  if (!window.Paddle) {
    alert('Ödeme sistemi yüklenemedi. Lütfen sayfayı yenileyip tekrar deneyin.');
    return;
  }
  // Сбрасываем флаг перед каждым новым открытием чекаута, чтобы повторная
  // покупка (например, ещё через 20 генераций) тоже отследилась как Purchase.
  purchaseFired = false;

  // uid передаётся в custom_data, чтобы webhook на сервере знал,
  // какому анонимному пользователю начислить 20 генераций после оплаты.
  Paddle.Checkout.open({
    items: [{ priceId: PADDLE_PRICE_ID, quantity: 1 }],
    customData: { uid },
  });
});

// UTM/variant passthrough so the server can log which ad drove the action
function currentVariant() {
  return new URLSearchParams(window.location.search).get('v') || 'none';
}

const form = document.getElementById('genForm');
const genBtn = document.getElementById('genBtn');
const loading = document.getElementById('loading');
const resultBox = document.getElementById('result');
const feedbackBox = document.getElementById('feedbackBox');
const paywallBox = document.getElementById('paywall');
const errorBox = document.getElementById('errorBox');
const counterEl = document.getElementById('counter');

function setCounter(remaining) {
  if (remaining === null || remaining === undefined) { counterEl.textContent = ''; return; }
  if (remaining > 0) {
    counterEl.textContent = remaining + ' ücretsiz liste hakkınız kaldı';
  } else {
    counterEl.textContent = 'Ücretsiz liste hakkınız kalmadı';
  }
}

// узнаём остаток бесплатных попыток при загрузке страницы (без траты попытки)
fetch('/api/usage?uid=' + encodeURIComponent(uid))
  .then((r) => r.json())
  .then((d) => setCounter(d.remaining))
  .catch(() => {});

/**
 * Рендерит список тегов (или их перевод) в виде "пилюль" внутри указанного
 * контейнера. translation=true добавляет пунктирный стиль для отличия от
 * оригинальных английских тегов.
 */
function renderTagPills(container, tags, translation) {
  container.innerHTML = '';
  (tags || []).forEach((t) => {
    const span = document.createElement('span');
    span.className = translation ? 'tag-pill translation' : 'tag-pill';
    span.textContent = t;
    container.appendChild(span);
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.style.display = 'none';

  const rawText = document.getElementById('rawText').value.trim();
  if (!rawText) return;

  genBtn.disabled = true;
  loading.style.display = 'block';
  resultBox.style.display = 'none';
  feedbackBox.style.display = 'none';
  paywallBox.style.display = 'none';
  resetFeedbackUI();

  try {
    const category = document.getElementById('category').value;

    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawText, uid, variant: currentVariant(), category: category || undefined }),
    });
    const data = await res.json();

    if (res.status === 402) {
      // лимит бесплатных генераций исчерпан
      paywallBox.style.display = 'block';
      setCounter(0);
      return;
    }
    if (!res.ok) {
      throw new Error(data.error || 'Bir şeyler yanlış gitti');
    }

    document.getElementById('outTitle').textContent = data.title || '';
    document.getElementById('outTitleTranslation').textContent = data.titleTranslation || '';
    document.getElementById('outDesc').textContent = data.description || '';
    document.getElementById('outDescTranslation').textContent = data.descriptionTranslation || '';
    renderTagPills(document.getElementById('outTags'), data.tags, false);
    renderTagPills(document.getElementById('outTagsTranslation'), data.tagsTranslation, true);

    resultBox.style.display = 'block';
    // Каждая генерация — шанс собрать сигнал о качестве текста; показываем
    // feedback-блок сразу под результатом, а не ждём отдельного действия.
    lastGenerationUid = uid;
    feedbackBox.style.display = 'block';
    setCounter(data.remaining);
  } catch (err) {
    errorBox.textContent = 'Hata: ' + err.message + '. Lütfen tekrar deneyin.';
    errorBox.style.display = 'block';
  } finally {
    genBtn.disabled = false;
    loading.style.display = 'none';
  }
});

document.getElementById('anotherBtn').addEventListener('click', () => {
  resultBox.style.display = 'none';
  feedbackBox.style.display = 'none';
  document.getElementById('rawText').value = '';
  document.getElementById('rawText').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// --- копирование заголовка/описания одним кликом ---
function copyText(text, btn) {
  if (!text) return;
  const done = () => {
    const original = btn.textContent;
    btn.textContent = 'Kopyalandı ✓';
    setTimeout(() => { btn.textContent = original; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { /* тихо игнорируем */ }
  document.body.removeChild(ta);
}

document.getElementById('copyTitleBtn').addEventListener('click', (e) => {
  copyText(document.getElementById('outTitle').textContent, e.currentTarget);
});
document.getElementById('copyDescBtn').addEventListener('click', (e) => {
  copyText(document.getElementById('outDesc').textContent, e.currentTarget);
});
document.getElementById('copyAllTags').addEventListener('click', (e) => {
  const tags = Array.from(document.querySelectorAll('#outTags .tag-pill')).map((el) => el.textContent);
  copyText(tags.join(', '), e.currentTarget);
});

// --- feedback после генерации: оценка + опциональный email ---
let selectedRating = null;
let lastGenerationUid = null;
const feedbackEmailRow = document.getElementById('feedbackEmailRow');
const feedbackThanks = document.getElementById('feedbackThanks');
const feedbackOptions = document.querySelectorAll('.feedback-btn');

function resetFeedbackUI() {
  selectedRating = null;
  feedbackOptions.forEach((b) => b.classList.remove('selected'));
  feedbackEmailRow.style.display = 'none';
  feedbackThanks.style.display = 'none';
  document.getElementById('feedbackEmail').value = '';
}

feedbackOptions.forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedRating = btn.dataset.rating;
    feedbackOptions.forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    feedbackEmailRow.style.display = 'flex';
  });
});

document.getElementById('feedbackSubmit').addEventListener('click', async () => {
  if (!selectedRating) return;
  const email = document.getElementById('feedbackEmail').value.trim() || null;

  try {
    await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: lastGenerationUid || uid, rating: selectedRating, email }),
    });
  } catch (err) {
    // Не блокируем UX, даже если сеть подвела — сигнал не критичен
    // настолько, чтобы мешать пользователю продолжать пользоваться формой.
  }

  feedbackEmailRow.style.display = 'none';
  feedbackThanks.style.display = 'block';
});
