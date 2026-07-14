/**
 * 数据库连接模块
 * 支持 PostgreSQL（Supabase / Render 自托管）
 * 连接字符串从 DATABASE_URL 环境变量读取
 */

const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;

  const dbUrl = process.env.DATABASE_URL || '';
  if (!dbUrl) {
    console.warn('[DB] DATABASE_URL 未设置，数据库功能不可用');
    return null;
  }

  pool = new Pool({
    connectionString: dbUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  pool.on('error', (err) => {
    console.error('[DB] 连接池错误:', err.message);
  });

  pool.on('connect', () => {
    console.log('[DB] 数据库连接已建立');
  });

  return pool;
}

/**
 * 执行查询
 * @param {string} text SQL 语句
 * @param {Array} params 参数
 */
async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error('数据库未配置');
  const start = Date.now();
  try {
    const result = await p.query(text, params);
    const duration = Date.now() - start;
    if (duration > 500) {
      console.log(`[DB] 慢查询 (${duration}ms):`, text.substring(0, 80));
    }
    return result;
  } catch (err) {
    console.error('[DB] 查询错误:', err.message, '| SQL:', text.substring(0, 80));
    throw err;
  }
}

/**
 * 初始化数据库表
 */
async function initDatabase() {
  const p = getPool();
  if (!p) {
    console.log('[DB] 跳过数据库初始化 (未配置)');
    return false;
  }

  try {
    await query(`
      CREATE TABLE IF NOT EXISTS roles (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        description TEXT DEFAULT '',
        permissions TEXT DEFAULT '[]',
        system BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(64) PRIMARY KEY,
        username VARCHAR(128) NOT NULL UNIQUE,
        name VARCHAR(128) NOT NULL,
        password VARCHAR(255) DEFAULT '',
        role_id VARCHAR(64) REFERENCES roles(id),
        status VARCHAR(32) DEFAULT 'active',
        feishu_open_id VARCHAR(128) DEFAULT '',
        feishu_user_id VARCHAR(128) DEFAULT '',
        feishu_union_id VARCHAR(128) DEFAULT '',
        feishu_name VARCHAR(128) DEFAULT '',
        feishu_email VARCHAR(255) DEFAULT '',
        feishu_avatar TEXT DEFAULT '',
        feishu_tenant_key VARCHAR(128) DEFAULT '',
        feishu_raw_name VARCHAR(128) DEFAULT '',
        feishu_en_name VARCHAR(128) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(64) PRIMARY KEY,
        sku_code VARCHAR(128) NOT NULL UNIQUE,
        product_name VARCHAR(255) DEFAULT '',
        brand VARCHAR(128) DEFAULT '',
        model VARCHAR(128) DEFAULT '',
        category VARCHAR(128) DEFAULT '',
        country VARCHAR(128) DEFAULT '',
        ean_code VARCHAR(128) DEFAULT '',
        status VARCHAR(32) DEFAULT 'active',
        price DECIMAL(12,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // 兼容旧表：动态添加缺失的列
    const requiredProductCols = [
      { name: 'category', type: 'VARCHAR(128) DEFAULT \'\'' },
      { name: 'country', type: 'VARCHAR(128) DEFAULT \'\'' },
      { name: 'ean_code', type: 'VARCHAR(128) DEFAULT \'\'' },
      { name: 'status', type: 'VARCHAR(32) DEFAULT \'active\'' },
      { name: 'updated_at', type: 'TIMESTAMP DEFAULT NOW()' }
    ];
    for (const col of requiredProductCols) {
      try {
        await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
      } catch (err) {
        console.warn(`[DB] 添加列 ${col.name} 失败或已存在:`, err.message);
      }
    }

    await query(`
      CREATE TABLE IF NOT EXISTS aftersales_records (
        id VARCHAR(64) PRIMARY KEY,
        submitter_id VARCHAR(64) REFERENCES users(id),
        submitter_name VARCHAR(128) DEFAULT '',
        aftersales_date DATE,
        status VARCHAR(32) DEFAULT 'draft',
        brand TEXT DEFAULT '',
        model VARCHAR(128) DEFAULT '',
        category VARCHAR(64) DEFAULT '',
        platforms TEXT DEFAULT '',
        items JSONB DEFAULT '[]',
        total_quantity INTEGER DEFAULT 0,
        current_approval_level INTEGER DEFAULT 0,
        approver_level1_id VARCHAR(64) DEFAULT '',
        approver_level1_name VARCHAR(128) DEFAULT '',
        approver_level2_id VARCHAR(64) DEFAULT '',
        approver_level2_name VARCHAR(128) DEFAULT '',
        approver_level3_id VARCHAR(64) DEFAULT '',
        approver_level3_name VARCHAR(128) DEFAULT '',
        approval_flow_id VARCHAR(64) DEFAULT '',
        approval_flow_name VARCHAR(255) DEFAULT '',
        approval_level1_status VARCHAR(32) DEFAULT 'pending',
        approval_level2_status VARCHAR(32) DEFAULT 'pending',
        approval_history JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS sales_data (
        id VARCHAR(64) PRIMARY KEY,
        date DATE,
        product_name VARCHAR(255) DEFAULT '',
        sku_code VARCHAR(128) DEFAULT '',
        quantity INTEGER DEFAULT 0,
        amount DECIMAL(12,2) DEFAULT 0,
        platform VARCHAR(128) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS approval_flows (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        scope VARCHAR(255) DEFAULT '全部售后记录',
        enabled BOOLEAN DEFAULT true,
        nodes JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS dictionaries (
        id VARCHAR(64) PRIMARY KEY,
        category VARCHAR(64) NOT NULL,
        code VARCHAR(128) NOT NULL,
        label_zh VARCHAR(255) DEFAULT '',
        label_en VARCHAR(255) DEFAULT '',
        label_id VARCHAR(255) DEFAULT '',
        sort_order INTEGER DEFAULT 0,
        enabled BOOLEAN DEFAULT true,
        parent_code VARCHAR(128) DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(category, code)
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_dict_category ON dictionaries(category, sort_order)`);

    await query(`
      CREATE TABLE IF NOT EXISTS attachments (
        id VARCHAR(64) PRIMARY KEY,
        record_id VARCHAR(64) NOT NULL,
        item_index INTEGER,
        filename VARCHAR(255) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(128) DEFAULT '',
        size BIGINT DEFAULT 0,
        path VARCHAR(512) NOT NULL,
        uploaded_by VARCHAR(64) DEFAULT '',
        uploaded_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_attach_record ON attachments(record_id, item_index)`);

    // 客户表（妙搭 Webhook 同步）
    await query(`
      CREATE TABLE IF NOT EXISTS customers (
        id VARCHAR(64) PRIMARY KEY,
        external_customer_id VARCHAR(128) NOT NULL UNIQUE,
        customer_name VARCHAR(255) NOT NULL DEFAULT '',
        contact_person VARCHAR(255) DEFAULT '',
        phone VARCHAR(64) DEFAULT '',
        email VARCHAR(255) DEFAULT '',
        country VARCHAR(128) DEFAULT '',
        address TEXT DEFAULT '',
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        source VARCHAR(64) DEFAULT '',
        last_synced_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_customers_ext_id ON customers(external_customer_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_customers_source ON customers(source)`);
    console.log('[DB] customers 表已创建');

    // 迁移：为已有的表添加缺失列
    const userMigrationColumns = [
      { name: 'feishu_user_id', type: 'VARCHAR(128) DEFAULT \'\'' },
      { name: 'feishu_raw_name', type: 'VARCHAR(128) DEFAULT \'\'' },
      { name: 'feishu_en_name', type: 'VARCHAR(128) DEFAULT \'\'' }
    ];
    for (const col of userMigrationColumns) {
      await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`).catch(() => {});
    }

    const migrationColumns = [
      { name: 'model', type: 'VARCHAR(128) DEFAULT \'\'' },
      { name: 'category', type: 'VARCHAR(64) DEFAULT \'\'' },
      { name: 'total_quantity', type: 'INTEGER DEFAULT 0' },
      { name: 'current_approval_level', type: 'INTEGER DEFAULT 0' },
      { name: 'approver_level3_id', type: 'VARCHAR(64) DEFAULT \'\'' },
      { name: 'approver_level3_name', type: 'VARCHAR(128) DEFAULT \'\'' },
      { name: 'approval_history', type: 'JSONB DEFAULT \'[]\'' },
      { name: 'sn_code', type: 'VARCHAR(255) DEFAULT \'\'' },
      { name: 'approval_flow_id', type: 'VARCHAR(64) DEFAULT \'\'' },
      { name: 'approval_flow_name', type: 'VARCHAR(255) DEFAULT \'\'' },
      { name: 'tracking_number', type: 'VARCHAR(128) DEFAULT \'\'' },
    ];
    for (const col of migrationColumns) {
      await query(`ALTER TABLE aftersales_records ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`).catch(() => {});
    }

    // 迁移：为 dictionaries 表添加 parent_code 列（用于 shop_customer 与 platform 联动）
    await query(`ALTER TABLE dictionaries ADD COLUMN IF NOT EXISTS parent_code VARCHAR(128) DEFAULT ''`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_dict_parent ON dictionaries(parent_code) WHERE parent_code <> ''`).catch(() => {});

    // 创建索引
    await query(`CREATE INDEX IF NOT EXISTS idx_users_feishu_open_id ON users(feishu_open_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_users_feishu_user_id ON users(feishu_user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_users_feishu_union_id ON users(feishu_union_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_records_submitter ON aftersales_records(submitter_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_records_status ON aftersales_records(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_records_approver1 ON aftersales_records(approver_level1_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_records_approver2 ON aftersales_records(approver_level2_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_records_flow ON aftersales_records(approval_flow_id)`);

    console.log('[DB] 数据库表初始化完成');

    // 插入默认角色（如果不存在）
    const { rows: roleRows } = await query('SELECT COUNT(*) as cnt FROM roles');
    if (parseInt(roleRows[0].cnt) === 0) {
      // 超级管理员：全部权限
      const allPerms = JSON.stringify([
        'record_view', 'record_create', 'record_edit', 'record_delete', 'record_import', 'record_export',
        'product_view', 'product_create', 'product_edit', 'product_delete', 'product_import', 'product_export',
        'approval_level1', 'approval_level2', 'approval_level3',
        'user_manage', 'role_manage', 'system_config'
      ]);
      // 运营人员：业务操作 + 审批 + 导入导出，无系统管理
      const operatorPerms = JSON.stringify([
        'record_view', 'record_create', 'record_edit', 'record_import', 'record_export',
        'product_view', 'product_import', 'product_export',
        'approval_level1', 'approval_level2', 'approval_level3'
      ]);
      // 普通用户：只看不操作
      const viewerPerms = JSON.stringify([
        'record_view', 'record_create', 'product_view'
      ]);
      await query(
        `INSERT INTO roles (id, name, description, permissions, system) VALUES 
         ($1, $2, $3, $4, true),
         ($5, $6, $7, $8, true),
         ($9, $10, $11, $12, true)
         ON CONFLICT (id) DO NOTHING`,
        [
          'role_admin', '超级管理员', '拥有系统全部管理权限', allPerms,
          'role_operator', '运营人员', '业务操作权限，含审批与导入导出',
            operatorPerms,
          'role_viewer', '普通用户', '查看与新建权限',
            viewerPerms
        ]
      );

      // 插入默认管理员用户
      await query(
        `INSERT INTO users (id, username, name, password, role_id, status) 
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        ['user_admin', 'admin', '超级管理员', 'admin', 'role_admin', 'active']
      );

      console.log('[DB] 已插入默认角色和管理员账号');
    }

    // 插入默认标准售后审批流（如果不存在）
    const { rows: flowRows } = await query('SELECT COUNT(*) as cnt FROM approval_flows');
    if (parseInt(flowRows[0].cnt) === 0) {
      const defaultNodes = JSON.stringify([
        { level: 1, title: '一级审批', permission: 'approval_level1' },
        { level: 2, title: '二级审批', permission: 'approval_level2' },
        { level: 3, title: '三级审批', permission: 'approval_level3' }
      ]);
      await query(
        `INSERT INTO approval_flows (id, name, scope, enabled, nodes) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        ['flow_standard', '标准售后审批流', '全部售后记录', true, defaultNodes]
      );
      console.log('[DB] 已插入默认标准售后审批流');
    }

    // 插入默认字典数据（如果不存在）
    const { rows: dictCount } = await query('SELECT COUNT(*) as cnt FROM dictionaries');
    if (parseInt(dictCount[0].cnt) === 0) {
      const defaultDicts = [
        { category: 'return_reason', code: 'resellable', zh: '可二次销售', en: 'Resellable', id: 'Dapat Dijual Ulang', sort: 1 },
        { category: 'return_reason', code: 'box_damage', zh: '彩盒损坏', en: 'Box Damaged', id: 'Kemasan Rusak', sort: 2 },
        { category: 'return_reason', code: 'accessory_missing', zh: '配件缺失', en: 'Accessory Missing', id: 'Aksesori Hilang', sort: 3 },
        { category: 'return_reason', code: 'hardware_fault', zh: '硬件故障', en: 'Hardware Fault', id: 'Kerusakan Hardware', sort: 4 },
        { category: 'return_reason', code: 'scrapped', zh: '报废', en: 'Scrapped', id: 'Dibuang', sort: 5 },
        { category: 'return_reason', code: 'human_damage', zh: '人为损坏', en: 'Human Damage', id: 'Kerusakan oleh Manusia', sort: 6 },
        { category: 'return_reason', code: 'other', zh: '其他', en: 'Other', id: 'Lainnya', sort: 99 },
        { category: 'platform', code: 'shopee', zh: 'Shopee', en: 'Shopee', id: 'Shopee', sort: 1 },
        { category: 'platform', code: 'lazada', zh: 'Lazada', en: 'Lazada', id: 'Lazada', sort: 2 },
        { category: 'platform', code: 'tiktok', zh: 'TikTok', en: 'TikTok', id: 'TikTok', sort: 3 },
        { category: 'platform', code: 'tokopedia', zh: 'Tokopedia', en: 'Tokopedia', id: 'Tokopedia', sort: 4 },
        { category: 'platform', code: 'offline', zh: '线下门店', en: 'Offline Store', id: 'Toko Offline', sort: 5 },
        { category: 'platform', code: 'other', zh: '其他', en: 'Other', id: 'Lainnya', sort: 99 },
        { category: 'return_method', code: 'pickup', zh: '上门取件', en: 'Pickup', id: 'Penjemputan', sort: 1 },
        { category: 'return_method', code: 'customer_send', zh: '客户送修', en: 'Customer Drop-off', id: 'Kirim Pelanggan', sort: 2 },
        { category: 'return_method', code: 'express_cod', zh: '快递到付', en: 'Express (Freight Collect)', id: 'Ekspres (Bayar Tujuan)', sort: 3 },
      ];
      for (const d of defaultDicts) {
        await query(
          `INSERT INTO dictionaries (id, category, code, label_zh, label_en, label_id, sort_order, enabled, parent_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8) ON CONFLICT (category, code) DO NOTHING`,
          ['dict_' + d.category + '_' + d.code, d.category, d.code, d.zh, d.en, d.id, d.sort, '']
        );
      }
      console.log('[DB] 已插入默认字典数据');
    }

    // 修复退货原因字典的三语标签（用户可能在某语言下编辑导致 label_zh 等被覆盖为非对应语言文本）
    // 使用 UPSERT 保证幂等：已存在的行会修正标签，不存在的行会被创建
    const returnReasonCanonical = [
      { code: 'resellable',           zh: '可二次销售',                    en: 'Resellable',                  id: 'Dapat Dijual Ulang',       sort: 1 },
      { code: 'box_damage',           zh: '彩盒损坏',                     en: 'Damaged Packaging',          id: 'Kemasan Rusak',             sort: 2 },
      { code: 'accessory_missing',    zh: '配件缺失',                     en: 'Missing Accessories',        id: 'Aksesori Hilang',            sort: 3 },
      { code: 'hardware_fault',       zh: '硬件故障',                     en: 'Hardware Defect',            id: 'Kerusakan Hardware',         sort: 4 },
      { code: 'scrapped',             zh: '报废',                        en: 'Scrapped',                   id: 'Dibuang',                    sort: 5 },
      { code: 'human_damage',         zh: '人为损坏',                     en: 'Customer-Induced Damage',    id: 'Kerusakan oleh Manusia',     sort: 6 },
      { code: 'functional_issue',     zh: '功能异常',                     en: 'Functional Issue',           id: 'Masalah Fungsional',         sort: 7 },
      { code: 'other',                zh: '其他',                         en: 'Other',                      id: 'Lainnya',                    sort: 99 },
    ];
    for (const d of returnReasonCanonical) {
      await query(
        `INSERT INTO dictionaries (id, category, code, label_zh, label_en, label_id, sort_order, enabled, parent_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
         ON CONFLICT (category, code) DO UPDATE SET
           label_zh = EXCLUDED.label_zh,
           label_en = EXCLUDED.label_en,
           label_id = EXCLUDED.label_id,
           sort_order = EXCLUDED.sort_order`,
        ['dict_return_reason_' + d.code, 'return_reason', d.code, d.zh, d.en, d.id, d.sort, '']
      );
    }
    console.log('[DB] 已修复退货原因字典三语标签');

    // 始终尝试插入默认 shop_customer 数据（ON CONFLICT DO NOTHING 保证幂等）
    const defaultShopCustomer = [
      { code: 'shopee_store_01', zh: 'Shopee 官方店', en: 'Shopee Official Store', id: 'Shopee Official Store', sort: 1, parent_code: 'shopee' },
      { code: 'shopee_store_02', zh: 'Shopee 旗舰店', en: 'Shopee Flagship Store', id: 'Shopee Flagship Store', sort: 2, parent_code: 'shopee' },
      { code: 'tiktok_store_01', zh: 'TikTok 官方店', en: 'TikTok Official Store', id: 'TikTok Official Store', sort: 1, parent_code: 'tiktok' },
      { code: 'lazada_store_01', zh: 'Lazada 官方店', en: 'Lazada Official Store', id: 'Lazada Official Store', sort: 1, parent_code: 'lazada' },
      { code: 'tokopedia_store_01', zh: 'Tokopedia 官方店', en: 'Tokopedia Official Store', id: 'Tokopedia Official Store', sort: 1, parent_code: 'tokopedia' },
      { code: 'offline_dealer_01', zh: '经销商A', en: 'Dealer A', id: 'Dealer A', sort: 1, parent_code: 'offline' },
      { code: 'offline_dealer_02', zh: '客户自送', en: 'Customer Walk-in', id: 'Customer Walk-in', sort: 2, parent_code: 'offline' },
    ];
    for (const d of defaultShopCustomer) {
      await query(
        `INSERT INTO dictionaries (id, category, code, label_zh, label_en, label_id, sort_order, enabled, parent_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8) ON CONFLICT (category, code) DO NOTHING`,
        ['dict_shop_customer_' + d.code, 'shop_customer', d.code, d.zh, d.en, d.id, d.sort, d.parent_code]
      );
    }
    console.log('[DB] 已确保 shop_customer 默认数据存在');

    return true;
  } catch (err) {
    console.error('[DB] 数据库初始化失败:', err.message);
    return false;
  }
}

module.exports = { query, getPool, initDatabase };
