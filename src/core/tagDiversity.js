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

module.exports = { findDiversityViolations, countKeywordSpread, stem };
