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
    headline: 'Selling on Etsy, but English isn\'t your <em>first language</em>?',
    sub: 'Describe your product in your own language — get a ready English title, description, and 13 tags for Etsy. No translating, no prompting, no copy-pasting.',
  },
  2: {
    headline: 'Still writing Etsy listings through ChatGPT <em>by hand</em>?',
    sub: 'No more copying text back and forth between tabs. Describe your product → get a ready-to-post Etsy listing in seconds.',
  },
  3: {
    headline: 'Does your English hold you back from <em>selling on Etsy</em>?',
    sub: 'Create natural, native-sounding English titles, descriptions, and tags — even if your English isn\'t strong.',
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
    counterEl.textContent = remaining + ' free listing' + (remaining === 1 ? '' : 's') + ' left';
  } else {
    counterEl.textContent = 'No free listings left';
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
      throw new Error(data.error || 'Something went wrong');
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
    errorBox.textContent = 'Error: ' + err.message + '. Please try again.';
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
