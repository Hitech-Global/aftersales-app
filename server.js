/**
 * 售后数据管理系统 - 飞书集成后端服务
 * 
 * 功能：
 * 1. 飞书 OAuth2.0 登录（网页/工作台免登）
 * 2. 飞书组织成员校验
 * 3. 飞书自建应用机器人消息推送（审批通知卡片）
 * 4. 支持 Mock 模式（未配置飞书凭证时，使用本地模拟）
 */

const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const { query, initDatabase } = require('./db');

// ==================== 加载环境变量 ====================
let envLoaded = false;
try {
  require('dotenv').config();
  envLoaded = true;
} catch (e) {
  console.log('[Config] dotenv 未安装，将使用系统环境变量');
}

// ==================== 配置 ====================
const PORT = process.env.PORT || 3000;
const APP_VERSION = '3.7.0-render-latest';
const FEISHU_ENABLED = process.env.FEISHU_ENABLED === 'true';
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_ORG_ID = process.env.FEISHU_ORG_ID || ''; // 企业组织 ID，用于校验用户是否属于本组织
const APP_BASE_URL = process.env.BASE_URL || process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const NODE_ENV = process.env.NODE_ENV || 'development';
const FEISHU_APP_NAME = process.env.FEISHU_APP_NAME || '售后数据管理系统';
const OAUTH_STATE_COOKIE = 'feishu_oauth_state';
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const oauthStates = new Map();
const feishuLoginEvents = [];

// 验证飞书配置
const feishuConfigured = !!(FEISHU_ENABLED && FEISHU_APP_ID && FEISHU_APP_SECRET);

function parseCookies(cookieHeader) {
  return String(cookieHeader || '').split(';').reduce((cookies, part) => {
    const index = part.indexOf('=');
    if (index === -1) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function feishuCookieOptions(maxAge) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: APP_BASE_URL.startsWith('https://'),
    maxAge
  };
}

function rememberOAuthState(state) {
  const now = Date.now();
  for (const [key, expiresAt] of oauthStates.entries()) {
    if (expiresAt <= now) oauthStates.delete(key);
  }
  oauthStates.set(state, now + OAUTH_STATE_MAX_AGE_MS);
}

function consumeOAuthState(state, cookieState) {
  if (!state) return false;
  const expiresAt = oauthStates.get(state);
  if (expiresAt) {
    oauthStates.delete(state);
    return Date.now() <= expiresAt;
  }
  return Boolean(cookieState && state === cookieState);
}

function recordFeishuEvent(step, detail = {}) {
  const event = {
    time: new Date().toISOString(),
    step,
    detail
  };
  feishuLoginEvents.unshift(event);
  feishuLoginEvents.splice(20);
  console.log('[FeishuLogin]', step, detail);
}

function getFeishuDisplayName(userInfo) {
  return (
    userInfo.en_name ||
    userInfo.name ||
    userInfo.nickname ||
    userInfo.email?.split('@')[0] ||
    '飞书用户'
  );
}

function getFeishuAvatar(userInfo) {
  return (
    userInfo.avatar_url ||
    userInfo.avatar_thumb ||
    userInfo.avatar_middle ||
    userInfo.avatar_big ||
    userInfo.avatar?.avatar_240 ||
    userInfo.avatar?.avatar_72 ||
    userInfo.avatar?.avatar_origin ||
    ''
  );
}

function maskSecret(value) {
  if (!value) return '(empty)';
  if (value.length <= 8) return value.slice(0, 2) + '***';
  return value.slice(0, 6) + '***' + value.slice(-4);
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function formatCardDate(value) {
  if (!value) return '-';
  const raw = String(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return raw;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function approvalLevelName(level) {
  const names = { 1: '一级', 2: '二级', 3: '三级' };
  return names[Number(level)] || `第${level}级`;
}

function getFeishuPermissionHint(code, msg) {
  const text = String(msg || '').toLowerCase();
  if ([230001, 99991663, 99991672, 99991664].includes(Number(code)) || text.includes('permission')) {
    return '应用权限不足：请确认已开通机器人向用户发消息权限，并在飞书开放平台重新发布应用。';
  }
  if ([102210001, 102210002, 230020].includes(Number(code))) {
    return '接收人 ID 无效或用户不在当前应用可见范围，请检查审批人飞书绑定和应用通讯录权限。';
  }
  return msg || '飞书接口返回未知错误';
}

console.log('========================================');
console.log(`  售后数据管理系统 - 后端服务`);
console.log('========================================');
console.log(`  版本: ${APP_VERSION}`);
console.log(`  端口: ${PORT}`);
console.log(`  飞书集成: ${FEISHU_ENABLED ? '启用' : '未启用 (Mock 模式)'}`);
if (FEISHU_ENABLED && feishuConfigured) {
  console.log(`  飞书 App ID: ${maskSecret(FEISHU_APP_ID)}`);
  console.log(`  飞书 App Secret: ${FEISHU_APP_SECRET ? '已配置' : '未配置'}`);
  console.log(`  飞书组织 ID: ${FEISHU_ORG_ID || '(未设置)'}`);
  console.log(`  应用地址: ${APP_BASE_URL}`);
} else if (FEISHU_ENABLED) {
  console.log(`  ⚠ 飞书已启用但缺少凭证，请配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET`);
}
console.log('========================================\n');

// ==================== Express 初始化 ====================
const app = express();
app.use(express.json());

function sendNoCacheHtml(res, fileName) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, fileName));
}

// 前端路由：所有带 hash 的请求返回首页
app.get('/', (req, res) => {
  sendNoCacheHtml(res, 'index.html');
});

app.get('/index.html', (req, res) => {
  sendNoCacheHtml(res, 'index.html');
});

app.use(express.static(path.join(__dirname), {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
    }
  }
}));

app.get('/api/version', (req, res) => {
  res.json({
    version: APP_VERSION,
    app: 'aftersales-node-spa',
    entry: 'server.js',
    frontend: 'index.html',
    baseUrl: APP_BASE_URL,
    nodeEnv: NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

// ==================== API 认证与权限中间件 ====================
function apiAuth(req, res, next) {
  // 从 header 获取当前用户信息（前端在每次请求时传入）
  const userId = req.headers['x-user-id'];
  const userRole = req.headers['x-user-role'];
  const userPerms = req.headers['x-user-permissions'] || '';
  if (userId) {
    req.currentUserId = userId;
    req.currentUserRole = userRole || '';
    req.currentUserPermissions = userPerms ? userPerms.split(',').map(s => s.trim()).filter(Boolean) : [];
  }
  next();
}

// 权限校验中间件工厂函数
function requireApiPermission(...perms) {
  return (req, res, next) => {
    if (!req.currentUserId) {
      return res.status(401).json({ error: '未登录' });
    }
    const hasPerm = perms.some(p => (req.currentUserPermissions || []).includes(p));
    if (!hasPerm) {
      return res.status(403).json({ error: '没有该操作的权限' });
    }
    next();
  };
}

// 仅要求已登录（不校验具体权限）
function requireLogin(req, res, next) {
  if (!req.currentUserId) {
    return res.status(401).json({ error: '未登录' });
  }
  next();
}

app.use('/api/users', apiAuth);
app.use('/api/roles', apiAuth);
app.use('/api/records', apiAuth);
app.use('/api/products', apiAuth);
app.use('/api/sales', apiAuth);
app.use('/api/notify', apiAuth);
app.use('/api/approval-flows', apiAuth);
app.use('/api/dictionaries', apiAuth);
app.use('/api/attachments', apiAuth);

// ==================== 附件上传 ====================
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    cb(null, id + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp|bmp|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|zip|rar)$/i;
    if (allowed.test(file.originalname)) cb(null, true);
    else cb(new Error('不支持的文件类型'));
  }
});
app.use('/uploads', express.static(UPLOAD_DIR));

// ==================== 数据库 CRUD API ====================

// 初始化数据库
app.post('/api/db/init', async (req, res) => {
  try {
    const ok = await initDatabase();
    res.json({ success: ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 用户 API ----
// 用户列表允许所有已登录用户读取（用于审批人选择、提交人显示等），增删改仍需 user_manage
app.get('/api/users', requireLogin, async (req, res) => {
  try {
    const result = await query('SELECT * FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', requireApiPermission('user_manage'), async (req, res) => {
  try {
    const { id, username, name, password, role_id, status, feishu_open_id, feishu_user_id, feishu_union_id, feishu_name, feishu_email, feishu_avatar, feishu_tenant_key, feishu_raw_name, feishu_en_name } = req.body;
    if (!username || !name) return res.status(400).json({ error: '用户名和姓名不能为空' });
    
    // 检查用户名重复
    const exist = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (exist.rows.length > 0) return res.status(400).json({ error: '用户名已存在' });

    const result = await query(
      `INSERT INTO users (id, username, name, password, role_id, status, feishu_open_id, feishu_user_id, feishu_union_id, feishu_name, feishu_email, feishu_avatar, feishu_tenant_key, feishu_raw_name, feishu_en_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [id, username, name, password || '', role_id || 'role_viewer', status || 'active',
       feishu_open_id || '', feishu_user_id || '', feishu_union_id || '', feishu_name || '', feishu_email || '', feishu_avatar || '', feishu_tenant_key || '', feishu_raw_name || '', feishu_en_name || '']
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:id', requireApiPermission('user_manage'), async (req, res) => {
  try {
    const { id } = req.params;
    const { username, name, password, role_id, status, feishu_open_id, feishu_user_id, feishu_union_id, feishu_name, feishu_email, feishu_avatar, feishu_tenant_key, feishu_raw_name, feishu_en_name } = req.body;
    if (!username || !name) return res.status(400).json({ error: '用户名和姓名不能为空' });

    // 检查用户名重复（排除当前 ID 自己）
    const exist = await query('SELECT id FROM users WHERE username = $1 AND id <> $2', [username, id]);
    if (exist.rows.length > 0) return res.status(400).json({ error: '用户名已存在' });

    const result = await query(
      `INSERT INTO users (id, username, name, password, role_id, status, feishu_open_id, feishu_user_id, feishu_union_id, feishu_name, feishu_email, feishu_avatar, feishu_tenant_key, feishu_raw_name, feishu_en_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (id) DO UPDATE SET
         username = EXCLUDED.username,
         name = EXCLUDED.name,
         password = CASE WHEN EXCLUDED.password <> '' THEN EXCLUDED.password ELSE users.password END,
         role_id = EXCLUDED.role_id,
         status = EXCLUDED.status,
         feishu_open_id = EXCLUDED.feishu_open_id,
         feishu_user_id = EXCLUDED.feishu_user_id,
         feishu_union_id = EXCLUDED.feishu_union_id,
         feishu_name = EXCLUDED.feishu_name,
         feishu_email = EXCLUDED.feishu_email,
         feishu_avatar = EXCLUDED.feishu_avatar,
         feishu_tenant_key = EXCLUDED.feishu_tenant_key,
         feishu_raw_name = EXCLUDED.feishu_raw_name,
         feishu_en_name = EXCLUDED.feishu_en_name
       RETURNING *`,
      [id, username, name, password || '', role_id || 'role_viewer', status || 'active',
       feishu_open_id || '', feishu_user_id || '', feishu_union_id || '', feishu_name || '', feishu_email || '', feishu_avatar || '', feishu_tenant_key || '', feishu_raw_name || '', feishu_en_name || '']
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 删除用户
app.delete('/api/users/:id', requireApiPermission('user_manage'), async (req, res) => {
  try {
    if (req.params.id === 'user_admin') return res.status(400).json({ error: '不能删除超级管理员' });
    const result = await query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '用户不存在' });
    res.json({ success: true, id: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 根据飞书身份查找用户
app.get('/api/users/find-by-feishu/:openId', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM users WHERE feishu_open_id = $1 OR feishu_user_id = $1 OR (feishu_union_id = $1 AND $1 != \'\')',
      [req.params.openId]
    );
    res.json(result.rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 角色 API ----
app.get('/api/roles', async (req, res) => {
  try {
    const result = await query('SELECT * FROM roles ORDER BY created_at');
    const rows = result.rows.map(r => ({
      ...r,
      permissions: typeof r.permissions === 'string' ? JSON.parse(r.permissions || '[]') : r.permissions
    }));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/roles', requireApiPermission('role_manage'), async (req, res) => {
  try {
    const { id, name, description, permissions, system } = req.body;
    const result = await query(
      `INSERT INTO roles (id, name, description, permissions, system) VALUES ($1,$2,$3,$4,$5) 
       ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, permissions=$4 RETURNING *`,
      [id, name, description || '', JSON.stringify(permissions || []), system || false]
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 售后记录 API ----

// 根据 approval_flow_id 展开为 approver_level1/2/3 字段
async function resolveFlowApprovers(flowId) {
  if (!flowId) return null;
  try {
    const { rows } = await query('SELECT id, name, nodes FROM approval_flows WHERE id = $1', [flowId]);
    if (!rows.length) return { _deleted: true };
    const flow = rows[0];
    const nodes = typeof flow.nodes === 'string' ? JSON.parse(flow.nodes || '[]') : (flow.nodes || []);
    // 查所有相关用户拿到 name
    const ids = [...new Set(nodes.slice(0, 3).map(n => n.approver_id).filter(Boolean))];
    let nameMap = {};
    if (ids.length) {
      const ur = await query('SELECT id, name FROM users WHERE id = ANY($1::text[])', [ids]);
      ur.rows.forEach(u => { nameMap[u.id] = u.name; });
    }
    const out = {
      approval_flow_id: flow.id,
      approval_flow_name: flow.name,
      approver_level1_id: '', approver_level1_name: '',
      approver_level2_id: '', approver_level2_name: '',
      approver_level3_id: '', approver_level3_name: ''
    };
    for (let i = 0; i < 3; i++) {
      const n = nodes[i];
      if (n && n.approver_id) {
        out['approver_level' + (i + 1) + '_id'] = n.approver_id;
        out['approver_level' + (i + 1) + '_name'] = nameMap[n.approver_id] || '';
      }
    }
    return out;
  } catch (e) {
    console.error('[resolveFlowApprovers] error:', e.message);
    return null;
  }
}

app.get('/api/records', requireApiPermission('record_view'), async (req, res) => {
  try {
    const { status, submitter_id, page, pageSize } = req.query;
    let sql = 'SELECT * FROM aftersales_records';
    const conditions = [];
    const values = [];
    let idx = 1;

    if (status) { conditions.push(`status = $${idx++}`); values.push(status); }
    if (submitter_id) { conditions.push(`submitter_id = $${idx++}`); values.push(submitter_id); }

    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at DESC';

    if (page && pageSize) {
      const offset = (parseInt(page) - 1) * parseInt(pageSize);
      sql += ` LIMIT $${idx++} OFFSET $${idx++}`;
      values.push(parseInt(pageSize), offset);
    }

    const result = await query(sql, values);
    // 若行内有 approval_flow_id 且 level1/2/3 字段为空,按 flow 自动展开(老数据兼容)
    for (const r of result.rows) {
      if (r.approval_flow_id && !r.approver_level1_id) {
        const expanded = await resolveFlowApprovers(r.approval_flow_id);
        if (expanded && !expanded._deleted) {
          Object.assign(r, expanded);
        }
      }
    }
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/records', requireApiPermission('record_create'), async (req, res) => {
  try {
    const { id, submitter_id, submitter_name, aftersales_date, status, brand, model, category, platforms, items,
      total_quantity, current_approval_level,
      approval_flow_id,
      approver_level1_id, approver_level1_name, approver_level2_id, approver_level2_name,
      approver_level3_id, approver_level3_name, approval_history } = req.body;

    // 如果指定了 approval_flow_id,优先用 flow 展开 level1/2/3
    let flowLevel1Id = approver_level1_id, flowLevel1Name = approver_level1_name;
    let flowLevel2Id = approver_level2_id, flowLevel2Name = approver_level2_name;
    let flowLevel3Id = approver_level3_id, flowLevel3Name = approver_level3_name;
    let flowName = '';
    if (approval_flow_id) {
      const expanded = await resolveFlowApprovers(approval_flow_id);
      if (expanded && !expanded._deleted) {
        flowLevel1Id = expanded.approver_level1_id;
        flowLevel1Name = expanded.approver_level1_name;
        flowLevel2Id = expanded.approver_level2_id;
        flowLevel2Name = expanded.approver_level2_name;
        flowLevel3Id = expanded.approver_level3_id;
        flowLevel3Name = expanded.approver_level3_name;
        flowName = expanded.approval_flow_name;
      } else if (expanded && expanded._deleted) {
        return res.status(400).json({ error: '所选审批流已被删除' });
      }
    }

    const result = await query(
      `INSERT INTO aftersales_records (id, submitter_id, submitter_name, aftersales_date, status, brand, model, category, platforms, items,
        total_quantity, current_approval_level,
        approval_flow_id, approval_flow_name,
        approver_level1_id, approver_level1_name, approver_level2_id, approver_level2_name,
        approver_level3_id, approver_level3_name, approval_history)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [id, submitter_id, submitter_name, aftersales_date, status || 'draft', brand || '', model || '', category || '', platforms || '', JSON.stringify(items || []),
       total_quantity || 0, current_approval_level || 0,
       approval_flow_id || '', flowName,
       flowLevel1Id || '', flowLevel1Name || '', flowLevel2Id || '', flowLevel2Name || '',
       flowLevel3Id || '', flowLevel3Name || '', JSON.stringify(approval_history || [])]
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/records/:id', requireApiPermission('record_edit'), async (req, res) => {
  try {
    const { submitter_name, aftersales_date, status, brand, model, category, platforms, items,
      total_quantity, current_approval_level,
      approval_flow_id,
      approver_level1_id, approver_level1_name, approver_level2_id, approver_level2_name,
      approver_level3_id, approver_level3_name,
      approval_level1_status, approval_level2_status, approval_history } = req.body;

    // 若指定 approval_flow_id,优先用 flow 展开
    let flowLevel1Id = approver_level1_id, flowLevel1Name = approver_level1_name;
    let flowLevel2Id = approver_level2_id, flowLevel2Name = approver_level2_name;
    let flowLevel3Id = approver_level3_id, flowLevel3Name = approver_level3_name;
    let flowName;
    if (approval_flow_id !== undefined) {
      const expanded = await resolveFlowApprovers(approval_flow_id);
      if (expanded && !expanded._deleted) {
        flowLevel1Id = expanded.approver_level1_id;
        flowLevel1Name = expanded.approver_level1_name;
        flowLevel2Id = expanded.approver_level2_id;
        flowLevel2Name = expanded.approver_level2_name;
        flowLevel3Id = expanded.approver_level3_id;
        flowLevel3Name = expanded.approver_level3_name;
        flowName = expanded.approval_flow_name;
      } else if (expanded && expanded._deleted) {
        return res.status(400).json({ error: '所选审批流已被删除' });
      }
    }

    const fields = ['updated_at = NOW()'];
    const values = [];
    let idx = 1;

    const add = (field, val) => {
      if (val !== undefined) { fields.push(`${field} = $${idx++}`); values.push(val); }
    };
    add('submitter_name', submitter_name);
    add('aftersales_date', aftersales_date);
    add('status', status);
    add('brand', brand);
    add('model', model);
    add('category', category);
    add('platforms', platforms);
    add('items', items !== undefined ? JSON.stringify(items) : undefined);
    add('total_quantity', total_quantity);
    add('current_approval_level', current_approval_level);
    if (approval_flow_id !== undefined) {
      add('approval_flow_id', approval_flow_id);
      if (flowName !== undefined) add('approval_flow_name', flowName);
    }
    add('approver_level1_id', flowLevel1Id);
    add('approver_level1_name', flowLevel1Name);
    add('approver_level2_id', flowLevel2Id);
    add('approver_level2_name', flowLevel2Name);
    add('approver_level3_id', flowLevel3Id);
    add('approver_level3_name', flowLevel3Name);
    add('approval_level1_status', approval_level1_status);
    add('approval_level2_status', approval_level2_status);
    add('approval_history', approval_history !== undefined ? JSON.stringify(approval_history) : undefined);

    values.push(req.params.id);
    const result = await query(
      `UPDATE aftersales_records SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: '记录不存在' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/records/:id', requireApiPermission('record_delete'), async (req, res) => {
  try {
    const result = await query('DELETE FROM aftersales_records WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '记录不存在' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 商品 API ----
app.get('/api/products', requireApiPermission('product_view'), async (req, res) => {
  try {
    const result = await query('SELECT * FROM products ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/products', requireApiPermission('product_create'), async (req, res) => {
  try {
    const { id, sku_code, product_name, brand, model, category, country, ean_code, status, price } = req.body;
    const result = await query(
      `INSERT INTO products (id, sku_code, product_name, brand, model, category, country, ean_code, status, price, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW()) RETURNING *`,
      [id, sku_code, product_name || '', brand || '', model || '', category || '', country || '', ean_code || '', status || 'active', price || 0]
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/products/:id', requireApiPermission('product_edit'), async (req, res) => {
  try {
    const { sku_code, product_name, brand, model, category, country, ean_code, status, price } = req.body;
    const fields = [];
    const values = [];
    let idx = 1;
    const add = (field, val) => { if (val !== undefined) { fields.push(`${field} = $${idx++}`); values.push(val); } };
    add('sku_code', sku_code);
    add('product_name', product_name);
    add('brand', brand);
    add('model', model);
    add('category', category);
    add('country', country);
    add('ean_code', ean_code);
    add('status', status);
    add('price', price);
    fields.push(`updated_at = NOW()`);

    if (fields.length === 0) return res.json({ message: '没有需要更新的字段' });
    values.push(req.params.id);
    const result = await query(
      `UPDATE products SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: '商品不存在' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/products/:id', requireApiPermission('product_delete'), async (req, res) => {
  try {
    const result = await query('DELETE FROM products WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '商品不存在' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 批量导入商品
app.post('/api/products/bulk-import', requireApiPermission('product_import'), async (req, res) => {
  try {
    const items = req.body.items || [];
    const result = { created: 0, updated: 0, deleted: 0, failed: 0, errors: [] };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const rowNum = item.__rowNum || (i + 2);
      try {
        const sku = String(item.sku_code || '').trim();
        if (!sku) {
          result.failed++;
          result.errors.push({ row: rowNum, reason: 'SKU编码为空' });
          continue;
        }
        const brand = String(item.brand || '').trim();
        if (!brand) {
          result.failed++;
          result.errors.push({ row: rowNum, reason: '品牌为空' });
          continue;
        }

        const statusVal = String(item.status || 'active').trim().toLowerCase();
        const isDeleteMark = statusVal === 'delete' || statusVal === 'disabled' || statusVal === '删除' || statusVal === '禁用';

        const existing = await query('SELECT id FROM products WHERE sku_code = $1', [sku]);
        const exists = existing.rows.length > 0;

        if (isDeleteMark) {
          if (exists) {
            await query('DELETE FROM products WHERE sku_code = $1', [sku]);
            result.deleted++;
          } else {
            result.failed++;
            result.errors.push({ row: rowNum, reason: '要删除/禁用的 SKU 不存在' });
          }
          continue;
        }

        const productData = {
          id: exists ? existing.rows[0].id : ('prod_' + Date.now() + '_' + i),
          sku_code: sku,
          product_name: String(item.product_name || item.model || '').trim(),
          brand,
          model: String(item.model || '').trim(),
          category: String(item.category || '').trim(),
          country: String(item.country || '').trim(),
          ean_code: String(item.ean_code || '').trim(),
          status: 'active',
          price: parseFloat(item.price) || 0
        };

        if (exists) {
          await query(
            `UPDATE products SET
              product_name = $1, brand = $2, model = $3, category = $4,
              country = $5, ean_code = $6, status = $7, price = $8, updated_at = NOW()
             WHERE sku_code = $9`,
            [productData.product_name, productData.brand, productData.model, productData.category,
             productData.country, productData.ean_code, productData.status, productData.price, sku]
          );
          result.updated++;
        } else {
          await query(
            `INSERT INTO products (id, sku_code, product_name, brand, model, category, country, ean_code, status, price, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())`,
            [productData.id, productData.sku_code, productData.product_name, productData.brand, productData.model,
             productData.category, productData.country, productData.ean_code, productData.status, productData.price]
          );
          result.created++;
        }
      } catch (err) {
        result.failed++;
        result.errors.push({ row: rowNum, reason: err.message });
      }
    }

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 批量删除商品
app.post('/api/products/batch-delete', requireApiPermission('product_delete'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '请提供要删除的商品ID列表' });
    }
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const result = await query(
      `DELETE FROM products WHERE id IN (${placeholders}) RETURNING id`,
      ids
    );
    res.json({ deleted: result.rows.length, ids: result.rows.map(r => r.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 销售数据 API ----
app.get('/api/sales', async (req, res) => {
  try {
    const result = await query('SELECT * FROM sales_data ORDER BY date DESC');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sales', async (req, res) => {
  try {
    const entries = Array.isArray(req.body) ? req.body : [req.body];
    const results = [];
    for (const entry of entries) {
      const { id, date, product_name, sku_code, quantity, amount, platform } = entry;
      const result = await query(
        `INSERT INTO sales_data (id, date, product_name, sku_code, quantity, amount, platform) 
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, date, product_name || '', sku_code || '', quantity || 0, amount || 0, platform || '']
      );
      results.push(result.rows[0]);
    }
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 审批流 API ----
app.get('/api/approval-flows', requireLogin, async (req, res) => {
  try {
    const result = await query('SELECT * FROM approval_flows ORDER BY created_at ASC');
    const rows = result.rows.map(r => ({
      ...r,
      nodes: typeof r.nodes === 'string' ? JSON.parse(r.nodes || '[]') : (r.nodes || [])
    }));
    // 兜底: 收集所有 nodes 中的 approver_id / backup_approver_id,从 users 表反查 name 补全
    const allIds = new Set();
    rows.forEach(r => (r.nodes || []).forEach(n => {
      if (n.approver_id) allIds.add(n.approver_id);
      if (n.backup_approver_id) allIds.add(n.backup_approver_id);
    }));
    if (allIds.size) {
      const ur = await query('SELECT id, name FROM users WHERE id = ANY($1::text[])', [Array.from(allIds)]);
      const nameMap = {};
      ur.rows.forEach(u => { nameMap[u.id] = u.name; });
      rows.forEach(r => (r.nodes || []).forEach(n => {
        if (n.approver_id && !n.approver_name) n.approver_name = nameMap[n.approver_id] || '';
        if (n.backup_approver_id && !n.backup_approver_name) n.backup_approver_name = nameMap[n.backup_approver_id] || '';
      }));
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/approval-flows', requireApiPermission('system_config'), async (req, res) => {
  try {
    const { id, name, scope, enabled, nodes } = req.body;
    if (!name) return res.status(400).json({ error: '流程名称不能为空' });
    const result = await query(
      `INSERT INTO approval_flows (id, name, scope, enabled, nodes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING *`,
      [id || ('flow_' + Date.now()), name, scope || '全部售后记录', enabled !== undefined ? enabled : false,
       JSON.stringify(nodes || [])]
    );
    const row = result.rows[0];
    res.json({ ...row, nodes: typeof row.nodes === 'string' ? JSON.parse(row.nodes || '[]') : (row.nodes || []) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/approval-flows/:id', requireApiPermission('system_config'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, scope, enabled, nodes } = req.body;
    const fields = ['updated_at = NOW()'];
    const values = [];
    let idx = 1;
    const add = (field, val) => { if (val !== undefined) { fields.push(`${field} = $${idx++}`); values.push(val); } };
    add('name', name);
    add('scope', scope);
    add('enabled', enabled);
    add('nodes', nodes !== undefined ? JSON.stringify(nodes) : undefined);
    values.push(id);
    const result = await query(
      `UPDATE approval_flows SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: '审批流不存在' });
    const row = result.rows[0];
    res.json({ ...row, nodes: typeof row.nodes === 'string' ? JSON.parse(row.nodes || '[]') : (row.nodes || []) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/approval-flows/:id', requireApiPermission('system_config'), async (req, res) => {
  try {
    if (req.params.id === 'flow_standard') return res.status(400).json({ error: '不能删除标准审批流' });
    const result = await query('DELETE FROM approval_flows WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '审批流不存在' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 数据库状态
app.get('/api/db/status', (req, res) => {
  const dbUrl = process.env.DATABASE_URL || '';
  res.json({
    configured: Boolean(dbUrl),
    connected: Boolean(require('./db').getPool())
  });
});

// 临时诊断：检查 dictionaries 表结构
app.get('/api/db/diag', async (req, res) => {
  try {
    const { rows } = await query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'dictionaries' ORDER BY ordinal_position");
    res.json({ columns: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 临时修复：强制添加 parent_code 列
app.post('/api/db/fix-parent-code', async (req, res) => {
  try {
    await query(`ALTER TABLE dictionaries ADD COLUMN IF NOT EXISTS parent_code VARCHAR(128) DEFAULT ''`);
    const { rows } = await query("SELECT column_name FROM information_schema.columns WHERE table_name = 'dictionaries' AND column_name = 'parent_code'");
    res.json({ success: true, columnExists: rows.length > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 字典 API ====================
app.get('/api/dictionaries', requireLogin, async (req, res) => {
  try {
    const { category, parent_code } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;
    if (category) { conditions.push(`category = $${idx++}`); params.push(category); }
    if (parent_code) { conditions.push(`parent_code = $${idx++}`); params.push(parent_code); }
    let sql;
    if (conditions.length > 0) {
      sql = 'SELECT * FROM dictionaries WHERE ' + conditions.join(' AND ') + ' ORDER BY sort_order ASC, created_at ASC';
    } else {
      sql = 'SELECT * FROM dictionaries ORDER BY category, sort_order ASC';
    }
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dictionaries', requireApiPermission('system_config'), async (req, res) => {
  try {
    const { category, code, label_zh, label_en, label_id, sort_order, enabled, parent_code } = req.body;
    if (!category || !code) return res.status(400).json({ error: '类别和代码不能为空' });
    const id = 'dict_' + category + '_' + code + '_' + Date.now().toString(36);
    const result = await query(
      `INSERT INTO dictionaries (id, category, code, label_zh, label_en, label_id, sort_order, enabled, parent_code, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW()) RETURNING *`,
      [id, category, code, label_zh || '', label_en || '', label_id || '', sort_order || 0, enabled !== false, parent_code || '']
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/dictionaries/:id', requireApiPermission('system_config'), async (req, res) => {
  try {
    const { id } = req.params;
    const { label_zh, label_en, label_id, sort_order, enabled, parent_code } = req.body;
    const fields = ['updated_at = NOW()'];
    const values = [];
    let idx = 1;
    const add = (f, v) => { if (v !== undefined) { fields.push(`${f} = $${idx++}`); values.push(v); } };
    add('label_zh', label_zh);
    add('label_en', label_en);
    add('label_id', label_id);
    add('sort_order', sort_order);
    add('enabled', enabled);
    add('parent_code', parent_code);
    values.push(id);
    const result = await query(
      `UPDATE dictionaries SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: '字典项不存在' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/dictionaries/:id', requireApiPermission('system_config'), async (req, res) => {
  try {
    const result = await query('DELETE FROM dictionaries WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '字典项不存在' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== 附件 API ====================
app.post('/api/attachments/upload', upload.array('files', 10), async (req, res) => {
  try {
    const { record_id, item_index } = req.body;
    if (!record_id) {
      req.files.forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: '缺少 record_id' });
    }
    const uploadedBy = req.user ? (req.user.id || req.user.username || '') : '';
    const saved = [];
    for (const f of req.files) {
      const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const result = await query(
        `INSERT INTO attachments (id, record_id, item_index, filename, original_name, mime_type, size, path, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [id, record_id, item_index ? parseInt(item_index) : null, f.filename, f.originalname, f.mimetype, f.size, '/uploads/' + f.filename, uploadedBy]
      );
      saved.push(result.rows[0]);
    }
    res.json(saved);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/attachments/record/:recordId', requireLogin, async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM attachments WHERE record_id = $1 ORDER BY uploaded_at ASC',
      [req.params.recordId]
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/attachments/:id', requireLogin, async (req, res) => {
  try {
    const result = await query('SELECT * FROM attachments WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '附件不存在' });
    const att = result.rows[0];
    const filePath = path.join(__dirname, att.path.replace(/^\/uploads\//, 'uploads/'));
    fs.unlink(filePath, () => {});
    await query('DELETE FROM attachments WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 全局 multer 错误处理
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || /不支持的文件类型/.test(err.message)) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

let tenantAccessToken = null;
let tokenExpiresAt = 0;

/**
 * 获取 tenant_access_token（企业自建应用）
 * 参考: https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
 */
async function getTenantAccessToken() {
  if (!feishuConfigured) {
    return { error: '飞书未配置' };
  }

  // 缓存有效期内直接返回
  if (tenantAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return { token: tenantAccessToken };
  }

  try {
    console.log('[Feishu] 获取 tenant_access_token', {
      appId: maskSecret(FEISHU_APP_ID),
      hasAppSecret: Boolean(FEISHU_APP_SECRET)
    });
    const response = await axios.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );

    if (response.data.code === 0) {
      tenantAccessToken = response.data.tenant_access_token;
      tokenExpiresAt = Date.now() + (response.data.expire || 7200) * 1000;
      console.log('[Feishu] Token 获取成功，有效期至:', new Date(tokenExpiresAt).toISOString());
      return { token: tenantAccessToken };
    } else {
      console.error('[Feishu] Token 获取失败:', JSON.stringify(response.data));
      return { error: response.data.msg || '获取 token 失败', code: response.data.code, response: response.data };
    }
  } catch (e) {
    console.error('[Feishu] Token 获取异常:', e.response?.data ? JSON.stringify(e.response.data) : e.message);
    return { error: e.response?.data?.msg || e.message, code: e.response?.data?.code, response: e.response?.data };
  }
}

// ==================== 飞书 OAuth2.0 登录 ====================
/**
 * 飞书 OAuth2.0 网页授权
 * 参考: https://open.feishu.cn/document/uAjLw4CM/uYjL24iN/app-authorization/obtain
 */

// 获取登录 URL
app.get('/api/auth/feishu/login', (req, res) => {
  if (!feishuConfigured) {
    recordFeishuEvent('login_not_configured');
    return res.json({ error: '飞书未配置', feishuEnabled: false });
  }

  const redirectUri = `${APP_BASE_URL}/api/auth/feishu/callback`;
  const state = crypto.randomBytes(16).toString('hex');
  rememberOAuthState(state);
  res.cookie(OAUTH_STATE_COOKIE, state, feishuCookieOptions(OAUTH_STATE_MAX_AGE_MS));
  recordFeishuEvent('login_url_created', {
    redirectUri,
    appId: FEISHU_APP_ID.slice(0, 8) + '***',
    state
  });

  const loginUrl = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
    + `?client_id=${FEISHU_APP_ID}`
    + `&response_type=code`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${state}`
    + `&scope=${encodeURIComponent('contact:user.base:readonly')}`
    + `&prompt=consent`;

  res.json({ loginUrl, feishuEnabled: true });
});

// OAuth 回调
app.get('/api/auth/feishu/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const cookies = parseCookies(req.headers.cookie);
  const expectedState = cookies[OAUTH_STATE_COOKIE] || '';
  res.clearCookie(OAUTH_STATE_COOKIE, feishuCookieOptions(0));
  recordFeishuEvent('callback_received', {
    hasCode: Boolean(code),
    hasState: Boolean(state),
    hasCookieState: Boolean(expectedState),
    error: error || ''
  });

  if (error) {
    // 用户拒绝授权，返回错误信息到前端
    recordFeishuEvent('callback_error_from_feishu', { error });
    return res.redirect(`/?feishu_error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    recordFeishuEvent('callback_missing_code');
    return res.redirect('/?feishu_error=missing_code');
  }

  if (!consumeOAuthState(state, expectedState)) {
    console.warn('[Feishu] OAuth state 校验失败', {
      hasState: Boolean(state),
      hasCookieState: Boolean(expectedState),
      cachedStates: oauthStates.size
    });
    recordFeishuEvent('callback_invalid_state', {
      hasState: Boolean(state),
      hasCookieState: Boolean(expectedState),
      cachedStates: oauthStates.size
    });
    return res.redirect('/?feishu_error=invalid_state');
  }

  if (!feishuConfigured) {
    recordFeishuEvent('callback_not_configured');
    return res.redirect('/?feishu_error=not_configured');
  }

  try {
    // Step 1: 用 code 换取 user_access_token (v2 OAuth2)
    // v2 返回标准 OAuth2 格式，不是 {code, data} 包装
    let tokenData;
    try {
      const tokenRes = await axios.post(
        'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
        {
          grant_type: 'authorization_code',
          client_id: FEISHU_APP_ID,
          client_secret: FEISHU_APP_SECRET,
          code,
          redirect_uri: `${APP_BASE_URL}/api/auth/feishu/callback`
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      );

      if (tokenRes.data && tokenRes.data.code !== undefined && tokenRes.data.code !== 0) {
        console.error('[Feishu] Code 换 token 失败:', tokenRes.data);
        recordFeishuEvent('token_exchange_failed', { response: tokenRes.data });
        return res.redirect(`/?feishu_error=${encodeURIComponent(tokenRes.data.msg || tokenRes.data.message || 'token_exchange_failed')}`);
      }

      tokenData = tokenRes.data.data || tokenRes.data;
    } catch (tokenErr) {
      console.error('[Feishu] Code 换 token 请求失败:', tokenErr.response?.data || tokenErr.message);
      recordFeishuEvent('token_exchange_request_failed', {
        response: tokenErr.response?.data || null,
        message: tokenErr.message
      });
      return res.redirect(`/?feishu_error=${encodeURIComponent(tokenErr.response?.data?.msg || tokenErr.response?.data?.message || 'token_exchange_failed')}`);
    }

    if (!tokenData || !tokenData.access_token) {
      console.error('[Feishu] Token 响应无效:', tokenData);
      recordFeishuEvent('token_response_invalid', { tokenData });
      return res.redirect(`/?feishu_error=token_response_invalid`);
    }

    const userAccessToken = tokenData.access_token;
    recordFeishuEvent('token_exchange_success');

    // Step 2: 获取用户信息
    const userRes = await axios.get(
      'https://open.feishu.cn/open-apis/authen/v1/user_info',
      { headers: { 'Authorization': `Bearer ${userAccessToken}` }, timeout: 10000 }
    );

    if (userRes.data.code !== 0) {
      console.error('[Feishu] 获取用户信息失败:', userRes.data);
      recordFeishuEvent('get_user_failed', { response: userRes.data });
      return res.redirect(`/?feishu_error=${encodeURIComponent(userRes.data.msg || 'get_user_failed')}`);
    }

    const userInfo = userRes.data.data;
    if (!userInfo || !userInfo.open_id) {
      console.error('[Feishu] 用户信息缺少 open_id:', userInfo);
      recordFeishuEvent('user_info_invalid', { userInfo });
      return res.redirect(`/?feishu_error=user_info_invalid`);
    }
    recordFeishuEvent('get_user_success', {
      openId: userInfo.open_id,
      name: userInfo.en_name || userInfo.name || userInfo.nickname || ''
    });

    console.log('[Feishu] 原始用户信息 (bytes):', JSON.stringify(userInfo));
    console.log('[Feishu] name 字段:', userInfo.name, 'en_name:', userInfo.en_name, 'nickname:', userInfo.nickname);

    // Step 3: 校验组织（如果配置了 ORG_ID）
    if (FEISHU_ORG_ID) {
      // 获取用户所在组织列表
      try {
        const tenantToken = await getTenantAccessToken();
        if (tenantToken.token) {
          const deptRes = await axios.get(
            `https://open.feishu.cn/open-apis/contact/v3/users/${userInfo.open_id}?department_id_type=open_department_id&user_id_type=open_id`,
            { headers: { 'Authorization': `Bearer ${tenantToken.token}` }, timeout: 10000 }
          );
          
          if (deptRes.data.code === 0) {
            const departments = deptRes.data.data.user?.department_ids || [];
            // TODO: 更严格的组织校验逻辑
            console.log('[Feishu] 用户部门:', departments);
          }
        }
      } catch (deptErr) {
        console.warn('[Feishu] 获取用户部门失败，跳过组织校验:', deptErr.message);
      }
    }

    // Step 4: 构造返回给前端的用户数据
    // 优先使用 en_name（英文/常用名），再回退到姓名、昵称、邮箱前缀
    const displayName = getFeishuDisplayName(userInfo);
    const feishuUser = {
      feishu_open_id: userInfo.open_id,
      feishu_user_id: userInfo.user_id || '',
      feishu_union_id: userInfo.union_id || '',
      feishu_name: displayName,
      feishu_raw_name: userInfo.name || '',
      feishu_en_name: userInfo.en_name || '',
      feishu_nickname: userInfo.nickname || '',
      feishu_email: userInfo.email || '',
      feishu_avatar: getFeishuAvatar(userInfo),
      feishu_mobile: userInfo.mobile || '',
      feishu_tenant_key: userInfo.tenant_key || ''
    };

    // 将用户信息编码后传给前端
    const userDataB64 = Buffer.from(JSON.stringify(feishuUser)).toString('base64');
    
    // 重定向到前端，带上用户信息和来源标记
    recordFeishuEvent('redirect_to_frontend');
    res.redirect(`/?feishu_user=${encodeURIComponent(userDataB64)}#page=overview`);

  } catch (e) {
    console.error('[Feishu] OAuth 回调异常:', e.message);
    recordFeishuEvent('callback_server_error', { message: e.message });
    res.redirect(`/?feishu_error=${encodeURIComponent('server_error')}`);
  }
});

app.get('/api/auth/feishu/debug', (req, res) => {
  res.json({
    configured: feishuConfigured,
    appId: FEISHU_APP_ID ? FEISHU_APP_ID.slice(0, 8) + '***' : '',
    baseUrl: APP_BASE_URL,
    callbackUrl: `${APP_BASE_URL}/api/auth/feishu/callback`,
    pendingStates: oauthStates.size,
    events: feishuLoginEvents
  });
});

// 获取飞书配置状态
app.get('/api/auth/feishu/status', (req, res) => {
  res.json({
    feishuEnabled: FEISHU_ENABLED && feishuConfigured,
    appId: FEISHU_APP_ID ? FEISHU_APP_ID.slice(0, 8) + '***' : '',
    orgId: FEISHU_ORG_ID || '',
    appName: FEISHU_APP_NAME,
    baseUrl: APP_BASE_URL,
    configured: feishuConfigured
  });
});

// ==================== 飞书通讯录搜索 ====================
// GET /api/feishu/contacts/search?query=xxx
// 通过飞书 find_by_department 接口递归搜索组织成员
// 需要权限：获取通讯录基本信息（contact:contact:readonly）或 以应用身份访问通讯录
app.get('/api/feishu/contacts/search', async (req, res) => {
  const query = (req.query.query || '').trim().toLowerCase();
  
  if (!feishuConfigured) {
    return res.json({ success: false, error: '飞书未配置', users: [] });
  }
  
  const tokenResult = await getTenantAccessToken();
  if (tokenResult.error) {
    return res.status(500).json({ success: false, error: `获取飞书 token 失败: ${tokenResult.error}`, users: [] });
  }

  const token = tokenResult.token;

  try {
    // ============ 步骤1：递归获取所有部门ID ============
    const departmentIds = [];
    
    async function collectDepartments(parentId) {
      let pageToken = null;
      do {
        let url = `https://open.feishu.cn/open-apis/contact/v3/departments/${parentId}/children`
          + `?department_id_type=open_department_id&fetch_child=true&page_size=50`;
        if (pageToken) url += `&page_token=${pageToken}`;

        try {
          const resp = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 10000
          });

          if (resp.data.code === 0) {
            const items = resp.data.data?.items || [];
            for (const dept of items) {
              departmentIds.push(dept.open_department_id);
            }
            pageToken = resp.data.data?.page_token || null;
          } else {
            console.warn('[Feishu] 获取部门列表失败 (父部门: ' + parentId + '):', resp.data.msg);
            pageToken = null;
          }
        } catch (e) {
          console.warn('[Feishu] 获取部门列表异常 (父部门: ' + parentId + '):', e.message);
          pageToken = null;
        }
      } while (pageToken);
    }

    // 先收集所有部门（从根部门开始，fetch_child=true 递归获取）
    try {
      await collectDepartments(0);
    } catch (deptErr) {
      console.warn('[Feishu] 收集部门列表失败，将仅搜索根部门直属用户:', deptErr.message);
    }
    
    // 添加根部门（根部门直属用户也需要搜索）
    departmentIds.push('0');
    
    console.log(`[Feishu] 共获取 ${departmentIds.length} 个部门（含根部门）`);

    // ============ 步骤2：遍历部门获取用户 ============
    const allUsers = [];
    const seenOpenIds = new Set();
    const maxResults = 50;

    for (const deptId of departmentIds) {
      if (allUsers.length >= maxResults) break;

      let pageToken = null;
      let deptErrorCount = 0;
      
      do {
        if (allUsers.length >= maxResults) break;

        let url = `https://open.feishu.cn/open-apis/contact/v3/users/find_by_department`
          + `?user_id_type=open_id&department_id_type=open_department_id`
          + `&department_id=${deptId}&page_size=50`;
        if (pageToken) url += `&page_token=${pageToken}`;

        try {
          const resp = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 10000
          });

          if (resp.data.code !== 0) {
            deptErrorCount++;
            if (deptErrorCount <= 1) {
              console.warn(`[Feishu] 部门 ${deptId} 用户列表获取失败:`, resp.data.msg);
            }
            break;
          }

          const items = resp.data.data?.items || [];
          for (const u of items) {
            // 去重
            if (seenOpenIds.has(u.open_id)) continue;
            seenOpenIds.add(u.open_id);

            const name = u.name || '';
            const enName = u.en_name || '';
            const nickname = u.nickname || '';
            const email = u.email || '';
            
            // 关键词过滤
            if (query && 
                !name.toLowerCase().includes(query) && 
                !enName.toLowerCase().includes(query) && 
                !nickname.toLowerCase().includes(query) &&
                !email.toLowerCase().includes(query)) {
              continue;
            }
            
            allUsers.push({
              open_id: u.open_id,
              user_id: u.user_id || '',
              union_id: u.union_id || '',
              name: enName || name,
              full_name: name,
              en_name: enName,
              nickname: nickname,
              avatar: u.avatar?.avatar_240 || u.avatar?.avatar_72 || u.avatar?.avatar_origin || '',
              email: email,
              mobile: u.mobile || '',
              department_names: (u.department_names || []).slice(0, 3)
            });

            if (allUsers.length >= maxResults) break;
          }

          pageToken = resp.data.data?.page_token || null;
          
        } catch (e) {
          deptErrorCount++;
          if (deptErrorCount <= 1) {
            console.warn(`[Feishu] 部门 ${deptId} 用户搜索异常:`, e.message);
          }
          break;
        }
      } while (pageToken);
    }

    console.log(`[Feishu] 通讯录搜索 "${query || '(全部)'}" → ${allUsers.length} 条结果 (扫描 ${departmentIds.length} 个部门)`);
    res.json({ success: true, users: allUsers });
    
  } catch (e) {
    console.error('[Feishu] 通讯录搜索异常:', e.message);
    let errorMsg = e.response?.data?.msg || e.message || '搜索异常';
    
    // 友好的权限提示
    if (e.response?.data?.code === 99991663 || errorMsg.includes('no permission')) {
      errorMsg = '飞书应用缺少通讯录权限。请在飞书开发者后台 > 权限管理中开通"获取通讯录基本信息"或"以应用身份访问通讯录"权限';
    }
    
    res.json({ success: false, error: errorMsg, users: [] });
  }
});

// 退出登录：清除飞书相关状态
app.post('/api/auth/feishu/logout', (req, res) => {
  res.clearCookie('feishu_session');
  res.json({ success: true });
});

// ==================== 飞书消息推送 ====================
/**
 * 发送审批通知（互动卡片消息）
 * 参考: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create
 */

function normalizeFeishuApprover(approver, dbUser = null) {
  const merged = { ...(approver || {}) };
  if (dbUser) {
    merged.id = merged.id || dbUser.id;
    merged.name = merged.name || dbUser.name || dbUser.username;
    merged.feishu_open_id = merged.feishu_open_id || dbUser.feishu_open_id || dbUser.open_id;
    merged.feishu_user_id = merged.feishu_user_id || dbUser.feishu_user_id || dbUser.user_id;
    merged.feishu_union_id = merged.feishu_union_id || dbUser.feishu_union_id;
  }
  merged.feishu_open_id = merged.feishu_open_id || merged.open_id || '';
  merged.feishu_user_id = merged.feishu_user_id || merged.user_id || '';
  merged.name = merged.name || merged.username || '未知审批人';
  return merged;
}

function getFeishuReceiver(approver) {
  if (hasText(approver.feishu_open_id)) {
    return { type: 'open_id', id: approver.feishu_open_id.trim() };
  }
  if (hasText(approver.feishu_user_id)) {
    return { type: 'user_id', id: approver.feishu_user_id.trim() };
  }
  return null;
}

async function resolveApproversForNotify(approvers) {
  const resolved = [];
  for (const approver of approvers) {
    let dbUser = null;
    if (approver && approver.id) {
      try {
        const userResult = await query(
          'SELECT id, username, name, feishu_open_id, feishu_user_id, feishu_union_id FROM users WHERE id = $1',
          [approver.id]
        );
        dbUser = userResult.rows[0] || null;
      } catch (e) {
        console.error(`[Feishu] 查询审批人飞书绑定失败 system_user_id=${approver.id}:`, e.message);
      }
    }
    const normalized = normalizeFeishuApprover(approver, dbUser);
    const receiver = getFeishuReceiver(normalized);
    console.log('[Feishu] 审批人绑定检查', {
      name: normalized.name,
      system_user_id: normalized.id || '',
      has_open_id: Boolean(normalized.feishu_open_id),
      has_user_id: Boolean(normalized.feishu_user_id),
      receive_id_type: receiver ? receiver.type : 'missing'
    });
    resolved.push(normalized);
  }
  return resolved;
}

async function sendFeishuInteractiveMessage({ token, receiver, card, recipientName, context }) {
  const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiver.type)}`;
  try {
    const response = await axios.post(
      url,
      {
        receive_id: receiver.id,
        msg_type: 'interactive',
        content: JSON.stringify(card)
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    const data = response.data || {};
    console.log('[Feishu] 消息发送接口响应', JSON.stringify({
      code: data.code,
      msg: data.msg || '',
      message_id: data.data?.message_id || '',
      receive_id_type: receiver.type,
      context
    }));

    if (data.code === 0) {
      return { success: true, messageId: data.data?.message_id || '' };
    }

    const reason = getFeishuPermissionHint(data.code, data.msg);
    console.error('[Feishu] 消息发送失败', JSON.stringify({
      recipientName,
      receive_id_type: receiver.type,
      receive_id: receiver.id,
      code: data.code,
      msg: data.msg || '',
      reason,
      response: data,
      context
    }));
    return { success: false, code: data.code, reason, response: data };
  } catch (e) {
    const apiData = e.response?.data;
    console.error('[Feishu] 消息发送异常', JSON.stringify({
      recipientName,
      receive_id_type: receiver.type,
      receive_id: receiver.id,
      message: e.message,
      response: apiData || null,
      context
    }));
    return {
      success: false,
      code: apiData?.code || 'NETWORK_ERROR',
      reason: apiData?.msg || e.message,
      response: apiData || null
    };
  }
}

app.post('/api/notify/approval', requireLogin, async (req, res) => {
  const { recordId, record, approvers, approvalLevel } = req.body;

  if (!recordId || !record || !Array.isArray(approvers) || !approvers.length) {
    return res.status(400).json({ success: false, error: '缺少必要参数' });
  }

  const currentLevel = Number(approvalLevel || record.current_approval_level || 1);
  const resolvedApprovers = await resolveApproversForNotify(approvers);
  const recordDisplayId = `AS${String(recordId).padStart(4, '0')}`;
  const detailUrl = `${APP_BASE_URL}/#page=detail&id=${recordId}`;

  console.log('[Feishu] 开始发送审批通知', {
    recordId,
    recordDisplayId,
    approvalLevel: currentLevel,
    approvalLevelName: approvalLevelName(currentLevel),
    feishuEnabled: FEISHU_ENABLED,
    hasAppId: Boolean(FEISHU_APP_ID),
    hasAppSecret: Boolean(FEISHU_APP_SECRET),
    appId: maskSecret(FEISHU_APP_ID),
    targets: resolvedApprovers.map(a => ({ name: a.name, system_user_id: a.id || '' }))
  });

  if (!feishuConfigured) {
    console.log('[Mock] 模拟发送审批通知:', {
      recordDisplayId,
      submitter: record.submitter_name,
      approvalLevel: approvalLevelName(currentLevel),
      approvers: resolvedApprovers.map(a => a.name),
      itemCount: (record.items || []).length
    });
    return res.json({
      success: true,
      mock: true,
      message: '模拟模式：通知已记录（飞书未配置时使用）',
      sentTo: resolvedApprovers.map(a => a.name)
    });
  }

  const tokenResult = await getTenantAccessToken();
  if (tokenResult.error) {
    console.error('[Feishu] 获取 tenant_access_token 失败', JSON.stringify(tokenResult));
    return res.json({
      success: false,
      error: `获取飞书 token 失败: ${tokenResult.error}`,
      results: { success: [], failed: [{ name: 'tenant_access_token', reason: tokenResult.error, code: tokenResult.code || '' }] }
    });
  }

  const results = { success: [], failed: [] };
  const sentReceivers = new Set();

  for (const approver of resolvedApprovers) {
    const receiver = getFeishuReceiver(approver);
    if (!receiver) {
      const reason = '审批人未绑定飞书账号：feishu_open_id/open_id/user_id 均为空';
      console.warn('[Feishu] 跳过未绑定审批人', {
        name: approver.name,
        system_user_id: approver.id || '',
        has_open_id: Boolean(approver.feishu_open_id),
        has_user_id: Boolean(approver.feishu_user_id),
        reason
      });
      results.failed.push({
        name: approver.name,
        userId: approver.id || '',
        reason,
        code: 'APPROVER_NOT_BOUND'
      });
      continue;
    }

    const receiverKey = `${receiver.type}:${receiver.id}`;
    if (sentReceivers.has(receiverKey)) {
      console.log('[Feishu] 当前审批级别重复收件人已跳过', {
        name: approver.name,
        system_user_id: approver.id || '',
        receive_id_type: receiver.type
      });
      continue;
    }
    sentReceivers.add(receiverKey);

    const card = buildApprovalCard({
      recordDisplayId,
      submitterName: record.submitter_name || '-',
      aftersalesDate: record.aftersales_date,
      items: record.items || [],
      brands: record.brand || '',
      platforms: Array.isArray(record.platforms) ? record.platforms.join(', ') : (record.platforms || ''),
      detailUrl,
      approvalLevel: currentLevel,
      currentApproverName: approver.name
    });

    console.log('[Feishu] 准备发送审批通知', {
      recordDisplayId,
      approverName: approver.name,
      system_user_id: approver.id || '',
      receive_id_type: receiver.type,
      receive_id: receiver.id
    });

    const sendResult = await sendFeishuInteractiveMessage({
      token: tokenResult.token,
      receiver,
      card,
      recipientName: approver.name,
      context: { type: 'approval', recordId, approvalLevel: currentLevel }
    });

    if (sendResult.success) {
      results.success.push({
        name: approver.name,
        userId: approver.id || '',
        receiveIdType: receiver.type,
        messageId: sendResult.messageId
      });
    } else {
      results.failed.push({
        name: approver.name,
        userId: approver.id || '',
        receiveIdType: receiver.type,
        reason: sendResult.reason,
        code: sendResult.code
      });
    }
  }

  const summary = results.success.length > 0
    ? `已通知 ${results.success.map(r => r.name).join('、')}`
    : '通知发送失败';
  console.log('[Feishu] 审批通知发送汇总', JSON.stringify({
    recordId,
    approvalLevel: currentLevel,
    successCount: results.success.length,
    failedCount: results.failed.length,
    failed: results.failed
  }));

  res.json({
    success: results.failed.length === 0,
    results,
    message: summary
  });
});

app.post('/api/notify/feishu-test', requireApiPermission('user_manage'), async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ success: false, error: '缺少用户 ID' });

  let user;
  try {
    const result = await query(
      'SELECT id, username, name, feishu_open_id, feishu_user_id, feishu_union_id FROM users WHERE id = $1',
      [userId]
    );
    user = result.rows[0];
  } catch (e) {
    console.error('[Feishu] 测试通知查询用户失败', { userId, error: e.message });
    return res.status(500).json({ success: false, error: e.message });
  }

  if (!user) return res.status(404).json({ success: false, error: '用户不存在' });

  const approver = normalizeFeishuApprover({ id: user.id }, user);
  const receiver = getFeishuReceiver(approver);
  console.log('[Feishu] 测试通知绑定检查', {
    name: approver.name,
    system_user_id: approver.id,
    has_open_id: Boolean(approver.feishu_open_id),
    has_user_id: Boolean(approver.feishu_user_id),
    receive_id_type: receiver ? receiver.type : 'missing'
  });

  if (!receiver) {
    const reason = '用户未绑定飞书账号：feishu_open_id/open_id/user_id 均为空';
    console.warn('[Feishu] 测试通知失败', { userId, name: approver.name, reason });
    return res.json({ success: false, error: reason, code: 'USER_NOT_BOUND' });
  }

  if (!feishuConfigured) {
    console.log('[Mock] 模拟发送飞书测试通知', { userId, name: approver.name });
    return res.json({ success: true, mock: true, message: '模拟模式：测试通知已记录' });
  }

  const tokenResult = await getTenantAccessToken();
  if (tokenResult.error) {
    console.error('[Feishu] 测试通知获取 token 失败', JSON.stringify(tokenResult));
    return res.json({ success: false, error: tokenResult.error, code: tokenResult.code || 'TOKEN_ERROR' });
  }

  const card = buildFeishuTestCard({
    userName: approver.name,
    detailUrl: APP_BASE_URL
  });
  const sendResult = await sendFeishuInteractiveMessage({
    token: tokenResult.token,
    receiver,
    card,
    recipientName: approver.name,
    context: { type: 'feishu_test', userId }
  });

  if (!sendResult.success) {
    return res.json({ success: false, error: sendResult.reason, code: sendResult.code, response: sendResult.response });
  }
  res.json({ success: true, message: '测试通知已发送', messageId: sendResult.messageId });
});

/**
 * 构建飞书互动卡片（审批通知）
 */
function buildApprovalCard({ recordDisplayId, submitterName, aftersalesDate, items, brands, platforms, detailUrl, approvalLevel, currentApproverName }) {
  // 构建 SKU 明细文本（最多展示 5 条）
  const skuLines = items.slice(0, 5).map(it => {
    const reason = it.return_reason || '-';
    const process = it.process_status || '-';
    return `• ${it.sku_code || '-'} | ${it.order_no || '-'} | ×${it.quantity || 0} | ${reason} | ${process}`;
  });
  if (items.length > 5) {
    skuLines.push(`... 共 ${items.length} 条明细`);
  }

  const skuContent = skuLines.join('\n');

  // 处理状态统计
  const processSummary = {};
  items.forEach(it => {
    const ps = it.process_status || '未知';
    processSummary[ps] = (processSummary[ps] || 0) + 1;
  });
  const processText = Object.entries(processSummary)
    .map(([k, v]) => `${k}: ${v}条`)
    .join(' / ');
  const totalQuantity = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const levelText = approvalLevelName(approvalLevel);
  const safeSkuContent = skuContent || '-';

  return {
    config: {
      wide_screen_mode: true // 宽屏模式
    },
    header: {
      title: {
        tag: 'plain_text',
        content: '📋 售后审批通知' + (approvalLevel ? ` - 待${levelText}审批` : '')
      },
      template: 'blue'
    },
    elements: [
      {
        tag: 'div',
        fields: [
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**售后单号**\n${recordDisplayId}`
            }
          },
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**提交人**\n${submitterName}`
            }
          },
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**售后日期**\n${formatCardDate(aftersalesDate)}`
            }
          },
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**SKU / 数量**\n${items.length} 个 SKU / ${totalQuantity} 件`
            }
          },
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**当前审批人**\n${currentApproverName || '-'}`
            }
          },
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**当前审批级别**\n${levelText}审批`
            }
          }
        ]
      },
      {
        tag: 'hr'
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**SKU 明细**\n${safeSkuContent}`
        }
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**处理状态分布**\n${processText || '-'}`
        }
      },
      {
        tag: 'hr'
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `品牌：${brands || '-'} | 平台：${platforms || '-'}`
          }
        ]
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: '📝 查看/审批'
            },
            type: 'primary',
            url: detailUrl,
            value: {}
          }
        ]
      }
    ]
  };
}

function buildFeishuTestCard({ userName, detailUrl }) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '飞书通知测试' },
      template: 'green'
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**接收人**\n${userName || '-'}\n\n**测试时间**\n${formatCardDate(new Date())}`
        }
      },
      {
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: '如果你收到这条消息，说明该用户的飞书绑定和机器人消息权限可用。' }
        ]
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '打开系统' },
            type: 'primary',
            url: detailUrl,
            value: {}
          }
        ]
      }
    ]
  };
}

// ==================== 通用兜底路由 ====================
// 其他所有未匹配路由返回首页（支持 SPA）
app.get('*', (req, res) => {
  // 排除已处理的 API 路由
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    res.status(404).json({ error: 'API not found' });
  }
});

// ==================== 启动服务器 ====================
async function startServer() {
  // 尝试初始化数据库（如果 DATABASE_URL 未设置则跳过）
  const dbOk = await initDatabase();
  if (dbOk) {
    console.log('✅ 数据库已初始化');
  } else if (process.env.DATABASE_URL) {
    console.log('⚠ 数据库配置但初始化失败，请检查 DATABASE_URL');
  } else {
    console.log('📦 数据库未配置，将使用本地存储模式');
  }

  app.listen(PORT, () => {
    console.log(`\n✅ 服务已启动: ${APP_BASE_URL}`);
    console.log(`📋 飞书登录: ${APP_BASE_URL}/api/auth/feishu/login`);
    console.log(`📊 飞书状态: ${APP_BASE_URL}/api/auth/feishu/status`);
    console.log(`📨 审批通知: POST ${APP_BASE_URL}/api/notify/approval`);
    console.log(`💾 数据库: ${dbOk ? 'PostgreSQL 已连接' : '本地模式'}`);
    if (!feishuConfigured) {
      console.log(`\n⚠ 当前使用 Mock 模式（飞书未配置）`);
      console.log(`  如需启用飞书集成，请：`);
      console.log(`  1. 复制 .env.example 为 .env`);
      console.log(`  2. 填写飞书应用凭证（App ID / App Secret）`);
      console.log(`  3. 设置 FEISHU_ENABLED=true`);
      console.log(`  4. 重启服务`);
    }
    console.log('');
  });
}

startServer();
