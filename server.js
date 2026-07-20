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
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { query, getPool, initDatabase } = require('./db');

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
// 从 package.json 读取版本，避免手改遗漏导致版本漂移（曾因硬编码 3.9.13 未更新引发缓存/校验异常）
let APP_VERSION = '0.0.0';
try { APP_VERSION = require('./package.json').version || APP_VERSION; } catch (e) {}
const FEISHU_ENABLED = process.env.FEISHU_ENABLED === 'true';
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_ORG_ID = process.env.FEISHU_ORG_ID || ''; // 企业组织 ID，用于校验用户是否属于本组织
const APP_BASE_URL = process.env.BASE_URL || process.env.APP_BASE_URL || `http://localhost:${PORT}`;

// ==================== Cloudflare R2 附件存储配置 ====================
// 当配置了 R2 凭证时，附件上传到 R2 对象存储（持久化，不受 Render 临时磁盘重启影响）；
// 未配置时回退到本地 uploads/ 目录（仅开发/兜底用）。
const R2_CONFIG = {
  accountId: process.env.R2_ACCOUNT_ID || '',
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  bucket: process.env.R2_BUCKET_NAME || '',
  publicUrl: (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, ''),
  endpoint: (process.env.R2_ENDPOINT || (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : ''))
};
const R2_ENABLED = Boolean(R2_CONFIG.accountId && R2_CONFIG.accessKeyId && R2_CONFIG.secretAccessKey && R2_CONFIG.bucket);
let r2Client = null;
if (R2_ENABLED) {
  r2Client = new S3Client({
    region: 'auto',
    endpoint: R2_CONFIG.endpoint,
    credentials: {
      accessKeyId: R2_CONFIG.accessKeyId,
      secretAccessKey: R2_CONFIG.secretAccessKey
    }
  });
  console.log('[R2] 已启用 Cloudflare R2 附件存储, 桶:', R2_CONFIG.bucket);
} else {
  console.log('[R2] 未配置 R2 凭证, 附件将保存在本地 uploads/ 目录(部署环境下重启会丢失)');
}
// 从数据库存储的 path 中解析出 R2 对象 key（与 publicUrl 无关）
function r2KeyFromPath(p) {
  if (!p) return null;
  try { return new URL(p).pathname.replace(/^\/+/, ''); } catch (e) {}
  return null;
}
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

// Webhook raw body 必须在 express.json() 之前处理，否则 JSON 解析器会消费请求流
// 导致 Webhook 路由无法读取原始 body 而超时
app.use('/api/webhooks/customer-sync', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = (req.body || '').toString('utf8');
  try {
    req.body = req.rawBody ? JSON.parse(req.rawBody) : {};
  } catch (err) {
    console.warn('[Webhook] JSON 解析失败:', err.message);
    req.body = {};
  }
  next();
});

app.use(express.json());

function sendNoCacheHtml(res, fileName) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, fileName));
}

// 前端路由：所有带 hash 的请求返回首页
// 直接返回 index.html 并带 no-store 头（禁止缓存）。
// 注意：不要在此做版本化 302 重定向——曾导致飞书 webview 无限重载死循环。
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
    breakGlassEnabled: BREAKGLASS_ENABLED,
    timestamp: new Date().toISOString()
  });
});

// ==================== 会话与认证配置（AUTH-SECURITY-FIX-01-L1）====================
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_MAX_AGE_MS = parseInt(process.env.SESSION_MAX_AGE_MS || '', 10) || 24 * 60 * 60 * 1000;
const BREAKGLASS_ENABLED = process.env.BREAKGLASS_ENABLED === 'true';
const BREAKGLASS_PASSWORD_HASH = process.env.BREAKGLASS_PASSWORD_HASH || '';

// 生产环境硬性要求 SESSION_SECRET；缺失则拒绝启动（绝不生成临时 secret）
if (NODE_ENV === 'production' && !SESSION_SECRET) {
  console.error('[FATAL] 生产环境缺少 SESSION_SECRET，拒绝启动。');
  process.exit(1);
}
// break-glass 开启但 hash 缺失/格式错误 → 生产拒绝启动；非生产仅告警
if (BREAKGLASS_ENABLED) {
  const hashOk = BREAKGLASS_PASSWORD_HASH && /^\$2[aby]\$[0-9]{2}\$/.test(BREAKGLASS_PASSWORD_HASH);
  if (!hashOk) {
    if (NODE_ENV === 'production') {
      console.error('[FATAL] BREAKGLASS_ENABLED=true 但 BREAKGLASS_PASSWORD_HASH 缺失或格式错误，生产环境拒绝启动。');
      process.exit(1);
    }
    console.warn('[WARN] BREAKGLASS_ENABLED=true 但 BREAKGLASS_PASSWORD_HASH 缺失/格式错误：break-glass 将不可用。');
  }
}

// Render 位于反向代理之后：在 session 中间件之前正确配置 trust proxy。
// 仅信任单级代理（Render 实际层级），不允许客户端伪造 IP 的宽松配置。
// 注意：express 的 trust proxy 不接受字符串型数字（'1' 会被忽略导致 XFF 不生效），
// 因此数值型配置需转换为 Number。
const TRUST_PROXY_RAW = process.env.TRUST_PROXY || '1';
const TRUST_PROXY = /^\d+$/.test(TRUST_PROXY_RAW) ? parseInt(TRUST_PROXY_RAW, 10) : TRUST_PROXY_RAW;
app.set('trust proxy', TRUST_PROXY);

// ---- Session 存储（connect-pg-simple，标准 session 表）----
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');

let sessionStore = null;
const _pool = getPool();
if (_pool) {
  sessionStore = new PgSession({
    pool: _pool,
    tableName: 'session',
    createTableIfMissing: false, // 正式表只由批准后迁移创建；不自动建表
    disableTouch: true,          // 关闭 touch 续期，固定绝对过期
    pruneSessionInterval: 60 * 60,
  });
  sessionStore.on('error', (err) => console.error('[SessionStore] 错误:', err.message));
}

const sessionMiddleware = session({
  name: 'aftersales.sid',
  secret: SESSION_SECRET || 'dev-only-insecure-placeholder', // 生产已在上文拒绝启动
  store: sessionStore || undefined,
  resave: false,
  saveUninitialized: false,
  rolling: false,                 // 固定绝对过期，不续期
  cookie: {
    httpOnly: true,
    secure: NODE_ENV === 'production', // 仅生产 Secure；本地 HTTP 开发允许 false
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  },
});

// 在全部 API 路由之前注册 express-session（含 OAuth callback，以便建立 Session）
app.use('/api', sessionMiddleware);

// ==================== API 默认拒绝 + 精确白名单 ====================
// 白名单按 "HTTP 方法 + 精确路径" 匹配；只跳过 requireLogin，不跳过 express-session。
const PUBLIC_WHITELIST = [
  { method: 'GET',  path: '/api/version' },
  { method: 'GET',  path: '/api/auth/feishu/login' },
  { method: 'GET',  path: '/api/auth/feishu/callback' },
  { method: 'GET',  path: '/api/auth/feishu/status' },
  { method: 'POST', path: '/api/webhooks/customer-sync' }, // 仍需通过签名校验
  { method: 'POST', path: '/api/auth/break-glass' },       // 独立认证入口：关闭时由路由返回 404，开启时走限流 + 密码校验
];

function apiPath(req) {
  return (req.originalUrl || '/').split('?')[0];
}

function isPublicRoute(req) {
  const p = apiPath(req);
  // break-glass 始终作为独立认证入口（无需已有 Session）；关闭时由路由本身返回 404。
  // 仅精确匹配 PUBLIC_WHITELIST 中的 "方法 + 路径"，不会放行其他 /api/auth/* 路径。
  return PUBLIC_WHITELIST.some(r => r.method === req.method && r.path === p);
}

// CSRF 豁免：签名 Webhook 与 break-glass 登录（二者各有独立校验）
const CSRF_EXEMPT = new Set(['/api/webhooks/customer-sync', '/api/auth/break-glass']);

function safeEqual(a, b) {
  try {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (e) {
    return false;
  }
}

// 统一默认拒绝：非白名单 /api/* 必须有效服务端 Session
app.use('/api', (req, res, next) => {
  if (isPublicRoute(req)) return next();
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: '未登录' });
  }
  next();
});

// 统一 CSRF 检查：写请求默认要求，豁免项除外（使用 crypto.timingSafeEqual）
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const p = apiPath(req);
  if (CSRF_EXEMPT.has(p)) return next();
  if (!req.session || !req.session.userId) return res.status(401).json({ error: '未登录' });
  const token = req.headers['x-csrf-token'] || (req.body && req.body._csrf);
  const expected = req.session.csrfToken;
  if (!token || !expected || !safeEqual(token, expected)) {
    return res.status(403).json({ error: 'CSRF 校验失败', code: 'CSRF_INVALID' });
  }
  next();
});

// 每次受保护请求从数据库重新加载用户状态/角色/权限（X-User-* 在任何环境完全忽略）
async function loadCurrentUser(userId) {
  try {
    const u = await query('SELECT id, username, name, role_id, status FROM users WHERE id = $1', [userId]);
    if (u.rows.length === 0) return null;
    const user = u.rows[0];
    if (user.status !== 'active') return null; // 停用立即失效
    const roleR = await query('SELECT permissions FROM roles WHERE id = $1', [user.role_id]);
    const permissions = roleR.rows[0] ? (roleR.rows[0].permissions || []) : [];
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      roleId: user.role_id,
      status: user.status,
      permissions,
    };
  } catch (e) {
    console.error('[Auth] 加载用户失败:', e.message);
    return null; // store/db 异常 → 失败关闭
  }
}

// 受保护请求挂载当前用户（供后续 requireLogin / requireApiPermission 使用）
app.use('/api', async (req, res, next) => {
  if (isPublicRoute(req)) return next();
  try {
    const user = await loadCurrentUser(req.session.userId);
    if (!user) {
      return res.status(401).json({ error: '会话无效或用户已停用' });
    }
    req.currentUser = user;
    req.currentUserId = user.id;
    req.currentUserRole = user.roleId;
    req.currentUserPermissions = user.permissions;
    next();
  } catch (e) {
    return res.status(401).json({ error: '会话无效' });
  }
});

// ---- 旧版请求头鉴权已移除：X-User-Id / X-User-Role / X-User-Permissions 在所有环境完全忽略 ----

// 权限校验中间件工厂函数（基于服务端会话用户）
function requireApiPermission(...perms) {
  return (req, res, next) => {
    if (!req.currentUserId) {
      return res.status(401).json({ error: '未登录' });
    }
    const hasPerm = perms.some(p => (req.currentUserPermissions || []).includes(p));
    if (!hasPerm) {
      return res.status(403).json({ error: '没有该操作的权限', code: 'PERMISSION_DENIED' });
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

// ==================== 妙搭 Webhook 客户同步 ====================
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

/**
 * HMAC-SHA256 签名校验中间件
 * 读取 X-Webhook-Signature 和 X-Webhook-Timestamp 头，
 * 用 WEBHOOK_SECRET 对 timestamp + "." + rawBody 计算 HMAC，
 * 与请求头中的签名比对。
 *
 * 妙搭签名算法: HMAC-SHA256(timestamp + "." + body, secret)
 */
function verifyWebhookSignature(req, res, next) {
  if (!WEBHOOK_SECRET) {
    console.warn('[Webhook] WEBHOOK_SECRET 未配置，跳过签名校验（仅限开发环境）');
    return next();
  }

  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];

  if (!signature || !timestamp) {
    console.warn('[Webhook] 缺少签名头 X-Webhook-Signature 或 X-Webhook-Timestamp');
    return res.status(401).json({ error: '缺少签名验证头' });
  }

  // 防重放：timestamp 超过 5 分钟则拒绝
  // 支持 Unix 秒 / 毫秒；秒级时间戳 < 1e12，毫秒级 > 1e12
  let ts = Number(timestamp);
  if (isNaN(ts)) {
    console.warn('[Webhook] Timestamp 无效:', timestamp);
    return res.status(401).json({ error: 'Timestamp 无效' });
  }
  if (ts > 1000000000000) {
    ts = ts / 1000; // 毫秒转秒
  }
  if (Math.abs(Date.now() / 1000 - ts) > 300) {
    console.warn('[Webhook] Timestamp 超时或无效:', timestamp);
    return res.status(401).json({ error: 'Timestamp 超时或无效' });
  }

  // 计算 HMAC: HMAC-SHA256(secret, timestamp + "." + rawBody)
  const rawBody = req.rawBody || '';
  const signPayload = timestamp + '.' + rawBody;
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(signPayload)
    .digest('hex');

  // 妙搭签名值格式为 "sha256=<hex>"，提取 hex 部分比对
  // 同时兼容纯 hex 格式（调试场景）
  let receivedSig = signature;
  if (receivedSig.startsWith('sha256=')) {
    receivedSig = receivedSig.slice(7);
  }

  if (receivedSig !== expected) {
    console.warn('[Webhook] 签名不匹配: received=%s (stripped=%s) expected=%s', signature, receivedSig, expected);
    console.warn('[Webhook] 签名 payload (前 2KB):', signPayload.slice(0, 2048));
    console.warn('[Webhook] 请求方法=%s, 路径=%s, 时间戳头=%s', req.method, req.path, timestamp);
    console.warn('[Webhook] 请求头:', JSON.stringify(req.headers, null, 2));
    console.warn('[Webhook] 原始 Body (前 2KB):', (req.rawBody || '').slice(0, 2048));
    return res.status(401).json({
      error: '签名校验失败',
      debug: {
        received_signature: signature,
        received_signature_stripped: receivedSig,
        expected_signature: expected,
        sign_payload_preview: signPayload.slice(0, 500),
        timestamp_header: timestamp,
        raw_body_length: (req.rawBody || '').length,
        raw_body_preview: (req.rawBody || '').slice(0, 500)
      }
    });
  }

  console.log('[Webhook] 签名校验通过');
  next();
}

app.post('/api/webhooks/customer-sync', verifyWebhookSignature, async (req, res) => {
  try {
    const { event, timestamp, source, data } = req.body;

    console.log('[Webhook] 收到妙搭推送: event=%s, source=%s, headers=%o', event, source, {
      'x-webhook-signature': req.headers['x-webhook-signature'],
      'x-webhook-timestamp': req.headers['x-webhook-timestamp']
    });

    if (!data || !data.id) {
      console.warn('[Webhook] 请求缺少 data.id');
      return res.status(400).json({ error: '缺少 data.id 字段' });
    }

    const validEvents = ['customer.created', 'customer.updated'];
    if (!validEvents.includes(event)) {
      return res.status(400).json({ error: `不支持的 event 类型: ${event}` });
    }

    if (source !== 'miaoda-distribution') {
      return res.status(400).json({ error: `不支持的 source: ${source}` });
    }

    // 字段映射
    const externalId = data.id;
    const customerName = data.customerName || '';
    const contactPerson = data.contactPerson || '';
    const phone = data.phoneNumber || '';
    const email = data.email || '';
    const country = data.country || '';
    const address = data.address || '';
    const status = data.status === 'inactive' ? 'inactive' : (data.status || 'active');
    const lastSyncedAt = timestamp || new Date().toISOString();

    // 生成内部 ID（基于 external_customer_id 的确定性 ID）
    const internalId = 'cust_' + crypto.createHash('md5').update(externalId).digest('hex').substring(0, 12);

    // Upsert: ON CONFLICT(external_customer_id) DO UPDATE
    const result = await query(`
      INSERT INTO customers (
        id, external_customer_id, customer_name, contact_person,
        phone, email, country, address, status, source, last_synced_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (external_customer_id) DO UPDATE SET
        customer_name = EXCLUDED.customer_name,
        contact_person = EXCLUDED.contact_person,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        country = EXCLUDED.country,
        address = EXCLUDED.address,
        status = EXCLUDED.status,
        source = EXCLUDED.source,
        last_synced_at = EXCLUDED.last_synced_at,
        updated_at = NOW()
    `, [internalId, externalId, customerName, contactPerson, phone, email, country, address, status, source, lastSyncedAt]);

    const isInsert = result.rowCount === 1;
    console.log(`[Webhook] 客户同步成功: event=${event}, externalId=${externalId}, action=${isInsert ? 'insert' : 'update'}`);

    res.status(200).json({
      success: true,
      message: `客户同步成功 (${isInsert ? '新建' : '更新'})`,
      customer_id: internalId,
      external_customer_id: externalId,
      event
    });
  } catch (err) {
    console.error('[Webhook] 客户同步失败:', err.message);
    res.status(500).json({ error: '客户同步失败', detail: err.message });
  }
});

// ==================== 客户查询接口（妙搭同步验证用，无需登录）====================
app.get('/api/customers', async (req, res) => {
  try {
    const { status, source, search, limit = '50', offset = '0' } = req.query;
    const conditions = ['1=1'];
    const params = [];

    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (source) {
      params.push(source);
      conditions.push(`source = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(external_customer_id ILIKE $${params.length} OR customer_name ILIKE $${params.length} OR phone ILIKE $${params.length} OR email ILIKE $${params.length})`);
    }

    const countSql = `SELECT COUNT(*) as total FROM customers WHERE ${conditions.join(' AND ')}`;
    const dataSql = `
      SELECT id, external_customer_id, customer_name, contact_person, phone, email,
             country, address, status, source, last_synced_at, created_at, updated_at
      FROM customers
      WHERE ${conditions.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const [{ rows: countRows }, { rows: customers }] = await Promise.all([
      query(countSql, params),
      query(dataSql, [...params, parseInt(limit), parseInt(offset)])
    ]);

    res.status(200).json({
      success: true,
      total: parseInt(countRows[0].total),
      limit: parseInt(limit),
      offset: parseInt(offset),
      customers
    });
  } catch (err) {
    console.error('[Customers] 查询失败:', err.message);
    res.status(500).json({ error: '查询失败', detail: err.message });
  }
});

app.get('/api/customers/:externalId', async (req, res) => {
  try {
    const { externalId } = req.params;
    const { rows } = await query(`
      SELECT id, external_customer_id, customer_name, contact_person, phone, email,
             country, address, status, source, last_synced_at, created_at, updated_at
      FROM customers
      WHERE external_customer_id = $1
    `, [externalId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: '客户不存在' });
    }

    res.status(200).json({ success: true, customer: rows[0] });
  } catch (err) {
    console.error('[Customers] 查询失败:', err.message);
    res.status(500).json({ error: '查询失败', detail: err.message });
  }
});

// 无认证状态接口：仅返回客户统计与最后同步时间，用于快速验证
app.get('/api/webhooks/customer-sync/status', async (req, res) => {
  try {
    const { rows: countRows } = await query('SELECT COUNT(*) as total FROM customers');
    const { rows: lastSyncRows } = await query('SELECT MAX(last_synced_at) as last_synced_at FROM customers');
    const { rows: recentRows } = await query(`
      SELECT external_customer_id, customer_name, status, last_synced_at
      FROM customers ORDER BY last_synced_at DESC LIMIT 5
    `);

    res.status(200).json({
      success: true,
      webhook_url: `${APP_BASE_URL}/api/webhooks/customer-sync`,
      webhook_secret_configured: !!WEBHOOK_SECRET,
      webhook_secret_prefix: WEBHOOK_SECRET ? WEBHOOK_SECRET.slice(0, 8) + '***' : null,
      total_customers: parseInt(countRows[0].total),
      last_synced_at: lastSyncRows[0].last_synced_at || null,
      recent_customers: recentRows
    });
  } catch (err) {
    console.error('[Webhook] 状态查询失败:', err.message);
    res.status(500).json({ error: '状态查询失败', detail: err.message });
  }
});

// 诊断接口：不校验签名，返回请求头、raw body 和多种签名计算结果，用于联调
// 注意：不会泄露 secret 本身，仅返回前缀
app.post('/api/webhooks/customer-sync/debug', async (req, res) => {
  if (NODE_ENV === 'production') return res.status(404).json({ error: 'Not Found' });
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const rawBody = req.rawBody || '';

    const computeSignatures = (secret) => {
      if (!secret) return null;
      return {
        v1_dot: crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex'),
        v1_concat: crypto.createHmac('sha256', secret).update(timestamp + rawBody).digest('hex'),
        v1_base64_dot: crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('base64'),
        v1_base64_concat: crypto.createHmac('sha256', secret).update(timestamp + rawBody).digest('base64')
      };
    };

    const signatures = computeSignatures(WEBHOOK_SECRET);

    res.status(200).json({
      success: true,
      message: 'Webhook 诊断信息（未校验签名）',
      webhook_secret_configured: !!WEBHOOK_SECRET,
      webhook_secret_prefix: WEBHOOK_SECRET ? WEBHOOK_SECRET.slice(0, 8) + '***' : null,
      timestamp_header: timestamp,
      received_signature: signature,
      computed_signatures: signatures,
      raw_body_length: rawBody.length,
      raw_body_preview: rawBody.slice(0, 1000),
      parsed_body: req.body,
      headers: req.headers
    });
  } catch (err) {
    console.error('[Webhook] 诊断接口失败:', err.message);
    res.status(500).json({ error: '诊断接口失败', detail: err.message });
  }
});

// ==================== 附件上传 ====================
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// R2 启用时使用内存存储(文件缓冲在内存,随后上传到 R2); 否则用本地磁盘存储作为兜底
const storage = R2_ENABLED
  ? multer.memoryStorage()
  : multer.diskStorage({
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
// 本地兜底: 保留静态访问(兼容历史本地上传文件)
app.use('/uploads', express.static(UPLOAD_DIR));

// 将单个文件上传到 R2, 返回可公开访问的 URL
async function uploadToR2(file) {
  const ext = path.extname(file.originalname);
  const key = 'attachments/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext;
  await r2Client.send(new PutObjectCommand({
    Bucket: R2_CONFIG.bucket,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype || 'application/octet-stream',
    // 公开桶直链访问, 不需要签名
  }));
  return R2_CONFIG.publicUrl + '/' + key;
}

// ==================== 数据库 CRUD API ====================

// 初始化数据库
app.post('/api/db/init', async (req, res) => {
  if (NODE_ENV === 'production') return res.status(404).json({ error: 'Not Found' });
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

// 服务端权威校验：仅保留 id 存在且 users 表中 status='active' 的 CC 用户。
// 返回去重后的稳定 [{id, name}]；不存在/已停用用户一律剔除。失败安全返回 []。
async function sanitizeCcUsers(ccUsers) {
  if (!Array.isArray(ccUsers) || !ccUsers.length) return [];
  const ids = ccUsers.map(c => c && c.id).filter(Boolean);
  if (!ids.length) return [];
  try {
    const ur = await query(
      "SELECT id, name FROM users WHERE id = ANY($1::text[]) AND status = 'active'",
      [ids]
    );
    const nameMap = {};
    ur.rows.forEach(u => { nameMap[u.id] = u.name; });
    const seen = new Set();
    const out = [];
    for (const c of ccUsers) {
      if (!c || !c.id) continue;
      const id = String(c.id);
      if (seen.has(id)) continue;        // 按用户 ID 去重
      if (!(id in nameMap)) continue;     // 不存在或已停用 → 剔除（一.2/一.3）
      seen.add(id);
      out.push({ id, name: nameMap[id] || c.name }); // 稳定 {id,name}
    }
    return out;
  } catch (e) {
    console.error('[sanitizeCcUsers] error:', e.message);
    return [];
  }
}

// 读取审批流的 CC 抄送用户快照（[{id, name}]）。
// 严格按 users 表重新校验“存在且 active”，剔除停用/不存在用户；按 ID 去重；返回稳定 {id,name}。
// 历史 aftersales_records.cc_users 快照绝对不被此函数改写（只读读取审批流配置）。失败安全返回 []。
async function resolveFlowCcUsers(flowId) {
  if (!flowId) return [];
  try {
    const { rows } = await query('SELECT cc_users FROM approval_flows WHERE id = $1', [flowId]);
    if (!rows.length) return [];
    const raw = rows[0].cc_users;
    const list = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
    return sanitizeCcUsers(list);
  } catch (e) {
    console.error('[resolveFlowCcUsers] error:', e.message);
    return [];
  }
}

// ==================== 结束后抄送（最终审批通过触发）====================
// AFTERSALES-CC-COMPLETION-01：在最终审批通过后由服务端触发一次“结束节点抄送”完成通知。
// 幂等（原子 claim）：仅当 flag=true、cc_completion_claimed_at IS NULL、cc_completion_notified_at IS NULL 时
// 写 cc_completion_claimed_at=NOW()；并发/重复请求只有一个能获得 claim。飞书全部发送成功后才写
// cc_completion_notified_at=NOW()；发送失败保留 claimed_at、notified_at 仍为 NULL、不回滚审批、不重试。
async function triggerCompletionCc(recordId) {
  const claim = await query(
    `UPDATE aftersales_records
     SET cc_completion_claimed_at = NOW()
     WHERE id = $1
       AND cc_notify_on_completion = true
       AND cc_completion_claimed_at IS NULL
       AND cc_completion_notified_at IS NULL
     RETURNING id`,
    [recordId]
  );
  if (claim.rowCount === 0) return { triggered: false, reason: 'not_eligible_or_already_claimed_or_notified' };
  const notifyRes = await notifyCompletionCc(recordId);
  // 仅在飞书全部发送成功后才标记“已通知”；部分/全部失败则保留 claimed_at，notified_at 仍为 NULL，不重试。
  if (notifyRes && notifyRes.success) {
    await query(
      `UPDATE aftersales_records SET cc_completion_notified_at = NOW() WHERE id = $1`,
      [recordId]
    );
  }
  return notifyRes || { success: false, triggered: true };
}

// 结束后抄送：读取记录提交时冻结的 cc_users 快照，按 user_id 去重后发送“审批完成”结果通知。
// 与提交时抄送不同：审批人若也在 CC 名单中仍须收到一次最终结果通知（规则 10），故不与审批人去重。
// 飞书未配置时使用 Mock 记录收件人；发送失败仅记录（不含 Secret），不回滚审批业务。
async function notifyCompletionCc(recordId) {
  try {
    if (!recordId) return { success: false, error: 'missing_recordId' };
    const { rows } = await query('SELECT * FROM aftersales_records WHERE id = $1', [recordId]);
    if (!rows.length) return { success: false, error: 'record_not_found' };
    const rec = rows[0];
    const ccUsers = typeof rec.cc_users === 'string' ? JSON.parse(rec.cc_users || '[]') : (rec.cc_users || []);
    if (!Array.isArray(ccUsers) || !ccUsers.length) return { success: true, skipped: true, reason: 'no_cc' };

    // 结束节点 CC 名单内部按 user_id 去重（规则 10）
    const seen = new Set();
    const targets = [];
    for (const c of ccUsers) {
      const id = String(c && c.id);
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      targets.push(c);
    }
    if (!targets.length) return { success: true, skipped: true, reason: 'no_cc' };

    const ids = targets.map(c => c.id);
    const ur = await query(
      'SELECT id, name, feishu_open_id, feishu_user_id, feishu_union_id, status FROM users WHERE id = ANY($1::text[])',
      [ids]
    );
    const userMap = {};
    ur.rows.forEach(u => { userMap[u.id] = u; });

    const recordDisplayId = `AS${String(recordId).padStart(4, '0')}`;
    const detailUrl = `${APP_BASE_URL}/#page=detail&id=${recordId}`;
    const items = typeof rec.items === 'string' ? JSON.parse(rec.items || '[]') : (rec.items || []);

    if (!feishuConfigured) {
      const sent = [], skipped = [];
      for (const c of targets) {
        const u = userMap[c.id];
        if (!u || u.status !== 'active') { skipped.push(c.name + '(停用/不存在)'); continue; }
        sent.push(c.name);
      }
      console.log('[Mock][CompletionCC] 审批完成抄送通知:', { recordDisplayId, sent, dedupSkipped: skipped });
      return { success: true, mock: true, sent, skipped };
    }

    const tokenResult = await getTenantAccessToken();
    if (tokenResult.error) {
      console.error('[CompletionCC] 获取飞书 token 失败(不影响审批):', tokenResult.error);
      return { success: false, error: tokenResult.error };
    }
    const results = { success: [], failed: [] };
    for (const c of targets) {
      const u = userMap[c.id];
      if (!u || u.status !== 'active') {
        results.failed.push({ name: c.name, reason: 'CC 用户不存在或已停用', code: 'CC_INACTIVE' });
        continue;
      }
      const receiver = getFeishuReceiver(u);
      if (!receiver) {
        results.failed.push({ name: u.name, reason: 'CC 未绑定飞书账号', code: 'CC_NOT_BOUND' });
        continue;
      }
      const card = buildCompletionCard({
        recordDisplayId,
        submitterName: rec.submitter_name,
        aftersalesDate: rec.aftersales_date,
        items,
        brands: rec.brand,
        platforms: rec.platforms,
        detailUrl
      });
      const sendResult = await sendFeishuInteractiveMessage({
        token: tokenResult.token,
        receiver,
        card,
        recipientName: u.name,
        context: { type: 'completion_cc', recordId }
      });
      if (sendResult.success) results.success.push({ name: u.name });
      else results.failed.push({ name: u.name, reason: sendResult.reason, code: sendResult.code });
    }
    return { success: results.failed.length === 0, results, mock: false };
  } catch (e) {
    console.error('[CompletionCC] 通知异常(不影响审批):', e.message);
    return { success: false, error: e.message };
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

// ==================== CC 抄送（只读视图 + 飞书通知）====================
// 抄送给我的：当前登录用户作为 CC 的售后记录（只读，不影响审批层级/状态/权限）
app.get('/api/records/cc', requireLogin, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM aftersales_records WHERE cc_users @> $1::jsonb ORDER BY created_at DESC',
      [JSON.stringify([{ id: req.currentUserId }])]
    );
    const list = rows.map(r => ({
      ...r,
      items: typeof r.items === 'string' ? JSON.parse(r.items || '[]') : (r.items || []),
      approval_history: typeof r.approval_history === 'string' ? JSON.parse(r.approval_history || '[]') : (r.approval_history || []),
      cc_users: typeof r.cc_users === 'string' ? JSON.parse(r.cc_users || '[]') : (r.cc_users || [])
    }));
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AFTERSALES-CC-COMPLETION-01-R1：旧的“提交即抄送/手动重发”入口（POST /api/notify/cc + notifyCcUsers）
// 已删除。完成抄送仅由服务端终审状态转换（triggerCompletionCc）触发，浏览器不得经额外请求触发。

// ===================== 售后 ID 生成（RMA-YYYYMMDD-NNNN）=====================
// 业务时区：所有售后 ID 的日期部分按 Asia/Jakarta（UTC+7）计算。
// 不依赖服务器默认时区、PostgreSQL session 时区、用户浏览器时区，也不直接截取 UTC 日期。
const BUSINESS_TIMEZONE = 'Asia/Jakarta';

// 固定命名空间基址，用于生成 pg_advisory_xact_lock 的锁键，避免与其他 advisory lock 冲突。
// int8 范围约 ±9.2e18；8.1e15 + 8位日期(≤1e8) 远在其内，且不同日期得到不同锁键。
const RMA_LOCK_NAMESPACE = 8100000000000000n;

// 返回 Asia/Jakarta 业务日期 YYYYMMDD（与服务器/浏览器/PG session 时区无关）。
function getBusinessDateString() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

// 在事务内生成下一个 RMA 编号（并发安全）。
// 做法：按“固定命名空间 + 业务日期”获取事务级 advisory lock，锁内取当天最大四位流水号 +1，
// 同一事务提交后自动释放锁；aftersales_records.id 的主键唯一约束作为最终兜底。
// 注意：使用 MAX(数字后缀)+1，而非 COUNT(*)+1——删除记录后 COUNT 会回退导致复用旧号，不符合“已用编号不可复用”。
async function generateNextRmaId(client) {
  const datePart = getBusinessDateString();
  const lockKey = Number(RMA_LOCK_NAMESPACE + BigInt(datePart));
  await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

  // 取当天最大四位流水号：按整数 MAX，避免字典序误比较（'0009' 字典序 > '0010'）。
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 'RMA-' || $1 || '-(\\d+)$') AS INTEGER)), 0) AS maxseq
       FROM aftersales_records
       WHERE id LIKE 'RMA-' || $1 || '-%'`,
    [datePart]
  );
  const maxSeq = parseInt(rows[0].maxseq, 10) || 0;
  const nextSeq = maxSeq + 1;
  if (nextSeq > 9999) {
    throw new Error('当日售后单数量已超过 9999，无法生成 RMA 编号（请联系管理员）');
  }
  return `RMA-${datePart}-${String(nextSeq).padStart(4, '0')}`;
}

// 仅允许合法临时 ID：tmp_<标准UUID>
function isValidTempId(s) {
  return typeof s === 'string' && /^tmp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
// 附件上传 record_id 校验：允许 tmp_<UUID> 或 RMA-YYYYMMDD-NNNN
function isValidRecordIdForUpload(s) {
  return isValidTempId(s) || /^RMA-\d{8}-\d{4}$/.test(s || '');
}

// 在单个事务内创建记录并（可选）将临时 UUID 下的附件迁移到正式 RMA ID。
// temp_record_id 必须为合法 tmp_<UUID>；否则整体拒绝（400），不创建记录、不迁移附件。
async function createRecordTx(client, { columns, values, temp_record_id }) {
  if (temp_record_id && !isValidTempId(temp_record_id)) {
    const e = new Error('temp_record_id 格式不合法（必须为 tmp_<UUID>）');
    e.status = 400;
    throw e;
  }
  await client.query('BEGIN');
  try {
    const newId = await generateNextRmaId(client);
    const cols = ['id', ...columns];
    const vals = [newId, ...values];
    const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
    const result = await client.query(
      `INSERT INTO aftersales_records (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      vals
    );
    let migrated = 0;
    if (temp_record_id) {
      // 仅按完整临时 UUID 精确匹配，不使用 LIKE/前缀/模糊匹配
      const r = await client.query(
        'UPDATE attachments SET record_id = $1 WHERE record_id = $2',
        [newId, temp_record_id]
      );
      migrated = r.rowCount || 0;
    }
    await client.query('COMMIT');
    return { record: result.rows[0], migrated };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

app.post('/api/records', requireApiPermission('record_create'), async (req, res) => {
  const client = await getPool().connect();
  try {
    // 忽略客户端传入的 id：最终主键由服务端统一生成（RMA-YYYYMMDD-NNNN），客户端不得决定编号。
    // temp_record_id 可选：客户端在“先上传附件后保存记录”场景下使用的临时 UUID；
    // 仅当其为合法 tmp_<UUID> 时，服务端才会把该临时 ID 下的附件迁移到正式 RMA ID（同一事务内）。
    const { submitter_id, submitter_name, aftersales_date, status, brand, model, category, platforms, items,
      total_quantity, current_approval_level,
      approval_flow_id,
      approver_level1_id, approver_level1_name, approver_level2_id, approver_level2_name,
      approver_level3_id, approver_level3_name, approval_history, tracking_number, temp_record_id } = req.body;

    if (!getPool()) return res.status(500).json({ error: '数据库未配置' });

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

    // 在同一事务内创建记录并（可选）迁移临时 UUID 下的附件。
    // temp_record_id 不合法时 createRecordTx 直接抛出 400，记录与附件均不会写入。
    // CC 快照：仅当提交（非草稿）且指定审批流时，按当前审批流配置快照 CC 用户
    const isDraft = (status || 'draft') === 'draft';
    const flowCcUsers = (!isDraft && approval_flow_id) ? await resolveFlowCcUsers(approval_flow_id) : [];
    // AFTERSALES-CC-COMPLETION-01：新逻辑下“提交（非草稿）且指定审批流”即启用结束后抄送；
    // 草稿或无需审批的流程不启用。提交时不再发送 CC（改由最终审批通过后由服务端触发）。
    const ccNotifyOnCompletion = (!isDraft && approval_flow_id) ? true : false;
    const columns = ['submitter_id','submitter_name','aftersales_date','status','brand','model','category','platforms','items','total_quantity','current_approval_level','approval_flow_id','approval_flow_name','approver_level1_id','approver_level1_name','approver_level2_id','approver_level2_name','approver_level3_id','approver_level3_name','approval_history','tracking_number','cc_users','cc_notify_on_completion'];
    const values = [submitter_id, submitter_name, aftersales_date, status || 'draft', brand || '', model || '', category || '', platforms || '', JSON.stringify(items || []), total_quantity || 0, current_approval_level || 0, approval_flow_id || '', flowName, flowLevel1Id || '', flowLevel1Name || '', flowLevel2Id || '', flowLevel2Name || '', flowLevel3Id || '', flowLevel3Name || '', JSON.stringify(approval_history || []), tracking_number || '', JSON.stringify(flowCcUsers), ccNotifyOnCompletion];
    const { record, migrated } = await createRecordTx(client, { columns, values, temp_record_id });
    // 注意：提交时不再触发 CC 通知（AFTERSALES-CC-COMPLETION-01）。结束后抄送由最终审批接口触发。
    res.json({ ...record, migrated });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    const status = e && e.status ? e.status : 500;
    res.status(status).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.put('/api/records/:id', requireApiPermission('record_edit'), async (req, res) => {
  try {
    const { submitter_name, aftersales_date, status, brand, model, category, platforms, items,
      total_quantity, current_approval_level,
      approval_flow_id,
      approver_level1_id, approver_level1_name, approver_level2_id, approver_level2_name,
      approver_level3_id, approver_level3_name,
      approval_level1_status, approval_level2_status, approval_history, tracking_number } = req.body;

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
    add('tracking_number', tracking_number);

    // 读取旧记录状态，用于判定是否为「草稿首次提交」过渡
    const oldRes = await query('SELECT status FROM aftersales_records WHERE id = $1', [req.params.id]);
    const oldStatus = oldRes.rows[0] ? oldRes.rows[0].status : null;

    // CC 快照冻结规则（二.1/二.2）：
    // 仅当「旧状态为 draft 且本次提交为非 draft」时生成快照；
    // 已提交记录的后续 PUT / 审批 / 状态更新绝不重新解析审批流或覆盖 cc_users。
    // 历史 aftersales_records.cc_users 快照绝不被改写。
    let ccSnapshotTaken = false;
    if (approval_flow_id && oldStatus === 'draft' && status && status !== 'draft') {
      const flowCc = await resolveFlowCcUsers(approval_flow_id);
      add('cc_users', JSON.stringify(flowCc));
      add('cc_notify_on_completion', true); // AFTERSALES-CC-COMPLETION-01：草稿→提交即启用结束后抄送
      ccSnapshotTaken = true;
    }

    values.push(req.params.id);
    const result = await query(
      `UPDATE aftersales_records SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: '记录不存在' });
    const updated = result.rows[0];
    // 注意：提交时不再触发 CC 通知（AFTERSALES-CC-COMPLETION-01）。结束后抄送由最终审批接口触发。
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== 专用审批接口（修复 413：不再 PUT 整条 Record）====================
// 审批请求仅允许携带最小字段：action / comment / return_date / approval_attachments(引用) / expected_level。
// 服务端自行读取记录、校验审批人、推进状态、更新 approval_history，避免客户端上传整条记录（含 base64 附件）导致 413。
// 以下转移逻辑与前端 executeApproval 原样一致，仅作位置迁移，不改变任何审批业务规则。
const APPROVAL_LEGACY_STATUS_TO_PROCESS = {
  '待ERP入库': { type: 'erp', progress: 'pending' }, 'pending_erp': { type: 'erp', progress: 'pending' },
  'ERP入库': { type: 'erp', progress: 'pending' }, 'erp': { type: 'erp', progress: 'pending' },
  '待换彩盒': { type: 'color_box', progress: 'pending' }, 'pending_color_box': { type: 'color_box', progress: 'pending' },
  '换彩盒': { type: 'color_box', progress: 'pending' }, 'color_box': { type: 'color_box', progress: 'pending' },
  '待补配件': { type: 'parts', progress: 'pending' }, 'pending_parts': { type: 'parts', progress: 'pending' },
  '补配件': { type: 'parts', progress: 'pending' }, 'parts': { type: 'parts', progress: 'pending' },
  '待RMA': { type: 'rma', progress: 'pending' }, 'pending_rma': { type: 'rma', progress: 'pending' },
  'RMA': { type: 'rma', progress: 'pending' }, 'rma': { type: 'rma', progress: 'pending' },
  '待报废': { type: 'scrap', progress: 'pending' }, 'pending_scrap': { type: 'scrap', progress: 'pending' },
  '报废': { type: 'scrap', progress: 'pending' }, 'scrap': { type: 'scrap', progress: 'pending' },
  '已处理': { type: 'erp', progress: 'completed' }, 'completed': { type: 'erp', progress: 'completed' },
  '处理中': { type: 'erp', progress: 'processing' }, 'processing': { type: 'erp', progress: 'processing' },
  '待处理': { type: 'erp', progress: 'pending' }, 'pending': { type: 'erp', progress: 'pending' }
};
const APPROVAL_PROCESS_TYPE_TO_LEGACY_PENDING = {
  erp: '待ERP入库', color_box: '待换彩盒', parts: '待补配件', rma: '待RMA', scrap: '待报废'
};
const APPROVAL_RETURN_REASON_TO_PROCESS_TYPE = {
  '可二次销售': 'erp', '彩盒损坏': 'color_box', '配件缺失': 'parts', '硬件故障': 'rma', '报废': 'scrap',
  '人为损坏': 'erp', '其他': 'erp', '功能异常': 'erp'
};
const APPROVAL_LEVEL_NAMES = { 1: '一级', 2: '二级', 3: '三级' };
// 专用审批接口：层级 -> 所需权限（不再使用 record_edit 作为前置权限）
const APPROVAL_LEVEL_PERM = { 1: 'approval_level1', 2: 'approval_level2', 3: 'approval_level3' };

function approvalNormalizeProcessItem(item) {
  if (!item) return item;
  const legacy = item.process_status || item.processStatus || '';
  const mapped = APPROVAL_LEGACY_STATUS_TO_PROCESS[legacy] || {};
  if (!item.process_type) item.process_type = (legacy === '已处理' || legacy === 'completed' ? APPROVAL_RETURN_REASON_TO_PROCESS_TYPE[item.return_reason] : mapped.type) || APPROVAL_RETURN_REASON_TO_PROCESS_TYPE[item.return_reason] || 'erp';
  if (!item.process_progress) item.process_progress = mapped.progress || 'pending';
  if (item.process_progress === 'completed' && !item.process_completed_date) {
    item.process_completed_date = item.process_status_updated_at || item.process_status_date || new Date().toISOString();
  }
  item.process_status = item.process_progress === 'completed' ? '已处理' : (APPROVAL_PROCESS_TYPE_TO_LEGACY_PENDING[item.process_type] || '待ERP入库');
  return item;
}
function approvalItemProcessProgress(item) { approvalNormalizeProcessItem(item); return item.process_progress || 'pending'; }
function approvalFindNextApprovalLevel(record, level) {
  for (let l = level + 1; l <= 3; l++) {
    if (record['approver_level' + l + '_id']) return l;
  }
  return 0;
}
function approvalGetLevelStatusText(level) { return '待' + APPROVAL_LEVEL_NAMES[level] + '审批'; }

// 纯函数：在内存 record 上推进审批。返回 { record, itemsChanged } 或 { error, code }。不改变业务规则。
// itemsChanged 仅在「终审通过且确有可二次销售明细被置为已处理」时为 true，用于服务端决定是否需要重写 items 列。
function applyApprovalTransition(record, payload, operatorId) {
  const level = record.current_approval_level;
  if (level <= 0) return { error: '该记录当前无需审批或已被处理' };
  const approverIdField = 'approver_level' + level + '_id';
  if (record[approverIdField] !== operatorId) {
    return { error: '当前用户不是该层级审批人', code: 'FORBIDDEN_APPROVER' };
  }
  if (payload.expected_level !== undefined && Number(payload.expected_level) !== Number(level)) {
    return { error: '审批层级已变更，请刷新后重试', code: 'STALE_LEVEL' };
  }
  const now = new Date().toISOString();
  const history = Array.isArray(record.approval_history) ? record.approval_history : [];
  history.push({
    level, action: payload.action,
    operator_id: operatorId, operator_name: payload.operator_name || operatorId,
    comment: payload.comment || '', return_date: payload.return_date || null,
    attachments: Array.isArray(payload.approval_attachments) ? payload.approval_attachments : [],
    timestamp: now
  });
  record.approval_history = history;
  let itemsChanged = false;
  if (payload.action === 'reject') {
    record.status = '审批拒绝';
    record.current_approval_level = 0;
  } else {
    const nextLevel = approvalFindNextApprovalLevel(record, level);
    if (nextLevel > 0) {
      record.status = approvalGetLevelStatusText(nextLevel);
      record.current_approval_level = nextLevel;
    } else {
      record.status = '审批通过';
      record.current_approval_level = 0;
      const autoCompleteDate = payload.return_date || now;
      (record.items || []).forEach((item) => {
        approvalNormalizeProcessItem(item);
        const rawType = (item.process_type || '').toString();
        const rawReason = (item.return_reason || '').toString();
        const isResellable =
          rawType.toLowerCase() === 'erp'
          || rawType === 'ERP入库'
          || rawReason === '可二次销售'
          || rawReason.toLowerCase() === 'resellable';
        if (isResellable && approvalItemProcessProgress(item) !== 'completed') {
          item.process_progress = 'completed';
          item.process_status = '已处理';
          item.process_completed_date = autoCompleteDate;
          item.process_status_updated_at = now;
          if (payload.return_date) { item.return_stockin_date = payload.return_date; }
          itemsChanged = true;
        }
      });
    }
  }
  record.updated_at = now;
  return { record, itemsChanged };
}

// 专用审批接口（修复 413：不再 PUT 整条 Record）
// 设计要点：
//  1) 不再以 record_edit 作为前置权限；服务端读取记录与 current_approval_level 后，派生所需权限
//     (approval_level1/2/3) 并校验审批人身份。超级管理员因 role_admin 拥有全部权限自然通过，
//     但本接口不新增任何「管理员绕过审批人」的分支，完全沿用既有已冻结规则。
//  2) 服务端为审批状态唯一权威：仅接收 action/comment/return_date/approval_attachments(引用)/expected_level，
//     状态推进、下一层/终审判断、approval_history 构造全部在服务端完成。
//  3) 事务 + 行锁 (SELECT ... FOR UPDATE)：并发审批与处理状态更新被串行化，避免旧值覆盖。
//  4) items 仅在「终审通过且确有可二次销售明细被置为已处理」时重写，其余阶段保持数据库当前值不变。
//  5) expected_level 作为乐观并发令牌：重复/过期请求因层级不匹配返回 409，不会产生第二条 approval_history。
app.post('/api/records/:id/approval', async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: '数据库未配置' });

  let client = null;
  let committed = false;
  try {
    client = await pool.connect();
    if (!req.currentUserId) { client.release(); return res.status(401).json({ error: '未登录' }); }
    const { action, comment, return_date, approval_attachments, expected_level, erp_screenshots } = req.body;
    if (action !== 'approve' && action !== 'reject') {
      client.release(); return res.status(400).json({ error: '无效的审批动作' });
    }
    if (expected_level === undefined || expected_level === null || expected_level === '') {
      client.release(); return res.status(400).json({ error: '缺少 expected_level，无法保证审批幂等' });
    }

    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM aftersales_records WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK'); client.release();
      return res.status(404).json({ error: '记录不存在' });
    }
    const row = result.rows[0];
    const record = {
      ...row,
      items: typeof row.items === 'string' ? JSON.parse(row.items || '[]') : (row.items || []),
      approval_history: typeof row.approval_history === 'string' ? JSON.parse(row.approval_history || '[]') : (row.approval_history || [])
    };
    const prevStatus = record.status; // 终审判定基线（AFTERSALES-CC-COMPLETION-01：用于识别首次进入“审批通过”）

    // 派生当前层级所需权限并校验审批人身份（不使用 record_edit 前置权限）
    const level = record.current_approval_level;
    if (!(level >= 1 && level <= 3)) {
      await client.query('ROLLBACK'); client.release();
      return res.status(400).json({ error: '该记录当前无需审批或已被处理' });
    }
    const requiredPerm = APPROVAL_LEVEL_PERM[level];
    const hasPerm = (req.currentUserPermissions || []).includes(requiredPerm);
    const isApprover = record['approver_level' + level + '_id'] === req.currentUserId;
    if (!hasPerm || !isApprover) {
      // 与既有 requireApiPermission 一致：超级管理员因拥有全部权限自然通过；此处不新增任何管理员绕过分支。
      await client.query('ROLLBACK'); client.release();
      return res.status(403).json({ error: '无权限或非本层级审批人，无法审批', code: 'PERMISSION_DENIED' });
    }

    // 审批人姓名：绝不信任 X-User-Role（其为 role_id，会写成 role_admin）。
    // 在事务内用 currentUserId 反查 users 表，取 name → username → currentUserId（永不回退 role id）。
    // 查询失败按现有事务异常流程抛出并回滚（见下方外層 catch），不吞错、不继续审批。
    let operatorName = req.currentUserId;
    const uRes = await client.query(
      `SELECT
         COALESCE(
           NULLIF(TRIM(name), ''),
           NULLIF(TRIM(username), ''),
           $1
         ) AS operator_name
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [req.currentUserId]
    );
    if (uRes.rows.length > 0 && uRes.rows[0].operator_name) {
      operatorName = uRes.rows[0].operator_name;
    } else {
      console.warn('[Approval] 审批用户未在 users 表中找到，历史记录将回退为 user_id:', req.currentUserId);
    }

    const applied = applyApprovalTransition(
      record,
      { action, comment, return_date, approval_attachments, expected_level, operator_name: operatorName },
      req.currentUserId
    );
    if (applied.error) {
      await client.query('ROLLBACK'); client.release();
      const status = applied.code === 'STALE_LEVEL' ? 409 : (applied.code === 'FORBIDDEN_APPROVER' ? 403 : 400);
      return res.status(status).json({ error: applied.error });
    }

    // ERP 截图引用：仅由服务端基于数据库当前 items 追加写入正确位置
    // （不接收客户端 items，不覆盖并发处理状态；仅追加合法的引用 URL）。
    let erpMerged = false;
    if (erp_screenshots && typeof erp_screenshots === 'object' && !Array.isArray(erp_screenshots)) {
      for (const [idxStr, urls] of Object.entries(erp_screenshots)) {
        const idxNum = parseInt(idxStr, 10);
        if (!Number.isInteger(idxNum) || idxNum < 0) continue;
        const it = record.items[idxNum];
        if (!it || !Array.isArray(urls)) continue;
        const clean = urls.filter(u => typeof u === 'string' && /^(\/uploads\/|https?:\/\/)/.test(u));
        if (clean.length === 0) continue;
        const existing = Array.isArray(it.erp_screenshots) ? it.erp_screenshots : [];
        const merged = existing.slice();
        for (const u of clean) if (!merged.includes(u)) merged.push(u);
        it.erp_screenshots = merged;
        erpMerged = true;
      }
    }

    // 仅在确实修改了 items 时才重写 items 列（终审自动完成 或 ERP 截图引用合并），避免覆盖并发更新的处理状态
    const itemsChanged = applied.itemsChanged === true;
    const writeItems = itemsChanged || erpMerged;
    const fields = ['status=$1', 'current_approval_level=$2', 'approval_history=$3', 'updated_at=NOW()'];
    const values = [applied.record.status, applied.record.current_approval_level, JSON.stringify(applied.record.approval_history)];
    let idx = 4;
    if (writeItems) {
      fields.push(`items=$${idx++}`);
      values.push(JSON.stringify(applied.record.items));
    }
    values.push(req.params.id);
    const upd = await client.query(
      `UPDATE aftersales_records SET ${fields.join(', ')} WHERE id=$${idx} RETURNING *`,
      values
    );
    await client.query('COMMIT');
    committed = true;
    client.release();

    // AFTERSALES-CC-COMPLETION-01：最终审批通过后，由服务端触发“结束节点抄送”完成通知。
    // 仅在记录首次从非“审批通过”进入“审批通过”时触发；幂等、事务外、失败不影响审批结果。
    if (applied.record.status === '审批通过' && prevStatus !== '审批通过') {
      try {
        const ccRes = await triggerCompletionCc(req.params.id);
        console.log('[CompletionCC] 触发结果:', JSON.stringify(ccRes));
      } catch (ccErr) {
        console.error('[CompletionCC] 触发异常(不影响审批结果):', ccErr && ccErr.message);
      }
    }

    // 服务端统一触发飞书通知：已在事务 COMMIT 之后调用，失败不影响已保存的审批结果。
    // 仅当审批推进到下一层级（action=approve 且新 current_approval_level>0）时通知，
    // 沿用既有冻结规则（Reject / 终审完成不再通知）。
    let notify = { sent: false, skipped: true, reason: 'no_notify_condition' };
    try {
      if (action === 'approve' && applied.record.current_approval_level > 0) {
        const newLevel = applied.record.current_approval_level;
        const nextApproverId = applied.record['approver_level' + newLevel + '_id'];
        notify = await sendApprovalNotify({ recordId: req.params.id, record: applied.record, level: newLevel, approverIds: [nextApproverId] });
      }
    } catch (notifyErr) {
      console.error('[Feishu][Server] 审批通知异常（不影响审批结果）:', notifyErr && notifyErr.message);
      notify = { sent: false, error: 'notify_exception: ' + (notifyErr && notifyErr.message) };
    }
    res.json({ ...upd.rows[0], notify });
  } catch (e) {
    if (client && !committed) { try { await client.query('ROLLBACK'); } catch (_) {} }
    if (client) { try { client.release(); } catch (_) {} }
    res.status(500).json({ error: e.message });
  }
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
    const { id, name, scope, enabled, nodes, cc_users } = req.body;
    if (!name) return res.status(400).json({ error: '流程名称不能为空' });
    const result = await query(
      `INSERT INTO approval_flows (id, name, scope, enabled, nodes, cc_users, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING *`,
      [id || ('flow_' + Date.now()), name, scope || '全部售后记录', enabled !== undefined ? enabled : false,
       JSON.stringify(nodes || []), JSON.stringify(await sanitizeCcUsers(cc_users || []))]
    );
    const row = result.rows[0];
    res.json({ ...row, nodes: typeof row.nodes === 'string' ? JSON.parse(row.nodes || '[]') : (row.nodes || []) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/approval-flows/:id', requireApiPermission('system_config'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, scope, enabled, nodes, cc_users } = req.body;
    const fields = ['updated_at = NOW()'];
    const values = [];
    let idx = 1;
    const add = (field, val) => { if (val !== undefined) { fields.push(`${field} = $${idx++}`); values.push(val); } };
    add('name', name);
    add('scope', scope);
    add('enabled', enabled);
    add('nodes', nodes !== undefined ? JSON.stringify(nodes) : undefined);
    // 服务端权威校验：仅保留存在且 active 的用户（过滤停用/不存在；去重），杜绝客户端伪造 CC 名单
    add('cc_users', cc_users !== undefined ? JSON.stringify(await sanitizeCcUsers(cc_users)) : undefined);
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
      if (!R2_ENABLED) req.files.forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: '缺少 record_id' });
    }
    // 限制 record_id 仅可为合法临时 ID（tmp_<UUID>）或正式 RMA ID（RMA-YYYYMMDD-NNNN），
    // 拒绝纯数字、RMA 以外字符串、路径/注入字符，防止附件被挂到任意记录或越权关联。
    if (!isValidRecordIdForUpload(record_id)) {
      if (!R2_ENABLED) req.files.forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: 'record_id 格式不合法（必须为 tmp_<UUID> 或 RMA-YYYYMMDD-NNNN）' });
    }
    const uploadedBy = req.user ? (req.user.id || req.user.username || '') : '';
    const saved = [];
    for (const f of req.files) {
      const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      // R2 启用时上传对象并返回公开 URL; 否则回退本地磁盘路径
      let filePath;
      if (R2_ENABLED) {
        filePath = await uploadToR2(f);
      } else {
        filePath = '/uploads/' + f.filename;
      }
      const result = await query(
        `INSERT INTO attachments (id, record_id, item_index, filename, original_name, mime_type, size, path, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [id, record_id, item_index ? parseInt(item_index) : null, f.originalname, f.originalname, f.mimetype, f.size, filePath, uploadedBy]
      );
      saved.push(result.rows[0]);
    }
    res.json(saved);
  } catch (e) {
    console.error('[upload] 附件上传失败:', e);
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

// 该接口已停用（返回 410 Gone）。
// 原用途：将附件的 record_id 从临时占位 ID 重新指向服务端正式生成的 RMA ID。
// 该能力现已在 POST /api/records 的事务内完成（temp_record_id 精确迁移），
// 独立端点缺乏归属校验、可被伪造身份越权调用，故永久停用，不再提供任何附件迁移能力。
app.post('/api/attachments/repoint', requireLogin, (req, res) => {
  return res.status(410).json({ error: '该接口已停用' });
});

app.delete('/api/attachments/:id', requireLogin, async (req, res) => {
  try {
    const result = await query('SELECT * FROM attachments WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: '附件不存在' });
    const att = result.rows[0];
    // 删除对象存储中的文件(R2)
    if (R2_ENABLED && att.path && att.path.indexOf(R2_CONFIG.publicUrl) === 0) {
      const key = r2KeyFromPath(att.path);
      if (key) {
        try { await r2Client.send(new DeleteObjectCommand({ Bucket: R2_CONFIG.bucket, Key: key })); }
        catch (e2) { console.warn('[R2] 删除对象失败(忽略):', key, e2.message); }
      }
    } else if (att.path && att.path.startsWith('/uploads/')) {
      // 本地兜底删除
      const filePath = path.join(__dirname, att.path.replace(/^\/uploads\//, 'uploads/'));
      fs.unlink(filePath, () => {});
    }
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

// 将飞书用户映射到系统内已存在的用户（按 feishu_open_id），不存在则返回 null
async function mapFeishuUserToDbUser(userInfo) {
  if (!userInfo || !userInfo.open_id) return null;
  try {
    const r = await query('SELECT id, username, name, role_id, status FROM users WHERE feishu_open_id = $1', [userInfo.open_id]);
    return r.rows[0] || null;
  } catch (e) {
    console.error('[Auth] 飞书用户映射失败:', e.message);
    return null;
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

    const tokenData = tokenRes.data.data || tokenRes.data;

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

    // 建立服务端 Session（不再通过 URL 传递用户身份）
    const dbUser = await mapFeishuUserToDbUser(userInfo);
    if (!dbUser) {
      recordFeishuEvent('feishu_user_no_db_mapping', { openId: userInfo.open_id });
      return res.redirect('/?feishu_error=no_db_user');
    }
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) return reject(err);
        req.session.userId = dbUser.id;
        req.session.loginType = 'feishu';
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
        req.session.save((saveErr) => saveErr ? reject(saveErr) : resolve());
      });
    });
    recordFeishuEvent('redirect_to_frontend', { userId: dbUser.id });
    res.redirect('/#page=overview');

  } catch (e) {
    console.error('[Feishu] OAuth 回调异常:', e.message);
    recordFeishuEvent('callback_server_error', { message: e.message });
    res.redirect(`/?feishu_error=${encodeURIComponent('server_error')}`);
  }
});

app.get('/api/auth/feishu/debug', (req, res) => {
  if (NODE_ENV === 'production') return res.status(404).json({ error: 'Not Found' });
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

// 获取当前登录用户（要求有效 Session；返回与 Session 绑定的 CSRF Token，刷新不轮换）
app.get('/api/auth/me', (req, res) => {
  if (!req.currentUser) return res.status(401).json({ error: '未登录' });
  res.json({
    success: true,
    user: {
      id: req.currentUser.id,
      username: req.currentUser.username,
      name: req.currentUser.name,
      roleId: req.currentUser.roleId,
      permissions: req.currentUser.permissions,
      loginType: req.session.loginType || 'unknown',
    },
    csrfToken: req.session.csrfToken,
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
// 退出登录：销毁服务端 Session（要求有效 Session + CSRF，由全局中间件校验）
function destroySession(req, res) {
  if (!req.session) return res.json({ success: true });
  req.session.destroy((err) => {
    if (err) console.error('[Auth] 登出失败:', err.message);
    res.clearCookie('aftersales.sid');
    res.json({ success: true });
  });
}
app.post('/api/auth/feishu/logout', (req, res) => destroySession(req, res));
app.post('/api/auth/logout', (req, res) => destroySession(req, res));

// 紧急管理员登录（break-glass）：路由始终注册；关闭时立即 404，开启时走独立限流 + 密码哈希校验 + 建立 Session
const breakGlassLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // 使用库内置 keyGenerator（正确处理 IPv6 / 代理场景），不自定义
  handler: (req, res) => res.status(429).json({ error: '尝试次数过多，请稍后再试' }),
});

app.post('/api/auth/break-glass',
  (req, res, next) => {
    // 关闭状态：立即 404，绝不进入限流 / 密码校验 / 用户查询
    if (!BREAKGLASS_ENABLED) return res.status(404).json({ error: 'Not Found' });
    next();
  },
  breakGlassLimiter,
  async (req, res) => {
  if (!BREAKGLASS_PASSWORD_HASH || !/^\$2[aby]\$[0-9]{2}\$/.test(BREAKGLASS_PASSWORD_HASH)) {
    return res.status(404).json({ error: 'Not Found' });
  }
  const { password } = req.body || {};
  const fail = () => res.status(401).json({ error: '认证失败' }); // 统一失败响应，不泄露开关/哈希/账号
  if (!password) return fail();
  let ok = false;
  try { ok = await bcrypt.compare(String(password), BREAKGLASS_PASSWORD_HASH); } catch (e) { return fail(); }
  if (!ok) return fail();
  let admin;
  try {
    const r = await query("SELECT id, username, name, role_id, status FROM users WHERE id = 'user_admin'");
    admin = r.rows[0];
  } catch (e) { return fail(); }
  if (!admin || admin.status !== 'active') return fail();
  // 建立正常服务端 Session（regenerate，产生新有效期）
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: '会话创建失败' });
    req.session.userId = admin.id;
    req.session.loginType = 'break-glass';
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: '会话保存失败' });
      res.json({
        success: true,
        csrfToken: req.session.csrfToken,
        user: { id: admin.id, username: admin.username, name: admin.name, roleId: admin.role_id },
      });
    });
  });
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

// 服务端审批流转通知：从已保存记录推导下一审批人，在审批事务 COMMIT 之后调用，
// 失败不影响已保存的审批结果。与 /api/notify/approval 共享同一套飞书发送逻辑，
// 不改变通知内容 / 对象 / 业务规则（仅审批动作推进到下一层级时通知，Reject / 终审完成不通知）。
async function sendApprovalNotify({ recordId, record, level, approverIds }) {
  if (!(level >= 1 && level <= 3)) {
    return { sent: false, skipped: true, reason: 'no_next_level' };
  }
  const approvers = (Array.isArray(approverIds) ? approverIds : [approverIds])
    .filter(Boolean)
    .map(id => ({ id }));
  if (approvers.length === 0) {
    return { sent: false, skipped: true, reason: 'missing_approver_id', level };
  }
  const resolvedApprovers = await resolveApproversForNotify(approvers);
  const recordDisplayId = `AS${String(recordId).padStart(4, '0')}`;
  const detailUrl = `${APP_BASE_URL}/#page=detail&id=${recordId}`;
  console.log('[Feishu][Server] 审批流转通知', {
    recordId, recordDisplayId, approvalLevel: level, approvalLevelName: approvalLevelName(level),
    targets: resolvedApprovers.map(a => ({ name: a.name, system_user_id: a.id || '' }))
  });
  if (!feishuConfigured) {
    console.log('[Mock][Server] 模拟发送审批通知:', {
      recordDisplayId, approvalLevel: approvalLevelName(level),
      approvers: resolvedApprovers.map(a => a.name)
    });
    return { sent: true, mock: true, message: '模拟模式：通知已记录（飞书未配置时使用）', sentTo: resolvedApprovers.map(a => a.name) };
  }
  const tokenResult = await getTenantAccessToken();
  if (tokenResult.error) {
    console.error('[Feishu][Server] 获取 tenant_access_token 失败', JSON.stringify(tokenResult));
    return { sent: false, error: `获取飞书 token 失败: ${tokenResult.error}` };
  }
  const results = { success: [], failed: [] };
  const sentReceivers = new Set();
  for (const approver of resolvedApprovers) {
    const receiver = getFeishuReceiver(approver);
    if (!receiver) {
      const reason = '审批人未绑定飞书账号：feishu_open_id/open_id/user_id 均为空';
      console.warn('[Feishu][Server] 跳过未绑定审批人', {
        name: approver.name, system_user_id: approver.id || '',
        reason
      });
      results.failed.push({ name: approver.name, userId: approver.id || '', reason, code: 'APPROVER_NOT_BOUND' });
      continue;
    }
    const receiverKey = `${receiver.type}:${receiver.id}`;
    if (sentReceivers.has(receiverKey)) {
      console.log('[Feishu][Server] 当前审批级别重复收件人已跳过', { name: approver.name });
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
      approvalLevel: level,
      currentApproverName: approver.name
    });
    console.log('[Feishu][Server] 准备发送审批通知', {
      recordDisplayId, approverName: approver.name, system_user_id: approver.id || '',
      receive_id_type: receiver.type, receive_id: receiver.id
    });
    const sendResult = await sendFeishuInteractiveMessage({
      token: tokenResult.token, receiver, card, recipientName: approver.name,
      context: { type: 'approval', recordId, approvalLevel: level }
    });
    if (sendResult.success) {
      results.success.push({ name: approver.name, userId: approver.id || '', receiveIdType: receiver.type, messageId: sendResult.messageId });
    } else {
      results.failed.push({ name: approver.name, userId: approver.id || '', receiveIdType: receiver.type, reason: sendResult.reason, code: sendResult.code });
    }
  }
  const summary = results.success.length > 0
    ? `已通知 ${results.success.map(r => r.name).join('、')}`
    : '通知发送失败';
  console.log('[Feishu][Server] 审批通知发送汇总', JSON.stringify({ recordId, approvalLevel: level, successCount: results.success.length, failedCount: results.failed.length, failed: results.failed }));
  return { sent: results.failed.length === 0, mock: false, message: summary, results };
}

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
function buildApprovalCard({ recordDisplayId, submitterName, aftersalesDate, items, brands, platforms, detailUrl, approvalLevel, currentApproverName, isCc }) {
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
        content: isCc ? '📋 售后抄送通知（仅查看）' : ('📋 售后审批通知' + (approvalLevel ? ` - 待${levelText}审批` : ''))
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
              content: isCc ? '🔍 查看详情（仅查看）' : '📝 查看/审批'
            },
            type: 'primary',
            url: detailUrl,
            value: {}
          }
        ]
      },
      // 四.5：CC 卡片明确标识“抄送”，且只可查看，不得出现审批/拒绝操作按钮
      ...(isCc ? [
        {
          tag: 'note',
          elements: [
            {
              tag: 'plain_text',
              content: '本消息为抄送阅知，您无需进行审批操作。'
            }
          ]
        }
      ] : [])
    ]
  };
}

// 完成后抄送卡片：与待审批卡片区分，明确“审批已完成”，只含查看详情按钮，无审批/拒绝操作。
function buildCompletionCard({ recordDisplayId, submitterName, aftersalesDate, items, brands, platforms, detailUrl }) {
  const skuLines = (items || []).slice(0, 5).map(it => {
    const reason = it.return_reason || '-';
    const process = it.process_status || '-';
    return `• ${it.sku_code || '-'} | ${it.order_no || '-'} | ×${it.quantity || 0} | ${reason} | ${process}`;
  });
  if ((items || []).length > 5) skuLines.push(`... 共 ${items.length} 条明细`);
  const skuContent = skuLines.join('\n');
  const processSummary = {};
  (items || []).forEach(it => { const ps = it.process_status || '未知'; processSummary[ps] = (processSummary[ps] || 0) + 1; });
  const processText = Object.entries(processSummary).map(([k, v]) => `${k}: ${v}条`).join(' / ');
  const totalQuantity = (items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const safeSkuContent = skuContent || '-';
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '✅ 售后审批已完成' },
      template: 'green'
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**售后单号**\n${recordDisplayId}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**提交人**\n${submitterName || '-'}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**售后日期**\n${formatCardDate(aftersalesDate)}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**SKU / 数量**\n${(items || []).length} 个 SKU / ${totalQuantity} 件` } }
        ]
      },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**审批状态**\n审批通过（已完成）` } },
      { tag: 'div', text: { tag: 'lark_md', content: `**SKU 明细**\n${safeSkuContent}` } },
      { tag: 'div', text: { tag: 'lark_md', content: `**处理状态分布**\n${processText || '-'}` } },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `品牌：${brands || '-'} | 平台：${platforms || '-'}` }]
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔍 查看详情' },
            type: 'primary',
            url: detailUrl,
            value: {}
          }
        ]
      },
      // 四.7：完成通知明确为结果通知，抄送阅知，不得出现审批/拒绝操作按钮
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '本消息为审批完成结果通知（抄送阅知），您无需进行审批操作。' }]
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

// 仅在作为主模块直接运行时启动服务器，便于被测试 harness 安全导入而不连接生产库。
if (require.main === module) {
  startServer();
}

// 模块接口：被 require 时仅导出 app / startServer（require.main 守卫，生产直接运行不受影响）。
// 内部函数不再导出，避免测试专用 export 进入生产代码。
if (require.main !== module) {
  module.exports = { app, startServer };
}
