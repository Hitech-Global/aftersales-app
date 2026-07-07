/**
 * Direct Supabase migration script for v3.9.0
 * Adds parent_code column to dictionaries table and inserts default shop_customer data.
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
    console.log('=== Connecting to Supabase ===');

    // Step 1: Check current table structure
    console.log('\n[1] Checking dictionaries table columns...');
    const cols = await pool.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'dictionaries'
      ORDER BY ordinal_position
    `);
    console.log('Current columns:', cols.rows.map(r => r.column_name).join(', '));

    const hasParentCode = cols.rows.some(r => r.column_name === 'parent_code');
    console.log('parent_code exists:', hasParentCode);

    // Step 2: Add parent_code column if not exists
    if (!hasParentCode) {
      console.log('\n[2] Adding parent_code column...');
      await pool.query(`ALTER TABLE dictionaries ADD COLUMN IF NOT EXISTS parent_code VARCHAR(128) DEFAULT ''`);
      console.log('parent_code column added.');
    } else {
      console.log('\n[2] parent_code column already exists, skipping.');
    }

    // Step 3: Create index
    console.log('\n[3] Creating index idx_dict_parent...');
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_dict_parent ON dictionaries(parent_code) WHERE parent_code <> ''`);
    console.log('Index created.');

    // Step 4: Check existing shop_customer data
    console.log('\n[4] Checking existing shop_customer data...');
    const existing = await pool.query(`SELECT count(*)::int as cnt FROM dictionaries WHERE category = 'shop_customer'`);
    console.log('Existing shop_customer count:', existing.rows[0].cnt);

    // Step 5: Insert default shop_customer data (ON CONFLICT DO NOTHING)
    console.log('\n[5] Inserting default shop_customer data...');
    const defaultShopCustomer = [
      { code: 'shopee_store_01', zh: 'Shopee 官方店', en: 'Shopee Official Store', id: 'Shopee Official Store', sort: 1, parent_code: 'shopee' },
      { code: 'shopee_store_02', zh: 'Shopee 旗舰店', en: 'Shopee Flagship Store', id: 'Shopee Flagship Store', sort: 2, parent_code: 'shopee' },
      { code: 'tiktok_store_01', zh: 'TikTok 官方店', en: 'TikTok Official Store', id: 'TikTok Official Store', sort: 1, parent_code: 'tiktok' },
      { code: 'lazada_store_01', zh: 'Lazada 官方店', en: 'Lazada Official Store', id: 'Lazada Official Store', sort: 1, parent_code: 'lazada' },
      { code: 'tokopedia_store_01', zh: 'Tokopedia 官方店', en: 'Tokopedia Official Store', id: 'Tokopedia Official Store', sort: 1, parent_code: 'tokopedia' },
      { code: 'offline_dealer_01', zh: '经销商A', en: 'Dealer A', id: 'Dealer A', sort: 1, parent_code: 'offline' },
      { code: 'offline_dealer_02', zh: '客户自送', en: 'Customer Walk-in', id: 'Customer Walk-in', sort: 2, parent_code: 'offline' },
    ];

    let inserted = 0;
    for (const d of defaultShopCustomer) {
      const res = await pool.query(
        `INSERT INTO dictionaries (id, category, code, label_zh, label_en, label_id, sort_order, enabled, parent_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
         ON CONFLICT (category, code) DO NOTHING`,
        ['dict_shop_customer_' + d.code, 'shop_customer', d.code, d.zh, d.en, d.id, d.sort, d.parent_code]
      );
      if (res.rowCount > 0) inserted++;
    }
    console.log(`Inserted ${inserted} new shop_customer records.`);

    // Step 6: Verify final state
    console.log('\n[6] Verifying final state...');
    const finalCols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'dictionaries' ORDER BY ordinal_position
    `);
    console.log('Final columns:', finalCols.rows.map(r => r.column_name).join(', '));

    const shopData = await pool.query(`
      SELECT code, label_zh, label_en, parent_code, sort_order, enabled
      FROM dictionaries WHERE category = 'shop_customer' ORDER BY sort_order
    `);
    console.log('\nShop/Customer dictionary entries:');
    shopData.rows.forEach(r => {
      console.log(`  - ${r.code} | zh: ${r.label_zh} | en: ${r.label_en} | parent: ${r.parent_code} | sort: ${r.sort_order} | enabled: ${r.enabled}`);
    });

    // Also verify platforms
    const platforms = await pool.query(`
      SELECT code, label_zh FROM dictionaries WHERE category = 'platform' ORDER BY sort_order
    `);
    console.log('\nPlatform entries (for parent_code linkage):');
    platforms.rows.forEach(r => {
      console.log(`  - ${r.code} | ${r.label_zh}`);
    });

    console.log('\n=== Migration completed successfully! ===');

  } catch (err) {
    console.error('Migration failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
