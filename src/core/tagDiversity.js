/**
 * tagDiversity.js
 * ---------------------------------------------------------------------
 * ПОЧЕМУ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ:
 * Промпт просил модель "мысленно посчитать" повторения ключевого слова
 * в тегах перед финальным ответом — но system-промпт в этом же дыхании
 * запрещает любой текст, кроме чистого JSON ("no commentary"). Модели
 * негде фактически посчитать — результат ненадёжен (проверено на 5
 * реальных примерах: правило "макс. 2 тега на слово" нарушалось в 4 из 5).
 *
 * Решение: считать вхождения в коде, где это математически точно,
 * а не полагаться на то, что модель "сама сосчитает в уме".
 *
 * v3.1 (сентябрь 2026) — добавлен второй, независимый от промпта
 * детерминированный фильтр: даже после явного запрета в промпте
 * (правила 2c/6 в promptBuilder.js) модель на практике всё равно
 * иногда добавляет в ТЕГИ более специфичный подтип/стиль, которого
 * продавец не называл (проверено на реальных генерациях: "floating
 * shelf", "crossbody", "minimalist" проскакивали в тегах даже когда
 * их не было ни в title, ни в description). Правило в промпте ловит
 * это в основном тексте надёжно, но не в списке из 13 тегов — поэтому
 * здесь добавлена подстраховка в коде, а не ещё один вызов модели.
 * ---------------------------------------------------------------------
 */

// Служебные слова, которые не считаем "ключевыми" — их повторение
// в разных тегах нормально и не тратит впустую поисковое покрытие.
const STOPWORDS = new Set([
  'for', 'and', 'the', 'with', 'her', 'him', 'his', 'a', 'an', 'of', 'to',
  'in', 'on', 'at', 'or', 'you', 'your',
]);

/**
 * Очень простой стеммер под наши нужды: приводит "mugs"/"necklaces" к
 * тому же корню, что "mug"/"necklace". Не претендует на лингвистическую
 * точность — этого достаточно для проверки повторов в коротких тегах.
 * @param {string} word
 */
function stem(word) {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

/**
 * Считает, в скольких РАЗНЫХ тегах встречается каждое ключевое слово.
 * @param {string[]} tags
 * @returns {Map<string, {count: number, tagsContaining: string[]}>}
 */
function countKeywordSpread(tags) {
  const spread = new Map();
  for (const tag of tags) {
    const wordsInTag = new Set(
      (tag.toLowerCase().match(/[a-z]+/g) || [])
        .map(stem)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    );
    for (const word of wordsInTag) {
      if (!spread.has(word)) spread.set(word, { count: 0, tagsContaining: [] });
      const entry = spread.get(word);
      entry.count += 1;
      entry.tagsContaining.push(tag);
    }
  }
  return spread;
}

/**
 * Возвращает список слов, которые встречаются больше, чем maxOccurrences
 * раз в разных тегах — то есть нарушают правило tag-diversity.
 * @param {string[]} tags
 * @param {number} [maxOccurrences=2]
 * @returns {Array<{word: string, count: number, tags: string[]}>}
 */
function findDiversityViolations(tags, maxOccurrences = 2) {
  const spread = countKeywordSpread(tags);
  const violations = [];
  for (const [word, { count, tagsContaining }] of spread.entries()) {
    if (count > maxOccurrences) {
      violations.push({ word, count, tags: tagsContaining });
    }
  }
  return violations.sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------
// Фильтр выдуманных уточнений в тегах (независимая подстраховка к
// правилам 2c/6 в promptBuilder.js — см. комментарий в шапке файла)
// ---------------------------------------------------------------------

// Слово в теге -> стем(ы), по которым проверяем, было ли оно (или его
// форма) в исходном тексте продавца. Если стема нет в исходнике — тег
// считается выдумкой и выбрасывается. Список составлен по конкретным
// паттернам, реально пойманным на тестовых генерациях.
const FABRICATION_BLOCKLIST = {
  floating: ['floating'],
  tote: ['tote'],
  purse: ['purse'],
  crossbody: ['crossbody', 'cross-body', 'cross body'],
  minimalist: ['minimalist', 'minimalism'],
  rustic: ['rustic'],
  trailing: ['trailing'],
  artisan: ['artisan'],
  luxury: ['luxury', 'luxurious'],
  premium: ['premium'],
  engraved: ['engrav'], // ловит engraved/engraving
  organizer: ['organiz'], // ловит organizer/organizing/organised
  walnut: ['walnut'],
};

/**
 * Проверяет, есть ли хотя бы одна из стем в исходном тексте продавца
 * (простое includes() по нижнему регистру — умышленно грубо, чтобы не
 * зависеть от токенизации/языка исходника).
 * @param {string} sourceTextLower
 * @param {string[]} stems
 */
function isPresentInSource(sourceTextLower, stems) {
  return stems.some((s) => sourceTextLower.includes(s.toLowerCase()));
}

/**
 * Фильтрует пары (tag, tagTranslation) от выдуманных уточнений.
 * Работает по индексам ОБОИХ массивов одновременно, чтобы перевод не
 * "уехал" от своего тега после удаления.
 *
 * @param {string[]} tags
 * @param {string[]} tagsTranslation - того же порядка/длины, что tags
 * @param {string} sourceText - исходный текст продавца (на его языке)
 * @returns {{tags: string[], tagsTranslation: string[], removed: string[]}}
 */
function filterFabricatedTagPairs(tags, tagsTranslation, sourceText) {
  const sourceLower = (sourceText || '').toLowerCase();
  const keptTags = [];
  const keptTranslations = [];
  const removed = [];

  tags.forEach((tag, i) => {
    const tagLower = tag.toLowerCase();
    let fabricated = false;

    for (const stems of Object.values(FABRICATION_BLOCKLIST)) {
      const tagContainsWord = stems.some((s) => tagLower.includes(s));
      if (tagContainsWord && !isPresentInSource(sourceLower, stems)) {
        fabricated = true;
        break;
      }
    }

    if (fabricated) {
      removed.push(tag);
    } else {
      keptTags.push(tag);
      keptTranslations.push(tagsTranslation ? tagsTranslation[i] : undefined);
    }
  });

  return { tags: keptTags, tagsTranslation: keptTranslations, removed };
}

// Фразы-сравнения с масс-продакшеном — тоже выдумка, если продавец не
// говорил ничего подобного явно. Пока только для лога (см. комментарий
// в generateListing.js) — аккуратно вырезать кусок готового предложения
// сложнее, чем выбросить тег целиком, поэтому основная защита остаётся
// на стороне промпта (правило 2b/6), а это — сигнал для мониторинга.
const SUPERIORITY_PHRASES = [
  'mass-produced',
  'mass produced',
  'unlike factory',
  "you won't find in",
  'you will not find in',
];

/**
 * @param {string} text
 * @returns {boolean}
 */
function containsSuperiorityClaim(text) {
  const lower = (text || '').toLowerCase();
  return SUPERIORITY_PHRASES.some((phrase) => lower.includes(phrase));
}

module.exports = {
  findDiversityViolations,
  countKeywordSpread,
  stem,
  filterFabricatedTagPairs,
  containsSuperiorityClaim,
};
