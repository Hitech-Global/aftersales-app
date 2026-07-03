// ==================== i18n 语言包系统 ====================
// 支持 zh-CN / en-US / id-ID 三语言切换
// 所有文案通过 t('key.path', {params}) 获取
// 使用: <script src="locales/i18n.js"></script>
// 必须在页面初始化前加载

window.__i18n = (function() {
  'use strict';

  const SUPPORTED_LOCALES = ['zh-CN', 'en-US', 'id-ID'];
  const LOCALE_LABELS = {
    'zh-CN': '中文',
    'en-US': 'English',
    'id-ID': 'Bahasa Indonesia'
  };
  const LOCALE_FLAGS = {
    'zh-CN': '🇨🇳',
    'en-US': '🇺🇸',
    'id-ID': '🇮🇩'
  };
  const STORAGE_KEY = 'aftersales_locale';
  const LOCALE_DIR = 'locales';

  // 当前语言
  let _currentLocale = localStorage.getItem(STORAGE_KEY) || 'zh-CN';
  if (!SUPPORTED_LOCALES.includes(_currentLocale)) _currentLocale = 'zh-CN';

  // 语言包缓存: { 'zh-CN': {...}, 'en-US': {...}, 'id-ID': {...} }
  let _bundles = {};

  // 变更监听器列表
  let _listeners = [];

  // --- 加载语言包 ---
  async function loadBundle(locale) {
    if (_bundles[locale]) return _bundles[locale];
    try {
      const resp = await fetch(`${LOCALE_DIR}/${locale}.json`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      _bundles[locale] = await resp.json();
      return _bundles[locale];
    } catch (e) {
      console.error(`[i18n] Failed to load ${locale}:`, e);
      // fallback: 返回空对象以避免崩溃
      _bundles[locale] = {};
      return _bundles[locale];
    }
  }

  // --- 获取翻译 ---
  function t(path, params) {
    // path: "app.title" 或 "list.batch.selected"
    if (!path) return '';

    const bundle = _bundles[_currentLocale] || _bundles['zh-CN'] || {};
    const parts = path.split('.');
    let value = bundle;
    for (const p of parts) {
      if (value == null || typeof value !== 'object') return path; // key 不存在则返回 key 本身
      value = value[p];
    }

    // 如果最终值不是字符串，返回 path
    if (typeof value !== 'string') {
      // 尝试从 zh-CN fallback
      if (_currentLocale !== 'zh-CN' && _bundles['zh-CN']) {
        let zhVal = _bundles['zh-CN'];
        for (const p of parts) {
          if (zhVal == null || typeof zhVal !== 'object') return value || '';
          zhVal = zhVal[p];
        }
        if (typeof zhVal === 'string' && zhVal) return zhVal;
      }
      return value || '';
    }

    // 如果值为空字符串，尝试 zh-CN fallback
    if (!value && _currentLocale !== 'zh-CN' && _bundles['zh-CN']) {
      let zhVal = _bundles['zh-CN'];
      for (const p of parts) {
        if (zhVal == null || typeof zhVal !== 'object') break;
        zhVal = zhVal[p];
      }
      if (typeof zhVal === 'string' && zhVal) value = zhVal;
    }

    // 替换动态变量 {name}, {count} 等
    if (params && value.includes('{')) {
      value = value.replace(/\{(\w+)\}/g, (match, key) => {
        return params[key] !== undefined ? params[key] : match;
      });
    }

    return value;
  }

  // --- 切换语言 ---
  async function setLocale(locale) {
    if (!SUPPORTED_LOCALES.includes(locale)) return;
    if (locale === _currentLocale && _bundles[locale]) return;

    _currentLocale = locale;
    localStorage.setItem(STORAGE_KEY, locale);

    // 预加载语言包
    await loadBundle(locale);

    // 更新 HTML lang 属性
    document.documentElement.lang = locale;

    // 通知所有监听器
    _listeners.forEach(fn => {
      try { fn(locale); } catch (e) { console.error('[i18n] listener error:', e); }
    });
  }

  // --- 注册变更监听器 ---
  function onChange(fn) {
    if (typeof fn === 'function') _listeners.push(fn);
  }

  // --- 获取当前语言 ---
  function getLocale() { return _currentLocale; }

  // --- 获取支持的语言列表 ---
  function getSupportedLocales() { return [...SUPPORTED_LOCALES]; }

  // --- 获取语言显示名 ---
  function getLocaleLabel(locale) { return LOCALE_LABELS[locale] || locale; }
  function getLocaleFlag(locale) { return LOCALE_FLAGS[locale] || ''; }

  // --- 初始化：预加载 zh-CN + 当前语言 ---
  async function init() {
    // 首先加载 zh-CN（作为 fallback）
    await loadBundle('zh-CN');
    // 如果当前语言不是 zh-CN，也加载
    if (_currentLocale !== 'zh-CN') {
      await loadBundle(_currentLocale);
    }
    // 设置 HTML lang
    document.documentElement.lang = _currentLocale;
  }

  // --- 验证：检查某个 key 是否在所有语言包中都存在 ---
  function validate() {
    const zh = _bundles['zh-CN'] || {};
    const results = { total: 0, missing: {} };

    function walk(obj, prefix) {
      for (const key of Object.keys(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof obj[key] === 'string') {
          results.total++;
          // 检查其他语言包
          for (const loc of SUPPORTED_LOCALES) {
            if (loc === 'zh-CN') continue;
            const bundle = _bundles[loc] || {};
            const parts = fullKey.split('.');
            let val = bundle;
            let found = true;
            for (const p of parts) {
              if (val == null || typeof val !== 'object') { found = false; break; }
              val = val[p];
            }
            if (!found || val == null) {
              if (!results.missing[loc]) results.missing[loc] = [];
              results.missing[loc].push(fullKey);
            }
          }
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          walk(obj[key], fullKey);
        }
      }
    }

    walk(zh, '');
    return results;
  }

  // 暴露 API
  return {
    t,
    setLocale,
    getLocale,
    getSupportedLocales,
    getLocaleLabel,
    getLocaleFlag,
    onChange,
    init,
    validate,
    loadBundle,
    bundle: function(locale) { return _bundles[locale] || null; },
    SUPPORTED_LOCALES,
    LOCALE_LABELS,
    LOCALE_FLAGS
  };
})();

// 全局快捷函数
window.t = function(path, params) { return window.__i18n.t(path, params); };
window.setLocale = function(locale) { return window.__i18n.setLocale(locale); };
window.getLocale = function() { return window.__i18n.getLocale(); };
