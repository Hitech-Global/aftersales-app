'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const db = fs.readFileSync(path.join(root, 'db.js'), 'utf8');

function extractFunction(source, name) {
  const tokens = ['async function ' + name + '(', 'function ' + name + '('];
  let start = -1;
  for (const token of tokens) {
    const i = source.indexOf(token);
    if (i >= 0 && (start < 0 || i < start)) start = i;
  }
  assert.ok(start >= 0, 'function not found: ' + name);
  const brace = source.indexOf('{', start);
  assert.ok(brace >= 0, 'opening brace not found: ' + name);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unterminated function: ' + name);
}

// 1) Browser critical path: large third-party libraries must not be parser-blocking.
assert.equal(index.includes('<script src="https://cdn.sheetjs.com'), false, 'SheetJS must not block HTML parsing');
assert.equal(index.includes('<script src="https://cdn.jsdelivr.net/npm/chart.js'), false, 'Chart.js must not block HTML parsing');
assert.match(index, /function ensureXlsx\(\)/, 'SheetJS lazy loader missing');
assert.match(index, /function ensureChartJs\(\)/, 'Chart.js lazy loader missing');

// 2) PSI-style cache architecture: independent resources, in-flight de-dupe, VIEW HIT and SWR.
for (const marker of [
  'const _resourceMeta = Object.create(null)',
  'function runResourceFetch(',
  'function refreshResourceInBackground(',
  'const _pageRenderSignature=Object.create(null)',
  'function pageNeedsRender(',
  'function refreshPageOnViewHit(',
  'function prewarmAppData(',
  'async function preRenderAccessiblePages('
]) {
  assert.ok(index.includes(marker), 'missing performance marker: ' + marker);
}
assert.equal(/\blet _cacheTimestamp\b/.test(index), false, 'global cache timestamp must stay removed');
assert.equal(/\b_cacheTimestamp\s*=/.test(index), false, 'legacy global cache timestamp assignment found');

// 3) Customer views use bounded LRU.
assert.match(index, /const CUSTOMER_PAGE_MAX = 6;/, 'customer LRU must remain bounded at 6');
assert.match(index, /const _customerPageInflight = new Map\(\);/, 'customer in-flight de-dupe missing');

// 4) Page renderers must consume cached adapters, not issue their own normal page GETs.
// Detail keeps one intentional /api/records/cc fallback for CC-only users.
for (const name of [
  'renderList',
  'renderProducts',
  'renderApproval',
  'renderProcessingApprovals',
  'renderUsers',
  'renderRoles',
  'renderApprovalFlows',
  'renderDictionaries',
  'renderCustomers',
  'loadCustomers'
]) {
  const body = extractFunction(index, name);
  assert.equal(/fetch\(\s*['"`]\/api\//.test(body), false, name + ' has a direct API fetch; page cache boundary regressed');
}
const detailBody = extractFunction(index, 'renderDetail');
const detailFetches = detailBody.match(/fetch\(\s*['"`]\/api\//g) || [];
assert.ok(detailFetches.length <= 1, 'renderDetail may only keep the CC authorization fallback fetch');
assert.ok(detailBody.includes("fetch('/api/records/cc'"), 'expected CC-only detail fallback missing');

// 5) Async races: list/detail/approval/admin views have sequence cancellation.
for (const marker of [
  'let _renderListSeq=0',
  'let _renderDetailSeq=0',
  'let _renderApprovalSeq=0',
  'let _renderProductsSeq=0',
  'let _renderUsersSeq=0',
  'let _renderRolesSeq=0',
  'var _renderApprovalFlowsSeq = 0',
  'var _renderDictionariesSeq = 0',
  'let _loadCustomersSeq=0'
]) {
  assert.ok(index.includes(marker), 'stale-render guard missing: ' + marker);
}

// 6) Backend: no synchronous wait primitives, and /api/records old-row expansion is set based.
for (const source of [server, db]) {
  for (const forbidden of ['Atomics.wait', 'execSync(', 'readFileSync(', 'writeFileSync(']) {
    assert.equal(source.includes(forbidden), false, 'main-thread blocking primitive found: ' + forbidden);
  }
}
assert.match(server, /async function expandApprovalFlowsForRecords\(/, 'set-based approval flow expansion missing');
const recordsRouteStart = server.indexOf("app.get('/api/records'");
const recordsRouteEnd = server.indexOf('// ==================== CC 抄送', recordsRouteStart);
assert.ok(recordsRouteStart >= 0 && recordsRouteEnd > recordsRouteStart, 'records route not found');
const recordsRoute = server.slice(recordsRouteStart, recordsRouteEnd);
assert.match(recordsRoute, /await expandApprovalFlowsForRecords\(result\.rows\)/, 'records route does not use set-based expansion');
assert.equal(recordsRoute.includes('await resolveFlowApprovers('), false, 'N+1 flow lookup returned to records route');

// 7) Startup must not serially wait for maintenance/default-data work.
const initMarker = index.indexOf('// ==================== INITIALIZATION ====================');
assert.ok(initMarker >= 0, 'initialization block missing');
const initTail = index.slice(initMarker, initMarker + 7000);
assert.ok(initTail.includes('Promise.all([versionPromise,sessionPromise])'), 'version/session startup should be parallel');
const beforeEnter = initTail.split('if(serverUser)')[0];
assert.equal(beforeEnter.includes('await runMigration()'), false, 'migration returned to startup critical path');
assert.equal(beforeEnter.includes('await initDefaultData()'), false, 'default-data init returned to startup critical path');

console.log('instant-pages performance regression tests passed');
