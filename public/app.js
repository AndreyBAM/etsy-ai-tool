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
      document.getElementById('payBtn').href = data.paymentUrl || '#';
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
