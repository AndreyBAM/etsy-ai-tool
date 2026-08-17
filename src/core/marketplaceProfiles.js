/**
 * marketplaceProfiles.js
 * ---------------------------------------------------------------------
 * Единственное место, где хранится "знание" о специфике площадки для
 * ЯДРА генерации (не путать с DOM-адаптером — это разные вещи!).
 *
 * Добавление новой площадки (eBay, Amazon Handmade) в будущем — это
 * добавление ещё одного объекта в этот файл, promptBuilder.js трогать
 * не нужно.
 * ---------------------------------------------------------------------
 */

/** @type {Record<string, import('./promptBuilder').MarketplaceProfile>} */
const marketplaceProfiles = {
  etsy: {
    name: 'Etsy',
    audienceNote:
      'Etsy buyers are ~70%+ from English-speaking / European countries (US, UK, Canada, Australia, Germany). ' +
      'They search with specific, literal phrases (e.g. "personalized leather wallet men gift"), not marketing fluff. ' +
      'Etsy search rewards specific, descriptive, keyword-front-loaded titles over cute or vague ones.',
    maxTitleLength: 140,
    maxTags: 13,
    maxTagLength: 20,
  },

  // Задел на будущее (раздел 13 плана) — сейчас не используется,
  // но структура уже готова для расширения без переделки ядра.
  ebay: {
    name: 'eBay',
    audienceNote:
      'eBay buyers often search with model numbers, exact specs, and condition keywords. ' +
      'Titles benefit from front-loaded specific terms over emotional language.',
    maxTitleLength: 80,
    maxTags: 0, // eBay не использует теги в том же смысле, что Etsy
    maxTagLength: 0,
  },
};

module.exports = { marketplaceProfiles };
