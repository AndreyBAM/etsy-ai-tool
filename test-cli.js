/**
 * test-cli.js
 * ---------------------------------------------------------------------
 * Быстрый способ прогнать ядро без сервера и без расширения.
 * Как раз то, что нужно для недели 1-2 плана: прогнать 10 реальных
 * плохих украинских листингов и посмотреть на результат до того,
 * как писать хоть строчку кода расширения.
 *
 * Запуск:
 *   ANTHROPIC_API_KEY=sk-ant-... node test-cli.js "Тут опис товару українською"
 * ---------------------------------------------------------------------
 */

const { generateListing } = require('./src/core/generateListing');

async function main() {
  const rawText = process.argv[2];
  const sourceLang = process.argv[3]; // необязательно, например "tr", "vi", "id" — если не указан, Claude определит язык сам
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!rawText) {
    console.error('Usage: ANTHROPIC_API_KEY=... node test-cli.js "текст листинга на любом языке" [код_языка]');
    process.exit(1);
  }
  if (!apiKey) {
    console.error('Missing ANTHROPIC_API_KEY environment variable.');
    process.exit(1);
  }

  console.log('Generating...\n');

  try {
    const result = await generateListing(
      { rawText, sourceLang },
      { apiKey, marketplace: 'etsy' }
    );

    console.log('TITLE:\n', result.title, '\n');
    console.log('TAGS:\n', result.tags.join(', '), '\n');
    console.log('DESCRIPTION:\n', result.description, '\n');
  } catch (err) {
    console.error('Generation failed:', err.message);
    process.exit(1);
  }
}

main();
