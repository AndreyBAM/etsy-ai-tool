/**
 * app.js — funnel frontend
 * ---------------------------------------------------------------------
 * Ничего не хранит на сервере, кроме анонимного uid (localStorage) —
 * позволяет показывать 3 разных заголовка объявлений (?v=1|2|3) на
 * одной и той же странице, чтобы можно было гонять все 3 варианта
 * рекламы Meta на один и тот же лендинг с UTM-меткой.
 * ---------------------------------------------------------------------
 */

// --- 3 варианта заголовков, привязанные к вариантам объявлений ---
const VARIANTS = {
  1: {
    headline: 'Etsy\'de satış yapıyorsunuz, ama İngilizce <em>ana diliniz</em> değil mi?',
    sub: 'Ürününüzü kendi dilinizde anlatın — hazır İngilizce başlık, açıklama ve Etsy için 13 etiket alın. Çeviri yok, prompt yazmak yok, kopyala-yapıştır yok.',
  },
  2: {
    headline: 'Hâlâ Etsy listelerinizi ChatGPT ile <em>elle</em> mi yazıyorsunuz?',
    sub: 'Sekmeler arasında metin kopyalamayı bırakın. Ürününüzü anlatın → saniyeler içinde hazır bir Etsy listesi alın.',
  },
  3: {
    headline: 'İngilizceniz <em>Etsy\'de satış yapmanıza</em> engel mi oluyor?',
    sub: 'İngilizceniz güçlü olmasa bile doğal, native gibi görünen başlıklar, açıklamalar ve etiketler oluşturun.',
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

if (window.Paddle) {
  Paddle.Initialize({ token: PADDLE_TOKEN });
}

document.getElementById('payBtn').addEventListener('click', () => {
  if (!window.Paddle) {
    alert('Ödeme sistemi yüklenemedi. Lütfen sayfayı yenileyip tekrar deneyin.');
    return;
  }
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

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.style.display = 'none';
  const rawText = document.getElementById('rawText').value.trim();
  if (!rawText) return;

  genBtn.disabled = true;
  loading.style.display = 'block';
  resultBox.style.display = 'none';
  paywallBox.style.display = 'none';

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawText, uid, variant: currentVariant() }),
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

    document.getElementById('outTitle').textContent = data.title;
    document.getElementById('outDesc').textContent = data.description;
    const tagsWrap = document.getElementById('outTags');
    tagsWrap.innerHTML = '';
    (data.tags || []).forEach((t) => {
      const span = document.createElement('span');
      span.className = 'tag-pill';
      span.textContent = t;
      tagsWrap.appendChild(span);
    });
    resultBox.style.display = 'block';
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
  document.getElementById('rawText').value = '';
  document.getElementById('rawText').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
