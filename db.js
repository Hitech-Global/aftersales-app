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
    ];
    for (const col of migrationColumns) {
      await query(`ALTER TABLE aftersales_records ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`).catch(() => {});
    }

    // 创建索引
    await query(`CREATE INDEX IF NOT EXISTS idx_users_feishu_open_id ON users(feishu_open_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_users_feishu_user_id ON users(feishu_user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_users_feishu_union_id ON users(feishu_union_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_records_submitter ON aftersales_records(submitter_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_records_status ON aftersales_records(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_records_approver1 ON aftersales_records(approver_level1_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_records_approver2 ON aftersales_records(approver_level2_id)`);

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

    return true;
  } catch (err) {
    console.error('[DB] 数据库初始化失败:', err.message);
    return false;
  }
}

module.exports = { query, getPool, initDatabase };
