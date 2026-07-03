# 售后数据管理系统

本项目只保留 Node/Express 单页应用版本。

## 启动方式

```bash
npm start
```

默认访问地址：

- 系统入口：`http://localhost:3000`
- 本地账号入口：`http://localhost:3000/?admin`
- 飞书回调地址：`http://localhost:3000/api/auth/feishu/callback`

## 飞书开放平台配置

- 网页应用桌面端主页：`http://localhost:3000`
- OAuth 重定向 URL：`http://localhost:3000/api/auth/feishu/callback`

不要把 `/api/auth/feishu/callback` 配成网页应用主页，它只用于飞书授权后的回调。
