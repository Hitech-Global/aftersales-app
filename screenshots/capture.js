const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = path.join(__dirname);
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const BASE_URL = 'http://127.0.0.1:3000/';
const VIEWPORT = { width: 1400, height: 950 };

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function screenshot(page, name, fullPage = false) {
  const filePath = path.join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage });
  console.log(`✅ Saved: ${name}.png`);
  return filePath;
}

async function waitForPage(page, pageId, timeout = 8000) {
  await page.waitForFunction(
    (id) => document.querySelector(`.sidebar-item[data-page="${id}"]`)?.classList.contains('active'),
    { timeout },
    pageId
  );
  await sleep(500); // let content settle
}

async function switchToEnglish(page) {
  console.log('🌐 Switching to English...');
  await page.evaluate(() => {
    const select = document.getElementById('lang-select');
    if (select) {
      select.value = 'en-US';
      select.dispatchEvent(new Event('change'));
    } else if (window.__i18n) {
      window.__i18n.setLocale('en-US');
    }
  });
  await sleep(1200);
}

async function clickButtonByText(page, keywords) {
  await page.evaluate((kws) => {
    const btns = Array.from(document.querySelectorAll('button, .btn, a.btn'));
    for (const btn of btns) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if (kws.some(k => text.includes(k.toLowerCase()))) {
        btn.click();
        return true;
      }
    }
    return false;
  }, keywords);
}

async function closeAnyModal(page) {
  await page.evaluate(() => {
    const closeBtns = document.querySelectorAll('.modal-close, .modal-close-btn');
    closeBtns.forEach(b => b.click());
  });
  await sleep(400);
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  // Bypass login by pre-seeding localStorage with admin user
  await page.evaluateOnNewDocument(() => {
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

  try {
    // 0. Load app (auto-logged in via pre-seeded localStorage)
    console.log('🌐 Loading app...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2500);
    await page.waitForSelector('#app-shell:not(.hidden)', { timeout: 10000 });

    // Switch to English for screenshots
    await switchToEnglish(page);

    // 1. Dashboard / Overview page
    console.log('📸 Capturing dashboard...');
    await page.evaluate(() => document.querySelector('[data-page="overview"]')?.click());
    await waitForPage(page, 'overview');
    await screenshot(page, '01-dashboard');

    // 2. Records list page
    console.log('📸 Capturing records list...');
    await page.evaluate(() => document.querySelector('[data-page="list"]')?.click());
    await waitForPage(page, 'list');
    await screenshot(page, '02-records-list');

    // 3. Open the "New Record" form modal
    console.log('📸 Capturing new record form...');
    await page.evaluate(() => document.getElementById('btn-new-record-table')?.click());
    await sleep(800);
    await page.waitForSelector('#record-form-modal:not(.hidden)', { timeout: 5000 });
    await sleep(500);
    await screenshot(page, '03-new-record-form', true);
    await closeAnyModal(page);
    await waitForPage(page, 'list');

    // 4. Batch import modal
    console.log('📸 Capturing batch import...');
    await page.evaluate(() => document.getElementById('btn-import-records')?.click());
    await sleep(800);
    await page.waitForSelector('#import-modal:not(.hidden)', { timeout: 5000 });
    await sleep(500);
    await screenshot(page, '04-batch-import', true);
    await page.evaluate(() => { if (typeof closeImportDialog === 'function') closeImportDialog(); });
    await sleep(400);
    await waitForPage(page, 'list');

    // 5. Record detail page
    console.log('📸 Capturing record detail...');
    const hasRecords = await page.evaluate(() => {
      const rows = document.querySelectorAll('tr.row-clickable, .record-row');
      if (rows.length > 0) {
        rows[0].click();
        return true;
      }
      const viewBtns = document.querySelectorAll('.action-btn');
      if (viewBtns.length > 0) {
        viewBtns[0].click();
        return true;
      }
      return false;
    });
    if (hasRecords) {
      await sleep(1500);
      await screenshot(page, '05-record-detail');
    } else {
      console.log('⚠️ No records found for detail page');
    }

    // 6. Approval management page
    console.log('📸 Capturing approval page...');
    await page.evaluate(() => document.querySelector('[data-page="approval"]')?.click());
    await waitForPage(page, 'approval');
    await sleep(1000); // wait for table data
    await screenshot(page, '06-approval');

    // 7. Approval Flows config page
    console.log('📸 Capturing approval flows config...');
    await page.evaluate(() => document.querySelector('[data-page="approval-flows"]')?.click());
    await waitForPage(page, 'approval-flows');
    await sleep(2500); // wait for approval flow data to load
    await screenshot(page, '07-approval-flows');

    // 8. Login page (public, no login)
    console.log('📸 Capturing login page...');
    const loginContext = await browser.createIncognitoBrowserContext();
    const loginPage = await loginContext.newPage();
    await loginPage.setViewport(VIEWPORT);
    await loginPage.goto('http://127.0.0.1:3000/?admin', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(4000); // wait for Feishu status check to finish
    // Force show local login panel if still hidden
    await loginPage.evaluate(() => {
      const panel = document.getElementById('login-panel-admin');
      if (panel) panel.style.display = 'block';
      const loading = document.getElementById('login-loading');
      if (loading) loading.style.display = 'none';
    });
    await sleep(500);
    await loginPage.screenshot({ path: path.join(SCREENSHOTS_DIR, '08-login-page.png') });
    console.log('✅ Saved: 08-login-page.png');
    await loginContext.close();

    console.log('\n🎉 All screenshots captured!');
  } catch (err) {
    console.error('❌ Error:', err.message);
    await screenshot(page, 'error-screenshot');
  } finally {
    await browser.close();
  }
}

main();
