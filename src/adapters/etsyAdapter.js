/**
 * etsyAdapter.js
 * ---------------------------------------------------------------------
 * Реализация PlatformAdapter для Etsy.
 *
 * ⚠️ СТАТУС: ЗАГОТОВКА. Селекторы ниже — ориентировочные, основаны на
 * типичной структуре Etsy listing editor, но НЕ проверены вживую.
 * Согласно плану, эту часть осознанно откладываем до реального
 * фидбека от продавцов (см. обсуждение выше) — трогать только после
 * того, как откроете реальную страницу редактора листинга в DevTools
 * и сверите фактические selector'ы.
 *
 * Как проверить/обновить селекторы:
 * 1. Открыть Etsy → Shop Manager → Listings → New/Edit listing.
 * 2. DevTools → Elements → найти реальные id/data-атрибуты полей
 *    title / tags / description.
 * 3. Обновить SELECTORS ниже. Остальной код трогать не нужно.
 * ---------------------------------------------------------------------
 */

const { PlatformAdapter } = require('./PlatformAdapter');

const SELECTORS = {
  // TODO: сверить с реальной вёрсткой Etsy
  title: '#listing-title-input, input[name="title"]',
  tags: '#tags-input, input[name="tags"]',
  description: '#description-input, textarea[name="description"]',
};

class EtsyAdapter extends PlatformAdapter {
  static get platformKey() {
    return 'etsy';
  }

  isListingEditorPage() {
    if (typeof window === 'undefined') return false; // не в браузере (например, при юнит-тесте)
    return /etsy\.com\/.*\/(edit|create)/i.test(window.location.href);
  }

  readCurrentValues() {
    if (typeof document === 'undefined') return {};
    const titleEl = document.querySelector(SELECTORS.title);
    const descEl = document.querySelector(SELECTORS.description);
    return {
      title: titleEl ? titleEl.value : undefined,
      description: descEl ? descEl.value : undefined,
    };
  }

  writeValues(listing) {
    if (typeof document === 'undefined') return false;

    const titleEl = document.querySelector(SELECTORS.title);
    const descEl = document.querySelector(SELECTORS.description);
    const tagsEl = document.querySelector(SELECTORS.tags);

    let success = true;

    if (titleEl) {
      setNativeValue(titleEl, listing.title);
    } else {
      success = false;
    }

    if (descEl) {
      setNativeValue(descEl, listing.description);
    } else {
      success = false;
    }

    if (tagsEl && Array.isArray(listing.tags)) {
      // Etsy tags UI обычно требует отдельного клика/Enter на каждый тег —
      // это специфика, которую нужно будет доработать по факту тестирования.
      setNativeValue(tagsEl, listing.tags.join(', '));
    }

    return success;
  }
}

/**
 * React/Vue-контролируемые инпуты на Etsy могут игнорировать простое
 * el.value = "...". Этот хелпер эмулирует "настоящий" ввод пользователя,
 * чтобы фреймворк площадки заметил изменение.
 */
function setNativeValue(element, value) {
  const proto = Object.getPrototypeOf(element);
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  const nativeSetter = descriptor && descriptor.set;

  if (nativeSetter) {
    nativeSetter.call(element, value);
  } else {
    element.value = value;
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

module.exports = { EtsyAdapter };
