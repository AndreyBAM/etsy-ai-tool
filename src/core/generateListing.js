/**
 * generateListing.js
 * ---------------------------------------------------------------------
 * ПЛАТФОРМО-НЕЗАВИСИМОЕ ядро. Единственная точка входа для генерации.
 * Ничего не знает про DOM, про Etsy-редактор, про Chrome-расширение.
 * Вход: сырой текст продавца. Выход: {title, titleTranslation, tags,
 * tagsTranslation, description, descriptionTranslation}.
 *
 * v3 (сентябрь 2026): к каждому полю добавлен перевод на язык
 * продавца (см. promptBuilder.js v3) — чтобы продавец мог сам
 * проверить смысл английского текста без похода к переводчику.
 * Схема результата для 1 заголовка и 1 описания не изменилась —
 * это уже было так в этой версии кода.
 *
 * Требует Node.js 18+ (глобальный fetch).
 * ---------------------------------------------------------------------
 */

const { buildSystemPrompt, buildUserPrompt, buildTagRepairPrompt } = require('./promptBuilder');
const { marketplaceProfiles } = require('./marketplaceProfiles');
const { findDiversityViolations } = require('./tagDiversity');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

// --- Схемы для принудительного tool use ---------------------------------
// Вместо того чтобы просить модель "выведи только JSON" (ненадёжно —
// prefill эта модель не поддерживает, а текстовые инструкции игнорируются
// на практике, см. лог с "I need to track which tags..."), мы заставляем
// её вызвать конкретный "инструмент" с конкретной схемой полей. Формат
// ответа в этом случае гарантирует сам Anthropic API, а не наша просьба.
const LISTING_TOOL = {
  name: 'submit_listing',
  description: 'Submit the generated Etsy listing content, in English, plus a translation of each field back into the seller\'s own language so they can verify it themselves.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      titleTranslation: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      tagsTranslation: { type: 'array', items: { type: 'string' } },
      description: { type: 'string' },
      descriptionTranslation: { type: 'string' },
    },
    required: ['title', 'titleTranslation', 'tags', 'tagsTranslation', 'description', 'descriptionTranslation'],
  },
};

const TAGS_TOOL = {
  name: 'submit_tags',
  description: 'Submit the revised list of Etsy tags, in English, plus their translation into the seller\'s language in the same order.',
  input_schema: {
    type: 'object',
    properties: {
      tags: { type: 'array', items: { type: 'string' } },
      tagsTranslation: { type: 'array', items: { type: 'string' } },
    },
    required: ['tags', 'tagsTranslation'],
  },
};

/**
 * @param {import('./promptBuilder').GenerationInput} input
 * @param {Object} options
 * @param {string} options.apiKey - Anthropic API key (никогда не хранить в коде расширения!)
 * @param {string} [options.marketplace='etsy']
 * @returns {Promise<{title: string, titleTranslation: string, tags: string[], tagsTranslation: string[], description: string, descriptionTranslation: string}>}
 */
async function generateListing(input, options) {
  const { apiKey, marketplace = 'etsy' } = options;

  if (!apiKey) {
    throw new Error('generateListing: apiKey is required (never call this from client-side/extension code directly — go through the backend proxy).');
  }
  if (!input || !input.rawText || !input.rawText.trim()) {
    throw new Error('generateListing: input.rawText is required.');
  }

  const profile = marketplaceProfiles[marketplace];
  if (!profile) {
    throw new Error(`generateListing: unknown marketplace "${marketplace}". Known: ${Object.keys(marketplaceProfiles).join(', ')}`);
  }

  const systemPrompt = buildSystemPrompt(profile);
  const userPrompt = buildUserPrompt(input);

  const parsed = await callClaudeTool(systemPrompt, userPrompt, apiKey, LISTING_TOOL);
  validateFields(parsed, ['title', 'titleTranslation', 'tags', 'tagsTranslation', 'description', 'descriptionTranslation']);
  validateTagsAlignment(parsed.tags, parsed.tagsTranslation);

  // --- проверка разнообразия тегов в коде (не доверяем модели "посчитать самой") ---
  const violations = findDiversityViolations(parsed.tags);
  if (violations.length > 0) {
    console.warn('[tagDiversity] violations found, attempting one repair pass:', violations);
    try {
      const repairPrompt = buildTagRepairPrompt(
        parsed.tags,
        parsed.tagsTranslation,
        violations,
        profile,
        input.sourceLang
      );
      const repaired = await callClaudeTool(
        'You are fixing tag diversity in an Etsy listing. Follow the instructions exactly.',
        repairPrompt,
        apiKey,
        TAGS_TOOL
      );
      validateFields(repaired, ['tags', 'tagsTranslation']);
      validateTagsAlignment(repaired.tags, repaired.tagsTranslation);

      const stillViolating = findDiversityViolations(repaired.tags);
      if (stillViolating.length > 0) {
        // Не зацикливаемся на повторных попытках — логируем и отдаём лучший
        // из двух результатов, чтобы не тормозить и не тратить лишние токены.
        console.warn('[tagDiversity] still violating after repair, keeping repaired result anyway:', stillViolating);
      }
      parsed.tags = repaired.tags;
      parsed.tagsTranslation = repaired.tagsTranslation;
    } catch (err) {
      // Ремонт не должен ронять весь запрос — если он не удался,
      // отдаём пользователю первоначальный (пусть не идеальный) результат.
      console.error('[tagDiversity] repair pass failed, returning original tags:', err.message);
    }
  }

  return parsed;
}

/**
 * Один вызов Anthropic API с принудительным tool_choice — модель ОБЯЗАНА
 * ответить вызовом инструмента с аргументами, соответствующими схеме.
 * Никакого текста, рассуждений или markdown-обёрток в ответе физически
 * не может оказаться — это гарантия API, а не просьба к модели.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {string} apiKey
 * @param {Object} tool - схема инструмента (LISTING_TOOL или TAGS_TOOL)
 * @returns {Promise<Object>} уже готовый распарсенный объект (tool_use.input)
 */
async function callClaudeTool(systemPrompt, userPrompt, apiKey, tool) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const toolBlock = (data.content || []).find((b) => b.type === 'tool_use');
  if (!toolBlock) {
    throw new Error('generateListing: no tool_use block in Claude response — unexpected response shape.');
  }
  return toolBlock.input; // уже настоящий JS-объект, парсинг не нужен
}

/**
 * @param {Object} obj
 * @param {string[]} requiredFields
 */
function validateFields(obj, requiredFields) {
  for (const field of requiredFields) {
    const isArrayField = field === 'tags' || field === 'tagsTranslation';
    const missing = isArrayField ? !Array.isArray(obj[field]) : !obj[field];
    if (missing) {
      throw new Error(`generateListing: response missing required field "${field}".`);
    }
  }
}

/**
 * tagsTranslation должен быть тем же по длине списком, что и tags,
 * иначе на фронтенде перевод разъедется с оригинальными тегами по индексу.
 * Не бросаем ошибку на пустячных расхождениях длины (модель иногда
 * пропускает один тег) — вместо этого просто выравниваем массив,
 * дублируя оригинальный тег там, где перевода не хватает, чтобы
 * не ронять всю генерацию из-за этого частного случая.
 *
 * @param {string[]} tags
 * @param {string[]} tagsTranslation
 */
function validateTagsAlignment(tags, tagsTranslation) {
  if (tagsTranslation.length === tags.length) return;

  console.warn(
    `[generateListing] tagsTranslation length (${tagsTranslation.length}) doesn't match tags length (${tags.length}) — padding/truncating to align.`
  );

  while (tagsTranslation.length < tags.length) {
    tagsTranslation.push(tags[tagsTranslation.length]);
  }
  tagsTranslation.length = tags.length;
}

module.exports = { generateListing };
