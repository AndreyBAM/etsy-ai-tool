/**
 * promptBuilder.js
 * ---------------------------------------------------------------------
 * ПЛАТФОРМО-НЕЗАВИСИМАЯ часть. Не знает про Etsy, eBay и т.д.
 * Задача: превратить "сырой" ввод продавца (родной язык) в чёткий
 * промпт для Claude, который вернёт готовый продающий английский текст.
 *
 * Если в будущем понадобится другая площадка (eBay, Amazon Handmade) —
 * этот файл менять не нужно. Меняется только marketplaceProfile,
 * который передаётся сюда как параметр (см. marketplaceProfiles.js).
 * ---------------------------------------------------------------------
 */

/**
 * @typedef {Object} MarketplaceProfile
 * @property {string} name - человекочитаемое имя площадки ("Etsy")
 * @property {string} audienceNote - краткое описание аудитории/специфики поиска
 * @property {number} maxTitleLength - лимит символов в заголовке
 * @property {number} maxTags - максимум тегов/ключевых слов
 * @property {number} maxTagLength - лимит символов на один тег
 */

/**
 * @typedef {Object} GenerationInput
 * @property {string} rawText - текст продавца на родном языке (описание товара своими словами)
 * @property {string} [sourceLang] - язык ввода, например "uk" (украинский). Необязательный —
 *   если не передан, Claude сам определит язык по тексту. Поддерживается ЛЮБОЙ язык на входе,
 *   список языков нигде не захардкожен и не ограничен.
 * @property {string} [category] - категория товара, если известна (например "handmade jewelry")
 * @property {string} [extraContext] - доп. контекст: материал, размер, для кого подарок и т.п.
 */

/**
 * Собирает system-промпт: общие правила "как думает Claude" для этой задачи.
 * Не зависит от конкретного товара — задаёт роль и формат ответа.
 *
 * @param {MarketplaceProfile} profile
 * @returns {string}
 */
function buildSystemPrompt(profile) {
  return `You are an expert e-commerce copywriter who specializes in ${profile.name} listings.
Your job is NOT to translate word-for-word. Your job is to rewrite the seller's product description
so it reads like it was written by a native English-speaking seller who deeply understands how buyers
on ${profile.name} actually search and shop.

Context about the platform's buyers: ${profile.audienceNote}

The seller may write their input in ANY language (Ukrainian, Turkish, Vietnamese, Indonesian, Polish, or any other language). If the input language isn't stated, detect it yourself from the text. Regardless of the input language, your output (title, tags, description) must always be in natural, native-sounding English — that is the one and only output language, because that is what the platform's search and buyers overwhelmingly use.

Rules:
1. Preserve every factual detail from the seller's input (materials, size, color, what it is, who it's for). Never invent facts that weren't given.
2. CRITICAL — never add unverifiable claims about origin, authenticity, certification, eco-friendliness, or safety that the seller did not state. For example, if the seller wrote "amber" but did not say "Baltic amber" or "certified" or "genuine", do NOT add those words yourself; if the seller described a natural material but never said "eco-friendly" or "sustainable" or "non-toxic", do NOT add those claims either. This also applies to material/technique specificity: if the seller gave a general term (e.g. "ceramic", "wood", "fabric") but did not name a more precise technical variant (e.g. "stoneware", "walnut", "linen"), do NOT upgrade to the more specific term yourself — keep the general word the seller actually used. On marketplaces like Etsy, unverified claims (especially about gemstones, materials, safety, or environmental impact) can get a seller's listing removed or their account suspended. When in doubt, use the more neutral, literal term the seller actually used instead of a stronger unverified one.
3. Write a title under ${profile.maxTitleLength} characters, front-loaded with the most likely buyer search terms.
4. CRITICAL — tag diversity, checked by counting, not by impression: treat any grammatical variant of the same root (e.g. "mug"/"mugs", "wallet"/"wallets", "necklace"/"necklaces") as ONE keyword. Across all ${profile.maxTags} tags combined, that same root keyword may appear in AT MOST 2 tags — not 3, not 4. Before writing your final answer, count the occurrences of the product's main keyword across every tag yourself. If the count is 3 or higher, delete the extra tags and replace them with tags built from a genuinely different search angle instead (occasion, recipient, aesthetic/style, use case, room, price positioning, gift-giving context, or a stated material/technique) — angles that do not contain the main keyword at all. Maximize the variety of distinct words covered across all tags combined; repeating the same word wastes search coverage on Etsy, where the search algorithm already recombines words across tags.
5. Write a persuasive but honest description: hook first line, then key details, then a warm closing line.
6. Output ONLY valid JSON, no markdown fences, no commentary, in this exact shape:
{"title": "...", "tags": ["...", "..."], "description": "..."}`;
}

/**
 * Собирает user-промпт: конкретный товар от конкретного продавца.
 *
 * @param {GenerationInput} input
 * @returns {string}
 */
function buildUserPrompt(input) {
  const langLabel = input.sourceLang
    ? `Seller's original description (language: ${input.sourceLang}):`
    : `Seller's original description (detect the language yourself):`;

  const parts = [
    langLabel,
    `"""${input.rawText}"""`,
  ];

  if (input.category) {
    parts.push(`Product category: ${input.category}`);
  }
  if (input.extraContext) {
    parts.push(`Additional context from seller: ${input.extraContext}`);
  }

  parts.push('Rewrite this into a native-sounding, buyer-optimized English listing. Return JSON only.');

  return parts.join('\n\n');
}

/**
 * Собирает промпт для точечного "ремонта" тегов — используется только
 * когда tagDiversity.js обнаружил РЕАЛЬНОЕ (посчитанное в коде, не
 * моделью) нарушение правила разнообразия тегов после первой генерации.
 * Не трогает title/description — только пересобирает список тегов.
 *
 * @param {string[]} originalTags
 * @param {Array<{word: string, count: number}>} violations
 * @param {MarketplaceProfile} profile
 * @returns {string}
 */
function buildTagRepairPrompt(originalTags, violations, profile) {
  const violationLines = violations
    .map((v) => `- "${v.word}" appears in ${v.count} tags (limit is 2)`)
    .join('\n');

  return `Here are ${profile.maxTags} Etsy search tags you generated for a product:
${JSON.stringify(originalTags)}

A code-level check (exact count, not an estimate) found these tag-diversity rule violations:
${violationLines}

Rewrite the FULL list of ${profile.maxTags} tags, each under ${profile.maxTagLength} characters, fixing ONLY the diversity problem: replace tags so that no keyword (or grammatical variant of it) appears in more than 2 tags total. Keep the tags that were already fine. Replace the excess ones with genuinely different buyer search angles (occasion, recipient, aesthetic/style, use case, room, price positioning, gift-giving context) that do not repeat the overused words. Keep every tag relevant to the same product.

Output ONLY valid JSON, no markdown fences, no commentary, in this exact shape:
{"tags": ["...", "..."]}`;
}

module.exports = { buildSystemPrompt, buildUserPrompt, buildTagRepairPrompt };
