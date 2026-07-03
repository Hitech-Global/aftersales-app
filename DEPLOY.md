# 售后数据管理系统 — Render + Supabase 部署指南

## 架构总览

```
UptimeRobot (防休眠) → Render (Node.js) → Supabase (PostgreSQL)
        免费 ¥0             免费 ¥0             免费 ¥0
```

总费用：**¥0/月**

---

## 一、Supabase 数据库设置

### 1.1 注册 Supabase
1. 打开 [supabase.com](https://supabase.com) 注册账号
2. 点击 **New project** → 填写项目名（如 `aftersales`）
3. 设置数据库密码（记下来，后面要用）
4. Region 选 **Singapore**（离中国和海外都近）
5. 点击 **Create project**（等待 1-2 分钟）

### 1.2 获取数据库连接串
1. 进入项目 → 左侧 **Project Settings** → **Database**
2. 找到 **Connection string** 标签
3. 选择 **Transaction** 模式（端口 6543）
4. 复制连接串，把 `[YOUR-PASSWORD]` 替换为你的数据库密码

连接串格式：
```
postgresql://postgres.xxx:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
```

---

## 二、Render 部署

### 2.1 推送代码到 GitHub

```bash
cd /path/to/aftersales-app
git init
git add .
git commit -m "Initial: 售后系统 + PostgreSQL 支持"
git remote add origin https://github.com/你的用户名/aftersales-app.git
git push -u origin main
```

### 2.2 在 Render 上部署

1. 打开 [render.com](https://render.com) 用 GitHub 登录
2. 点击 **New +** → **Web Service**
3. 连接仓库 → 选择 `aftersales-app`
4. 填写配置：

| 字段 | 值 |
|------|-----|
| Name | `aftersales-app` |
| Region | `Singapore` |
| Build Command | `npm ci` |
| Start Command | `node server.js` |

5. 添加环境变量（**Advanced** → **Environment Variables**）：

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `BASE_URL` | `https://aftersales-app.onrender.com` |
| `DATABASE_URL` | `postgresql://...`（从 Supabase 复制的连接串） |
| `FEISHU_ENABLED` | `true` |
| `FEISHU_APP_ID` | `cli_aaccbd21b03b1bc0` |
| `FEISHU_APP_SECRET` | `aPhL8mgsMnjCqbDiQylrmb8BF1LR3tDN` |
| `FEISHU_APP_NAME` | `售后数据管理系统` |

6. 点击 **Create Web Service**（首次部署 3-5 分钟）

### 2.3 绑定自定义域名（可选）

1. Render Dashboard → 你的服务 → **Settings** → **Custom Domain**
2. 添加 `your-domain.com`
3. 在域名 DNS 添加 CNAME 记录指向 Render 提供的地址
4. Render 自动申请 Let's Encrypt HTTPS 证书

---

## 三、防止休眠（UptimeRobot）

Render 免费版 15 分钟无请求会休眠。

1. 打开 [uptimerobot.com](https://uptimerobot.com) 免费注册
2. **Add New Monitor** → 选择 **HTTP(s)**
3. URL 填写：`https://aftersales-app.onrender.com/api/auth/feishu/status`
4. 监控间隔：**5 分钟**
5. 保存 → 服务永不休眠

---

## 四、部署后必须修改飞书开放平台

登录 https://open.feishu.cn/app 进入你的自建应用：

| 配置项 | 修改为 |
|--------|--------|
| 网页应用 - 桌面端主页 | `https://aftersales-app.onrender.com` |
| 网页应用 - 移动端主页 | `https://aftersales-app.onrender.com` |
| 安全设置 - 重定向 URL | `https://aftersales-app.onrender.com/api/auth/feishu/callback` |
| 安全设置 - H5 可信域名 | `aftersales-app.onrender.com` |

> ⚠️ 如果绑定了自定义域名，所有地址改为你的域名。

---

## 五、验证部署

```bash
# 测试 API
curl https://aftersales-app.onrender.com/api/db/status
# 应返回: {"configured":true,"connected":true}

curl https://aftersales-app.onrender.com/api/auth/feishu/status
# 应返回: {"feishuEnabled":true,...}

curl https://aftersales-app.onrender.com/api/version
# 应返回: {"version":"3.3.1-render-latest","entry":"server.js","frontend":"index.html",...}

# 打开浏览器访问
open https://aftersales-app.onrender.com
```

页面左下角应显示 `v3.3.1 Render Latest`。如果仍显示旧版本，说明 Render 没有部署当前仓库最新代码，请在 Render Dashboard 手动点 **Manual Deploy → Clear build cache & deploy**。

---

## 六、数据备份

Supabase 免费版不自动备份。建议每月手动执行一次：

```bash
# 安装 Supabase CLI
npm install -g supabase

# 登录
supabase login

# 导出数据库
supabase db dump --linked --local > backup-$(date +%Y%m%d).sql
```

---

## 七、更新与回滚

```bash
# 更新代码
git add .
git commit -m "update"
git push
# Render 自动检测并重新部署

# 回滚
git revert <commit-hash>
git push
```

---

## 常见问题

**Q: 首次部署后飞书登录报错**
A: 检查飞书开放平台的重定向 URL 是否已改为 Render 域名

**Q: 页面打开空白**
A: 查看 Render Logs，确认 `node server.js` 正常启动

**Q: 数据库连接失败**
A: 确认 Supabase 项目未暂停（7 天无请求会暂停，在 Dashboard 手动恢复）

**Q: 需要换自定义域名**
A: Render Settings → Custom Domain 添加，然后去飞书开放平台更新所有 URL
