const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SHOTS = path.resolve(__dirname);
const URL = 'https://aftersales-app.onrender.com';

const adminUser = {
  id: 'user_admin', username: 'admin', name: 'Admin',
  role_id: 'role_admin', status: 'active',
  created_at: new Date().toISOString()
};

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function inject(page) {
  await page.addInitScript((u) => {
    localStorage.setItem('aftersales_current_user', JSON.stringify(u));
  }, adminUser);
}

async function openForm(page) {
  log('→ navigating to', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  log('→ page loaded');
  await sleep(2000);
  // 1) 进入售后记录列表页
  const navOk = await page.evaluate(() => {
    try {
      if (typeof showPage === 'function') { showPage('list'); return 'showPage'; }
      const nav = document.querySelector('[data-page="list"]');
      if (nav) { nav.click(); return 'nav-click'; }
      return 'none';
    } catch (e) { return 'err:' + e.message; }
  });
  log('→ nav result:', navOk);
  await sleep(2000);
  // 2) 点击"手动创建/新建记录"按钮
  const clickOk = await page.evaluate(() => {
    const btn = document.getElementById('btn-new-record-table');
    if (btn) { btn.click(); return 'btn-new-record-table'; }
    const any = Array.from(document.querySelectorAll('button'))
      .find(b => /手动|创建第一个|Create|新建.*RMA|Manual/i.test(b.textContent || ''));
    if (any) { any.click(); return 'any-btn:' + (any.textContent || '').trim().slice(0, 20); }
    return 'no-btn';
  });
  log('→ click result:', clickOk);
  await sleep(4000); // 等 Promise.all fetch 完成 + 节点预览渲染
}

async function inspect(page) {
  const info = await page.evaluate(() => {
    const card = document.getElementById('f-approval-flow-card');
    const nameEl = document.getElementById('f-approval-flow-name');
    const preview = document.getElementById('f-approval-flow-preview');
    const oldSel = document.getElementById('f-approval-flow');
    const nodes = preview ? preview.querySelectorAll('.afp-node') : [];
    return {
      cardExists: !!card,
      nameText: nameEl ? nameEl.textContent.trim() : null,
      previewVisible: preview ? (preview.style.display !== 'none') : null,
      nodeCount: nodes.length,
      nodeTexts: Array.from(nodes).map(n => n.textContent.replace(/\s+/g, ' ').trim()),
      oldSelectExists: !!oldSel,
      locale: window.__i18n && window.__i18n.getLocale ? window.__i18n.getLocale() : null
    };
  });
  return info;
}

async function setLocale(page, locale) {
  await page.evaluate(async (l) => {
    if (window.__i18n && window.__i18n.setLocale) await window.__i18n.setLocale(l);
  }, locale);
  await sleep(2000);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await inject(ctx);
  const page = await ctx.newPage();

  let allOk = true;
  const logAssert = (name, ok, extra='') => {
    if (!ok) allOk = false;
    log(`${ok ? '✅' : '❌'} ${name} ${extra}`);
  };

  try {
    await openForm(page);

    for (const locale of ['zh-CN', 'en-US', 'id-ID']) {
      await setLocale(page, locale);
      const info = await inspect(page);
      const tag = locale.split('-')[0];
      log(`\n[${locale}]`, JSON.stringify(info, null, 2));
      logAssert(`${tag}: card exists`, info.cardExists === true);
      logAssert(`${tag}: old select gone`, info.oldSelectExists === false);
      logAssert(`${tag}: preview visible`, info.previewVisible === true);
      logAssert(`${tag}: at least 1 node`, info.nodeCount >= 1);
      // 核心验证: 节点文本里不应出现 (user_xxx) 这种 ID 形式
      const hasIdOnly = info.nodeTexts.some(t => /\(user_[a-z0-9]+\)/i.test(t));
      logAssert(`${tag}: no (user_xxx) ID fallback`, !hasIdOnly,
                hasIdOnly ? `命中: ${info.nodeTexts.find(t => /\(user_/.test(t))}` : '');
      // 节点文本应包含名字(非空)
      const hasName = info.nodeTexts.some(t => t.length > 'L1 · '.length);
      logAssert(`${tag}: has name in node`, hasName);
      // 截图
      const shotPath = path.join(SHOTS, `v382-${tag}.png`);
      await page.screenshot({ path: shotPath, fullPage: false });
      log(`📸 ${shotPath}`);
    }
  } catch (e) {
    log('ERROR:', e.message);
    allOk = false;
  }

  await browser.close();
  log(`\n=== ${allOk ? 'ALL PASS' : 'FAILED'} ===`);
  process.exit(allOk ? 0 : 1);
})();
