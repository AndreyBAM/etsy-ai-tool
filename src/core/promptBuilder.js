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
 *
 * v3 (сентябрь 2026) — пересмотр по итогам двух рекламных кампаний
 * (0 покупок при ~78% пользователей с одной генерацией). Гипотеза v2
 * ("больше вариантов вывода = выше retention") не подтвердилась —
 * решено, что проблема, вероятнее всего, в доверии к результату
 * (продавец не может сам прочитать английский текст и оценить его
 * качество) и в риске выдуманных моделью деталей, а не в количестве
 * вариантов. Поэтому:
 *   - 3 заголовка -> 1 заголовок (более разнообразный по формулировке
 *     между разными товарами, но БЕЗ дефолтной подарочной рамки)
 *   - 2 описания -> 1 описание
 *   - добавлен перевод заголовка, описания и тегов обратно на язык
 *     продавца — чтобы он мог сверить смысл без похода в переводчик
 *   - отдельный проверочный API-вызов на "достоверность" отменён
 *     (дороже по деньгам и по времени ответа); вместо него в конце
 *     system-промпта добавлен явный self-check-шаг внутри ОДНОГО
 *     и того же вызова модели
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
 *   если не передан, Claude сам определит язык по тексту и переведёт результат на него же.
 *   Поддерживается ЛЮБОЙ язык на входе, список языков нигде не захардкожен и не ограничен.
 * @property {string} [category] - категория товара, если известна (например "Jewelry").
 *   Необязательное поле — если продавец не выбрал категорию в форме, просто не передаётся.
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

The seller may write their input in ANY language (Ukrainian, Turkish, Vietnamese, Indonesian, Polish, or any other language). If the input language isn't stated, detect it yourself from the text — call this "the seller's language" for the rest of these instructions. Regardless of the input language, the listing itself (title, tags, description) must always be written in natural, native-sounding English — that is the one and only language buyers on ${profile.name} search and shop in.

However, you must ALSO provide a translation of the title, description, and tags back into the seller's language, so the seller — who may not read English well — can verify for themselves that the English version says what they meant, without needing an outside translator. The translation is for the seller's own understanding only; it should read naturally in their language, not be a stiff word-for-word gloss.

Rules:

1. Preserve every factual detail from the seller's input (materials, size, color, what it is, who it's for). Never invent facts that weren't given. It's fine — expected, even — for the input to be short; write compelling, persuasive copy from a short input too, but persuasion must come from tone, structure, and general appeal, never from adding specific unconfirmed facts (a material, a size, a price point, a named audience, a certification, an origin story) that the seller did not state.

2. CRITICAL — never add unverifiable claims about origin, authenticity, certification, eco-friendliness, or safety that the seller did not state. For example, if the seller wrote "amber" but did not say "Baltic amber" or "certified" or "genuine", do NOT add those words yourself; if the seller described a natural material but never said "eco-friendly" or "sustainable" or "non-toxic", do NOT add those claims either. This also applies to material/technique specificity: if the seller gave a general term (e.g. "ceramic", "wood", "fabric") but did not name a more precise technical variant (e.g. "stoneware", "walnut", "linen"), do NOT upgrade to the more specific term yourself — keep the general word the seller actually used. On marketplaces like Etsy, unverified claims (especially about gemstones, materials, safety, or environmental impact) can get a seller's listing removed or their account suspended. When in doubt, use the more neutral, literal term the seller actually used instead of a stronger unverified one.

2b. CRITICAL — do not invent any of the following unless the seller's input explicitly states it: product functions or protective properties (e.g. "protects your jewelry", "keeps it safe"), packaging or gift-ready shipping/presentation claims, engraving/personalization/customization, a claim that each piece is unique or "one of a kind" (handmade alone does not imply this), a specific use case the seller didn't mention, or exact dimensions/finishes/safety features. Do NOT add "for her", "for women", "for men", or any gender- or recipient-specific phrasing to the title, tags, or description unless the seller explicitly named a recipient's gender or identity — a mention that the item "can also be sold as a gift" is NOT permission to assume who it's for. You may make the copy more attractive through tone, structure, and framing, but every concrete product claim must trace back to the seller's original input; if a detail is missing, omit it rather than guessing.

3. Write exactly ONE title, under ${profile.maxTitleLength} characters, front-loaded with the most likely buyer search terms, in a natural, native-sounding style. Do NOT default to a gift/occasion framing ("perfect gift for...", "great gift idea") unless the seller's own input actually gives a reason to — for example they mentioned a recipient, an occasion, or said it's meant as a gift. If nothing in the input suggests a gift context, write the title around what the product literally is and who would search for it, not around who might receive it as a present.

4. CRITICAL — tag diversity, checked by counting, not by impression: treat any grammatical variant of the same root (e.g. "mug"/"mugs", "wallet"/"wallets", "necklace"/"necklaces") as ONE keyword. Across all ${profile.maxTags} tags combined, that same root keyword may appear in AT MOST 2 tags — not 3, not 4. Before writing your final answer, count the occurrences of the product's main keyword across every tag yourself. If the count is 3 or higher, delete the extra tags and replace them with tags built from a genuinely different search angle instead — but only angles grounded in what the seller actually said: a stated occasion, a stated recipient, a stated material or technique, a stated use case, or a stated room/setting. Do NOT invent a price positioning, an audience, or a style/aesthetic the seller did not mention just to fill a diversity slot — an on-topic tag that repeats a root word once too often is better than an off-topic tag built on a guess. Maximize variety only among angles that are actually true of this product. Also never swap in a different technique or product category than the seller stated to manufacture a "new" angle — e.g. if the seller said "carved", do not write a tag with "engraved" instead; if the seller described a jewelry box, do not relabel it as an "organizer" or any other product type just to diversify.

5. Write exactly ONE description: a strong hook first line, then 2-5 short benefit-focused lines or bullet-style sentences using only facts the seller gave, then a brief closing line. Persuasive and warm in tone, but every concrete claim in it must trace back to something the seller actually said.

6. SELF-CHECK before you output anything: once you have drafted the title, tags, and description, re-read each of them one more time side by side with the seller's original input. Check specifically for these categories of unstated additions, since they are easy to slip in without noticing: (a) material, size, color, price, style, or certification words; (b) recipient gender ("for her"/"for women"/etc.) or any named audience; (c) a claimed function or protective property; (d) packaging, gift-wrapping, or "ready to ship/gift" claims; (e) engraving, personalization, or customization; (f) a uniqueness claim ("one of a kind", "each piece varies"). For every instance in any of these categories, confirm it was explicitly present in the seller's input. If you find one that was NOT — remove it or replace it with the seller's actual (more general) wording before producing your final answer. Do this check silently; do not show your reasoning, only the final corrected JSON.

7. Translate the final title, description, and every tag into the seller's language (the language you detected or were told for their input). Keep the same meaning and tone as the English version — this translation is only so the seller can verify the content, not a second independent piece of copy.

8. Output ONLY valid JSON, no markdown fences, no commentary, in this exact shape:
{"title": "...", "titleTranslation": "...", "tags": ["...", "..."], "tagsTranslation": ["...", "..."], "description": "...", "descriptionTranslation": "..."}

The "tagsTranslation" array must have exactly the same number of items as "tags", in the same order, so each tag and its translation line up.`;
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

  parts.push(
    'Rewrite this into a native-sounding, buyer-optimized English listing with one title, one description, and the tags — plus a translation of the title, description, and each tag back into the seller\'s own language so they can verify it themselves. Return JSON only.'
  );

  return parts.join('\n\n');
}

/**
 * Собирает промпт для точечного "ремонта" тегов — используется только
 * когда tagDiversity.js обнаружил РЕАЛЬНОЕ (посчитанное в коде, не
 * моделью) нарушение правила разнообразия тегов после первой генерации.
 * Не трогает title/description — только пересобирает список тегов
 * (и их переводы, чтобы они не разъехались с английской версией).
 *
 * @param {string[]} originalTags
 * @param {string[]} originalTagsTranslation - переводы тегов в том же порядке, что originalTags
 * @param {Array<{word: string, count: number}>} violations
 * @param {MarketplaceProfile} profile
 * @param {string} [sourceLang] - язык, на который нужно перевести обновлённые теги
 * @returns {string}
 */
function buildTagRepairPrompt(originalTags, originalTagsTranslation, violations, profile, sourceLang) {
  const violationLines = violations
    .map((v) => `- "${v.word}" appears in ${v.count} tags (limit is 2)`)
    .join('\n');

  const langLine = sourceLang
    ? `Also provide "tagsTranslation": the same ${profile.maxTags} tags translated into the seller's language (${sourceLang}), in the same order, so they line up with "tags".`
    : `Also provide "tagsTranslation": the same ${profile.maxTags} tags translated into the same language as the original translated tags below, in the same order, so they line up with "tags".`;

  return `Here are ${profile.maxTags} Etsy search tags you generated for a product, with their translation for the seller's reference:
Tags: ${JSON.stringify(originalTags)}
Tags translation: ${JSON.stringify(originalTagsTranslation)}

A code-level check (exact count, not an estimate) found these tag-diversity rule violations:
${violationLines}

Rewrite the FULL list of ${profile.maxTags} tags, each under ${profile.maxTagLength} characters, fixing ONLY the diversity problem: replace tags so that no keyword (or grammatical variant of it) appears in more than 2 tags total. Keep the tags that were already fine. Replace the excess ones with genuinely different buyer search angles, but ONLY angles grounded in facts already implied by the existing tags/product — do not invent a price positioning, an audience, or a style that isn't already evident. Keep every tag relevant to the same product.

${langLine}

Output ONLY valid JSON, no markdown fences, no commentary, in this exact shape:
{"tags": ["...", "..."], "tagsTranslation": ["...", "..."]}`;
}

module.exports = { buildSystemPrompt, buildUserPrompt, buildTagRepairPrompt };
