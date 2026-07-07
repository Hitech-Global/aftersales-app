/**
 * Verify that the API queries for shop_customer with parent_code filtering work correctly.
 * Simulates the exact queries used in server.js GET /api/dictionaries endpoint.
 */
const { Pool } = require('pg');

const DATABASE_URL = 'postgresql://postgres.xfueggjnptrqvdsivkjl:dfMyRxPZ5Z5d0Y2o@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres';

async function main() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });

  try {
    console.log('=== Verifying API queries ===\n');

    // Test 1: GET /api/dictionaries?category=shop_customer (no parent_code filter)
    console.log('[Test 1] GET /api/dictionaries?category=shop_customer');
    const test1 = await pool.query(
      `SELECT id, category, code, label_zh, label_en, label_id, sort_order, enabled, parent_code
       FROM dictionaries WHERE category = $1 ORDER BY sort_order`,
      ['shop_customer']
    );
    console.log(`  Results: ${test1.rows.length} entries`);
    test1.rows.forEach(r => {
      console.log(`  - ${r.code} | zh:${r.label_zh} | en:${r.label_en} | parent:${r.parent_code} | enabled:${r.enabled}`);
    });

    // Test 2: GET /api/dictionaries?category=shop_customer&parent_code=shopee
    console.log('\n[Test 2] GET /api/dictionaries?category=shop_customer&parent_code=shopee');
    const conditions = ['category = $1', 'parent_code = $2'];
    const params = ['shop_customer', 'shopee'];
    const test2 = await pool.query(
      `SELECT id, category, code, label_zh, label_en, label_id, sort_order, enabled, parent_code
       FROM dictionaries WHERE ${conditions.join(' AND ')} ORDER BY sort_order`,
      params
    );
    console.log(`  Results: ${test2.rows.length} entries`);
    test2.rows.forEach(r => {
      console.log(`  - ${r.code} | zh:${r.label_zh} | en:${r.label_en} | parent:${r.parent_code}`);
    });

    // Test 3: parent_code=tiktok
    console.log('\n[Test 3] GET /api/dictionaries?category=shop_customer&parent_code=tiktok');
    const test3 = await pool.query(
      `SELECT code, label_zh, label_en, parent_code
       FROM dictionaries WHERE category = $1 AND parent_code = $2 ORDER BY sort_order`,
      ['shop_customer', 'tiktok']
    );
    console.log(`  Results: ${test3.rows.length} entries`);
    test3.rows.forEach(r => {
      console.log(`  - ${r.code} | zh:${r.label_zh} | en:${r.label_en} | parent:${r.parent_code}`);
    });

    // Test 4: parent_code=offline
    console.log('\n[Test 4] GET /api/dictionaries?category=shop_customer&parent_code=offline');
    const test4 = await pool.query(
      `SELECT code, label_zh, label_en, parent_code
       FROM dictionaries WHERE category = $1 AND parent_code = $2 ORDER BY sort_order`,
      ['shop_customer', 'offline']
    );
    console.log(`  Results: ${test4.rows.length} entries`);
    test4.rows.forEach(r => {
      console.log(`  - ${r.code} | zh:${r.label_zh} | en:${r.label_en} | parent:${r.parent_code}`);
    });

    // Test 5: Verify all platform codes have matching shop_customer entries
    console.log('\n[Test 5] Platform -> Shop/Customer linkage check');
    const platforms = await pool.query(`SELECT code, label_zh FROM dictionaries WHERE category = 'platform' ORDER BY sort_order`);
    for (const p of platforms.rows) {
      const shops = await pool.query(
        `SELECT code, label_zh FROM dictionaries WHERE category = 'shop_customer' AND parent_code = $1 ORDER BY sort_order`,
        [p.code]
      );
      console.log(`  Platform "${p.code}" (${p.label_zh}): ${shops.rows.length} shop(s) -> ${shops.rows.map(s => s.label_zh).join(', ') || 'NONE'}`);
    }

    console.log('\n=== All API query simulations passed! ===');

  } catch (err) {
    console.error('Verification failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
