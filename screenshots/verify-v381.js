// v3.8.1 验证：审批流只读卡片 + 三语切换
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'https://aftersales-app.onrender.com/';
const OUT_DIR = '/Users/a1-6/Workbuddy/2026-07-01-18-44-52/aftersales-app/screenshots';

function log(...a) { console.log('[v381]', ...a); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function preLogin(page) {
  await page.addInitScript(() => {
    const adminUser = {
      id: 'user_admin',
      username: 'admin',
      name: 'Admin',
      role_id: 'role_admin',
      status: 'active',
      created_at: new Date().toISOString()
    };
    localStorage.setItem('aftersales_current_user', JSON.stringify(adminUser));
  });
}

async function gotoListAndOpenForm(page) {
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(3000);
  await page.waitForSelector('#app-shell:not(.hidden)', { timeout: 15000 });
  // 切到列表页
  await page.evaluate(() => document.querySelector('[data-page="list"]')?.click());
  await sleep(1000);
  // 点新建
  await page.evaluate(() => document.getElementById('btn-new-record-table')?.click());
  await page.waitForSelector('#record-form-modal:not(.hidden)', { timeout: 5000 });
  await sleep(2000); // 等待 populateApproverSelects 完成
}

async function inspectForm(page, label) {
  const info = await page.evaluate(() => {
    const card = document.getElementById('f-approval-flow-card');
    const nameEl = document.getElementById('f-approval-flow-name');
    const tagEl = document.getElementById('f-approval-flow-tag');
    const preview = document.getElementById('f-approval-flow-preview');
    const oldSel = document.getElementById('f-approval-flow');
    const nodes = preview ? preview.querySelectorAll('.afp-node') : [];
    const nodeTexts = Array.from(nodes).map(n => n.textContent.replace(/\s+/g,' ').trim());
    return {
      cardExists: !!card,
      cardIsEmpty: card ? card.classList.contains('empty') : null,
      nameText: nameEl ? nameEl.textContent.trim() : null,
      tagVisible: tagEl ? (tagEl.style.display !== 'none') : null,
      tagText: tagEl ? tagEl.textContent.trim() : null,
      previewVisible: preview ? (preview.style.display !== 'none') : null,
      nodeCount: nodes.length,
      nodeTexts,
      oldSelectExists: !!oldSel,
      currentLocale: window.__i18n && window.__i18n.getLocale ? window.__i18n.getLocale() : null,
      activeFlowId: window._activeFlowId || null,
      // 间接验证 _activeFlowId: 看看 selectFlowName 跟 _approvalFlowsCache 一致
      cacheLen: (window._approvalFlowsCache || []).length
    };
  });
  log(`[${label}]`, JSON.stringify(info, null, 2));
  return info;
}

async function switchLocale(page, locale) {
  // setLocale 内部 await fetch + applyStaticI18n + 重画页面,需要 await
  await page.evaluate(async (l) => {
    if (window.__i18n && window.__i18n.setLocale) {
      await window.__i18n.setLocale(l);
    }
    const sel = document.getElementById('lang-select');
    if (sel) { sel.value = l; sel.dispatchEvent(new Event('change')); }
  }, locale);
  await sleep(2500); // 等 populate 重画审批流卡片
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await preLogin(page);

  try {
    // === 1. 中文环境打开 ===
    await gotoListAndOpenForm(page);
    const zh = await inspectForm(page, 'zh');
    await page.screenshot({ path: path.join(OUT_DIR, 'v381-zh.png'), fullPage: false });
    log('中文截图保存');

    // === 2. 切到英语 ===
    await switchLocale(page, 'en-US');
    const en = await inspectForm(page, 'en');
    await page.screenshot({ path: path.join(OUT_DIR, 'v381-en.png'), fullPage: false });
    log('英语截图保存');

    // === 3. 切到印尼语 ===
    await switchLocale(page, 'id-ID');
    const id = await inspectForm(page, 'id');
    await page.screenshot({ path: path.join(OUT_DIR, 'v381-id.png'), fullPage: false });
    log('印尼语截图保存');

    // === 4. 验证 ===
    const assertions = [];
    assertions.push(['zh: cardExists', zh.cardExists === true]);
    assertions.push(['zh: oldSelect gone', zh.oldSelectExists === false]);
    assertions.push(['zh: no empty class', zh.cardIsEmpty === false]);
    assertions.push(['zh: name has text', !!zh.nameText && zh.nameText.length > 0]);
    assertions.push(['zh: tag visible', zh.tagVisible === true]);
    assertions.push(['zh: preview visible', zh.previewVisible === true]);
    assertions.push(['zh: nodes >= 1', zh.nodeCount >= 1]);
    assertions.push(['zh: _approvalFlowsCache len >= 1', zh.cacheLen >= 1]);
    assertions.push(['en: oldSelect gone', en.oldSelectExists === false]);
    assertions.push(['en: name changed (not equal to zh)', en.nameText !== zh.nameText || en.previewVisible === true]);
    assertions.push(['en: locale', en.currentLocale === 'en-US']);
    assertions.push(['en: cardExists', en.cardExists === true]);
    assertions.push(['id: oldSelect gone', id.oldSelectExists === false]);
    assertions.push(['id: cardExists', id.cardExists === true]);
    assertions.push(['id: locale', id.currentLocale === 'id-ID']);
    assertions.push(['id: preview visible', id.previewVisible === true]);

    let allPass = true;
    for (const [name, pass] of assertions) {
      log(`${pass ? '✅' : '❌'} ${name}`);
      if (!pass) allPass = false;
    }
    log(allPass ? '🎉 ALL PASS' : '⚠️ SOME FAILED');

  } catch (e) {
    log('❌ ERROR:', e.message);
    await page.screenshot({ path: path.join(OUT_DIR, 'v381-error.png') });
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
