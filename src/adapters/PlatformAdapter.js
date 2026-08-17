/**
 * PlatformAdapter.js
 * ---------------------------------------------------------------------
 * Контракт, который обязан реализовать адаптер КАЖДОЙ площадки
 * (Etsy, позже eBay и т.д.). Ядро генерации (generateListing.js)
 * про эти классы вообще не знает — связь идёт в обратную сторону:
 * адаптер вызывает ядро, а не наоборот.
 *
 * Работает в контексте content script в браузере (есть доступ к document).
 * Это чистый JS-класс без зависимостей от Chrome extension API,
 * чтобы его было легко тестировать отдельно.
 * ---------------------------------------------------------------------
 */

class PlatformAdapter {
  /** Уникальное имя площадки, должно совпадать с ключом в marketplaceProfiles.js */
  static get platformKey() {
    throw new Error('platformKey must be implemented by subclass');
  }

  /**
   * Определяет, находимся ли мы сейчас на странице редактора листинга
   * этой площадки (по URL и/или наличию нужных DOM-элементов).
   * @returns {boolean}
   */
  isListingEditorPage() {
    throw new Error('isListingEditorPage must be implemented by subclass');
  }

  /**
   * Читает то, что продавец уже ввёл в поля формы (если что-то есть) —
   * может использоваться, чтобы предзаполнить панель расширения.
   * @returns {{title?: string, tags?: string[], description?: string}}
   */
  readCurrentValues() {
    throw new Error('readCurrentValues must be implemented by subclass');
  }

  /**
   * Записывает сгенерированный текст в реальные поля формы площадки.
   * Это самая хрупкая часть — зависит от вёрстки, которая может измениться.
   * @param {{title: string, tags: string[], description: string}} listing
   * @returns {boolean} успех/неуспех записи
   */
  writeValues(listing) {
    throw new Error('writeValues must be implemented by subclass');
  }
}

module.exports = { PlatformAdapter };
