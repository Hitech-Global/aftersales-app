# 售后管理系统（aftersales-app）前端结构与业务逻辑梳理

> 用途：作为 UI 重构方案的需求/现状输入，交给 ChatGPT 或设计侧。
> 当前版本：v3.9.22（生产：https://aftersales-app.onrender.com）
> 代码现状：前端为**单一文件 SPA**（`index.html` 7450 行，内联全部 JS/CSS），后端 `server.js`（Express），数据库 `db.js`（PostgreSQL / Supabase）。
> 说明：本文仅梳理**现状**，未改动任何代码。

---

## 一、当前技术栈

| 维度 | 现状 |
|------|------|
| 前端框架 | **无框架**，原生 Vanilla JS。整个应用是 `index.html` 单文件 SPA（HTML + 内联 `<style>` + 内联 `<script>`，约 7450 行） |
| UI 库 / 图标库 | **无第三方 UI 组件库**。无组件化，全部手写 DOM 字符串拼接（`innerHTML`）。图标使用 Unicode Emoji（如 `&#x1F4CA;`），仅 favicon 用生成 SVG/PNG |
| 图表库 | **Chart.js 4.4.7**（通过 CDN `jsdelivr` 引入），用于概览页 3 个图表 |
| 表格/弹窗 | 均为手写通用 CSS 类（`.data-table` / `.table-container` / `.modal-overlay` / `.modal-panel`），无组件封装 |
| 样式方式 | 原生 CSS + **CSS 变量**（`:root` 定义主题：`--primary:#2e7d32` 等）；无 Tailwind / Sass / CSS Modules；class 命名接近 BEM 但较随意 |
| 路由结构 | **无路由库**。自研 `showPage(page, recordId)` 切换 `.page` 容器显隐（`page-*` 区块 `display:none/block`）。无 URL hash 路由、无 history 路由 |
| 全局 Layout | 有：`.app-shell`（侧边栏 + 主区）。`renderSidebar()` 动态生成（按权限过滤）；`Topbar`（页面标题 + 用户菜单 + 登出）；登录页独立（`page-login`） |
| 公共组件 | Modal 体系（`modal-overlay/modal-panel` 通用弹窗、`record-fs-overlay` 大表单弹窗、各业务 modal：`user-modal`/`role-modal`/`product-modal`/`product-import-modal`/`approval-modal`/`batch-process-modal`/`dict-add-modal`）；Toast `showFlash()`；自研日期选择器 `renderCustomDatePanel()`；SKU/店铺自动补全下拉 |
| 状态管理 | **无状态库**。用全局 `let` 变量 + `localStorage` 缓存（`_recordsCache` 等）+ `asArray(await getRecords())` 拉取；前端计算为主，后端为纯 CRUD |
| 数据获取 | 直接 `fetch('/api/...')` + 自定义 `getAuthHeaders()`（含登录态），无 axios / React Query |
| 多语言(i18n) | `locales/zh-CN.json` / `en-US.json` / `id-ID.json` + `locales/i18n.js` 的 `t(key, params)`；缺失 key 返回空串 `''`。大量 `data-i18n` 属性 + JS 内 `t(...)` |

---

## 二、当前页面清单

> 注：侧边栏由 `renderSidebar()`（index.html:2481）按权限动态生成；详情页不在侧边栏，通过 `showPage('detail', id)` 跳转。

| 页面路径（DOM id） | 功能 | 权限(perm) | 渲染函数 |
|---|---|---|---|
| `page-login` | 飞书 OAuth 登录页（独立，非侧边栏） | 无 | — |
| `page-overview` | 售后概览（统计卡片 + 风险卡片 + 最近记录 + 3 图表） | `record_view` | `renderOverview()` :2609 |
| `page-list` | 售后列表（按单 / 按明细两种模式 + 筛选 + 批量） | `record_view` | `renderList()` :2860 |
| `page-detail` | 售后详情（非独立导航，showPage 跳转） | `record_view` | `renderDetail(id)` :3201 |
| `page-approval` | 售后记录审批（待我审批 / 我已审批 + 表格） | `approval_level1/2/3` 任一或 `record_view` | `renderApproval()` :4481 |
| `page-products` | 商品管理 | `product_view` | `renderProducts()` :5558 |
| `page-users` | 用户管理 | `user_manage` | `renderUsers()` :5900 |
| `page-roles` | 角色管理 | `role_manage` | `renderRoles()` :6250 |
| `page-customers` | 客户管理（只读，Webhook 同步） | `system_config` | `renderCustomers()` :5811 |
| `page-dictionaries` | 字典管理 | `system_config` | `renderDictionaries()` :7023 |
| `page-approval-flows` | 审批流管理 | `system_config` | `renderApprovalFlows()` :6661 |

**关于「新建售后记录」**：当前**不是独立页面**，而是 `record-form-modal` 弹窗（`openRecordForm()` :3349）。用户清单中的「新建售后记录」对应此 Modal。

---

## 三、当前核心业务流程

### 完整流程
```
创建草稿/提交 → 提交审批(自动按审批流应用首级审批人) →
  一级审批(approve/reject) → 二级审批 → 三级审批 →
  审批通过(所有级 approve) → 后续处理(ERP入库/换彩盒/补配件/RMA/报废) →
  明细全部 completed → 完成
```

### 1) 审批状态（`record.status`，六态）
- `草稿`（draft，仅可编辑）
- `待一级审批` / `待二级审批` / `待三级审批`（pending 各级）
- `审批通过`（completed）
- `审批拒绝`（rejected）

显示用 `tApprovalStatus(value)`（:1255）做中/英/旧值 → 三态归一（`completed`/`pending`/`rejected`）再翻译。

### 2) 处理状态（`item.process_progress`，三态）+ legacy 文本
- `pending`（待处理）→ 显示文案 `待ERP入库/待换彩盒/待补配件/待RMA/待报废`（取决于 `process_type`）
- `processing`（处理中）→ 显示 `待RMA`（仅 rma 类型走此态）
- `completed`（已处理）→ 显示 `已处理`

归一化函数 `normalizeProcessItem()`（:1810）负责把旧 `process_status` 文本映射为 `process_type`+`process_progress`，并自动补 `process_completed_date`。常量 `LEGACY_STATUS_TO_PROCESS`（:1788）、`PROCESS_PROGRESS_VALUES`（:1787）。

### 3) 处理类型（`item.process_type`，由退货原因映射）
| process_type | 含义 | 来源 return_reason（RETURN_REASON_TO_PROCESS_TYPE :1806） |
|---|---|---|
| `erp` | ERP 入库 / 可二次销售 | 可二次销售、人为损坏、其他、功能异常 |
| `color_box` | 换彩盒 | 彩盒损坏 |
| `parts` | 补配件 | 配件缺失 |
| `rma` | RMA | 硬件故障 |
| `scrap` | 报废 | 报废 |

> 提交时（`submitForApproval` :4213）按 return_reason 自动写入 `process_type`，初始 `progress='pending'`。

### 4) RMA 状态
- **没有独立的 RMA 表/状态机**。RMA 是 `process_type='rma'` 的一种明细处理类型，状态统一在 `process_progress` 中。
- 待 RMA 判定：`isPendingRmaItem(item)` = `process_type==='rma' && progress!=='completed'`（:2600）。
- 列表「待 RMA」筛选即按此。

### 5) ERP 入库逻辑（治本逻辑，v3.9.20，`executeApproval` :4427）
- 当一条审批**最终通过**（无下一级）时，遍历所有明细：
  - 若明细 `isResellable`（满足 `process_type==='erp'` 或 `process_type==='ERP入库'` 或 `return_reason==='可二次销售'` 或 `return_reason==='resellable'`）且 `progress!=='completed'`：
    - 置 `process_progress='completed'`、`process_status='已处理'`、`process_completed_date = returnDate || now`
    - 若审批时填了退货日期 `returnDate`，额外写 `return_stockin_date`
    - 追加 `process_log`
- 其他处理类型（color_box/parts/rma/scrap）**不受影响**，保持 pending，需在后续处理中手动标记完成（`markItemProcessed` :4768）。
- 退货日期 `returnDate` **不再是**自动 completed 的前提（不再强制阻断审批）。

### 6) 超时 / 风险筛选
- 已有前端逻辑：`isOverdueItem(item, record, days=7)`（:2602）= 待处理 且 距起始时间（`process_status_date`/`updated_at`/`created_at`/`aftersales_date`）≥ 7 天。
- 列表 `risk-filter` 支持 `pending`（待处理）/ `overdue`（超期）。
- 概览有「超期未处理」风险卡片。
- **无后端定时任务 / 自动通知超期**（仅前端筛选与概览展示；飞书通知仅用于审批流转）。

---

## 四、Overview 当前数据逻辑

入口 `renderOverview()`（:2609）。数据：`records = asArray(await getRecords())`，按 `aftersales_date` 范围 + `brand` 过滤；`allItems` 把每条 record 的 items 摊平（无 items 时补空 item）。

| 指标 | 计算方式 | 展示 |
|---|---|---|
| 今日售后 | `records.filter(recordDateKey(r)===todayKey).length` | 卡片（不可点） |
| 待审批 | `records.filter(isPendingApproval).length` | 卡片（点→跳审批页 pending） |
| 待处理 | `allItems.filter(isPendingProcessItem).length`（progress≠completed） | 卡片（点→跳列表 risk=pending） |
| 已完成 | `allItems.filter(itemProcessProgress==='completed').length` | 卡片（不可点） |
| 超期未处理 | `allItems.filter(isOverdueItem).length`（待处理且≥7天） | 风险卡片（点→跳列表 risk=overdue） |
| 待 RMA | `allItems.filter(isPendingRmaItem).length`（rma 且未完成） | 风险卡片（点→跳列表 processType=rma） |
| 近 30 天售后趋势 | `buildTrend30()`：按 `aftersales_date` 分 30 桶，count=Max(1, items数)，line 图 | Chart.js |
| 退货原因 TOP5 | 按 `item.return_reason` 计数，取前 5，bar 图（`tReturnReason` 翻译） | Chart.js |
| SKU 售后 TOP10 | 按 `item.sku_code` 计数，取前 10，横向 bar 图 | Chart.js |
| 最近售后记录 | records 按 `aftersales_date` desc 取前 5，显示 #id/日期/状态/提交人，点击进详情 | 列表 |

容错：数据加载、主内容渲染、图表渲染三段独立 try/catch，图表异常不影响主内容（`:2682` `safeRenderChart`）。卡片点击经 `jumpFromOverview(type)`（:2778）带筛选跳转到列表/审批页。

---

## 五、售后列表当前字段和操作

入口 `renderList()`（:2860）。两种模式：`listMode='record'`（按单） / `'item'`（按明细），`switchListMode()` 切换。

### 按售后单显示的字段（record 模式）
id、审批状态(status badge)、日期、平台(platforms)、品牌、型号、提交人、总数量、处理进度汇总（badge 串）、操作（查看/编辑/删除）

### 按售后明细显示的字段（item 模式）
勾选框、id、审批状态、处理类型(badge)、处理进度(badge)、日期、平台、店铺/客户、退货原因、SKU、SN 码、订单号、数量、描述、提交人、操作

### 筛选条件
- 关键字 search（全文：品牌/型号/提交人/id + 明细 platform/shop_customer/sku/order_no/fault_description/return_reason）
- 审批状态 status、品牌 brand、渠道 channel(platform)、退货原因 return_reason、处理进度 processProgress
- 风险 risk（pending 待处理 / overdue 超期）
- 日期范围（start/end，按 aftersales_date/created_at）

### 支持的操作
- 查看：`showPage('detail', id)`
- 编辑：`editRecord(id)` —— **仅草稿可编辑**（status!=='草稿' 禁止）
- 删除：`deleteRecord(id)`（权限 `record_delete`）
- 新建（手动）：`openRecordForm()`（record-form-modal）
- 批量导入：`openImportDialog()`（CSV/Excel，见下）
- 导出：`exportAftersalesExcel()`（权限 `record_export`），支持**按售后单 / 按明细**两种导出（:5437–5514），CSV 保留原始 code
- 批量处理：勾选明细 → `openBatchProcessModal()`（按明细批量改处理进度）

### 手动填写实现
`record-form-modal` 表单（`openRecordForm` :3349）：
- 基本信息仅 `aftersales_date`（自研日期选择器）
- 明细表格可加多行（`addDetailItem()`）：每行 platform(字典下拉)、shop_customer(字典下拉，按 platform 的 parent_code 过滤)、sku_code(必填 + SKU 自动补全，联动商品表取 brand/model)、sn_code、order_no、quantity(必填>0)、return_reason(必填字典下拉)、fault_description(必填)、附件(图片)
- 提交校验（`submitForApproval` :4165）：date + 每行 platform/sku/qty/reason/desc 必填；审批流必须有审批人

### 批量导入实现
`openImportDialog()`（:4944）→ 选择 CSV/XLSX → `XLSX.read`（SheetJS CDN 引入，:17）→ 解析为对象数组 → 预览（`import-preview-area`）→ 确认写入（`/api/records` 或内存）；支持下载模板 `downloadImportTemplate()`、错误行下载 `downloadImportErrors()`。商品批量导入走 `/api/products/bulk-import`（后端）。

---

## 六、新建售后记录表单结构

（Modal：`record-form-modal`，核心函数 `openRecordForm` :3349 / `submitForApproval` :4165 / `saveAsDraft` :4283）

### 基本信息字段
- `aftersales_date`（必填，自研日期选择器）

### 售后明细字段（≥1 行，必填项带 `*`）
- `platform`（平台，必填，字典下拉）
- `shop_customer`（店铺/客户，字典下拉，按 platform 联动 parent_code）
- `sku_code`（SKU，必填，自动补全联动商品表）
- `sn_code`（SN 码）
- `order_no`（订单号）
- `quantity`（数量，必填 >0）
- `return_reason`（退货原因，必填，字典下拉）
- `fault_description`（故障描述，必填）
- `attachment`（附件，图片）

提交时（`submitForApproval` :4213）自动：`process_type = RETURN_REASON_TO_PROCESS_TYPE[reason]`、`process_progress='pending'`、`process_status=对应待处理文案`。汇总 `total_quantity`、从首个 SKU 推导 `brand/model/category`。

### 审批人设置逻辑
- **不再手动选择审批人**。表单展示「审批流卡片」（`f-approval-flow-preview`），由「审批流管理」中配置的 flow 自动应用（`_activeFlowId`）。
- 提交时取 flow 中首个有 `approver_id` 的节点级别作为起始：`status='待X级审批'`、`current_approval_level=X`，并写 `approver_level{1,2,3}_id/name`。
- 若无审批人配置 → 拦截提交（`flash.flowNoApprover`）。

### 附件上传逻辑
- 明细行内 attachment（图片）；审批操作区也可上传（`pendingAttachments`，支持点击/拖拽/粘贴，:3273）。
- 后端 `/api/attachments/upload`（`multer`，最多 10 个），按 `record_id` + `item_index` 存储；详情页 `fetchRecordAttachments(r.id)` 拉取展示。

### 保存草稿 / 提交审批逻辑
- `saveAsDraft()`：status='草稿'，不进审批；列表仅草稿可再次编辑（`editRecord` 限制）。
- `submitForApproval()`：构建 record + items，写审批人，发飞书通知（`sendApprovalNotification`，非阻塞），跳列表。

---

## 七、详情页结构（`renderDetail(id)` :3201）

展示模块（按 DOM 顺序）：
1. **基本信息**：日期、状态(badge)、提交人、待 ERP 数量(pendingErpQty)、总数量
2. **售后明细表格**：序号、平台、店铺/客户、品牌(商品表查)、SKU、SN、订单号、数量、退货原因、处理类型(badge)、处理进度(badge)、ERP 入库日期(return_stockin_date)、描述、附件
3. **审批流程(approvers)**：发起人 → L1 → L2 → L3 名称链（无则「未设置」）
4. **审批操作区(approvalAction)**：仅当前审批人可见；退货日期、审批意见、附件上传区、通过/拒绝按钮
5. **审批记录(approvalHistory)**：timeline，每条含 action/operator/level/comment/return_date/attachments/timestamp
6. **处理日志(renderProcessLogsHTML)**：ERP 自动完成等过程记录
7. **时间信息**：创建时间、更新时间
8. **可执行操作**：审批通过/拒绝（当前审批人）、ERP 明细上传截图(`triggerErpUpload`)/标记完成(`markItemProcessed`)、查看/下载附件

---

## 八、系统管理页面逻辑

### 商品管理 `renderProducts()` :5558
- 字段：`sku_code`(唯一)、`product_name`、`brand`、`model`、`category`、`country`、`ean_code`、`status`、`price`
- 操作：增删改查；搜索 + 品牌/国家/状态筛选；分页；批量勾选删除(`/api/products/batch-delete`)；批量导入(`/api/products/bulk-import`，XLSX/CSV)；导出(权限 `product_export`)
- 后端：`/api/products` 系列（GET/POST/PUT/DELETE + bulk-import/batch-delete）

### 用户管理 `renderUsers()` :5900
- 字段：`username`、`name`、`password`、`role_id`、`status`、`feishu_open_id` 等飞书绑定字段
- 操作：增删改查；飞书测试通知(`sendFeishuTestNotification`)；`user_admin` 不可删；新建用户可选飞书联系人(`/api/feishu/contacts/search`)
- 后端：`/api/users` 系列 + `/api/feishu/contacts/search`

### 角色管理 `renderRoles()` :6250
- 字段：`name`、`description`、`permissions`（多选，来自 `ALL_PERMISSIONS`）、`system`（系统角色不可删）
- 权限枚举（18 项，`_PERM_CONFIG` :1260）：`record_view/create/edit/delete/import/export`、`product_view/create/edit/delete/import/export`、`approval_level1/2/3`、`user_manage`、`role_manage`、`system_config`
- 操作：增删改查（系统角色禁删）

### 客户管理 `renderCustomers()` :5811
- **只读展示**（数据来自妙搭 Webhook 同步，无本地新增/编辑）
- 字段：`external_customer_id`(唯一)、`customer_name`、`contact_person`、`phone`、`email`、`country`、`address`、`status`、`source`、`last_synced_at`
- 操作：搜索 + 状态筛选 + 分页（后端 `/api/customers` 分页接口 `limit/offset`）

### 字典管理 `renderDictionaries()` :7023
- 分类（`DICT_CATEGORY_IDS` :6994）：`return_reason`、`platform`、`return_method`、`shop_customer`、`common`
- 每条字典字段：`code`、`label_zh/en/id`、`sort_order`、`enabled`、`parent_code`（`shop_customer` 用，联动 `platform`）
- 操作：行内改名称、新增、启停；`shop_customer` 可设所属父平台
- 后端：`/api/dictionaries` 系列

### 审批流管理 `renderApprovalFlows()` :6661
- flow 字段：`id`、`name`、`scope`、`enabled`、`nodes`(JSONB)
- 节点结构：`{level, title, permission, approver_id, approver_name, backup_approver_id, backup_approver_name}`
- 操作：增删改；节点配置（按 `approval_level1/2/3` 权限选审批人 + 备选审批人）；启用/停用
- 后端：`/api/approval-flows` 系列

---

## 九、当前不能改动的业务逻辑（UI 重构红线）

重构（尤其拆组件/换框架/改样式）时，**以下逻辑必须保持原行为**，否则会破坏线上业务：

1. **飞书登录与绑定**：`/api/auth/feishu/*`（login/callback/status/logout）、`findUserByFeishu` 绑定逻辑、用户飞书字段。
2. **客户同步**：妙搭 Webhook `/api/webhooks/customer-sync`（含 `verifyWebhookSignature` 签名校验）。客户管理页只读，不可改为可写。
3. **审批流与状态机**：三级审批节点、`executeApproval()` 状态流转、`findNextApprovalLevel`、`canApproveRecord`、飞书审批通知 `sendApprovalNotification`。前端展示可改，状态计算不可改。
4. **导入导出契约**：CSV/XLSX 解析（`parseCSV`、SheetJS）、字段映射、导出按单/按明细、**CSV 保留原始 code**（不改数据口径）；权限 `record_export`/`record_import`。
5. **售后状态计算**：`record.status` 六态、`item.process_type`/`process_progress`、`normalizeProcessItem()` 归一化、`isPendingApproval/isPendingProcessItem/isPendingRmaItem/isOverdueItem` 判定、ERP 自动 completed 治本逻辑（v3.9.20）。
6. **权限控制**：`_PERM_CONFIG`/`ALL_PERMISSIONS`、`hasPermission`、`canAccessPage`、`requireApiPermission`/`requireLogin`（后端每接口）、前端按钮显隐。重构不得放宽或绕过。
7. **多语言**：`locales/zh-CN|en-US|id-ID.json` + `locales/i18n.js` 的 `t()`；所有文案走 key，状态翻译 `tApprovalStatus` 三态归一；重构须保留全部 key 与三语言，缺失 key 返回 `''` 行为不变。
8. **数据库 Schema**：`db.js` 表结构（`aftersales_records.items` 为 JSONB、各 `approver_level*_id/name`、`approval_history` JSONB 等）、`DATABASE_URL` 连接、迁移列。不可改表结构。
9. **附件与通知**：`/api/attachments/*` 上传/查询/删除、飞书通知 `/api/notify/*`。
10. **部署契约**：`git push origin main` → Render 自动部署（`render.yaml`）；`index.html` 仍由 `server.js` 的 `express.static(__dirname)` 托管。重构后入口与静态托管路径需保持。

---

## 十、建议 UI 重构优先改 / 拆分的文件

当前所有前端逻辑、结构、样式都在 **`index.html` 单文件**中。重构建议**按职责拆分模块**（以下为建议目标结构，非当前文件）：

| 文件 / 模块 | 当前位置（index.html 行号） | 负责什么 |
|---|---|---|
| **入口与 Layout** | `renderSidebar` :2481 / `showPage` :2524 / Topbar/Login DOM :528–607 | 侧边栏（权限过滤）、页面路由切换、顶栏、登录页 |
| **概览页** | `renderOverview` :2609 + 图表 :2742–2776 + `jumpFromOverview` :2778 | 统计/风险卡片、最近记录、3 个 Chart.js 图表、卡片跳转 |
| **列表页** | `renderList` :2860 + 筛选更新 :2807–2845 + 分页 :3161 | 按单/按明细双模式、筛选、批量、导入/导出入口 |
| **详情页** | `renderDetail` :3201 + 审批操作 :3257–3385 | 基本信息/明细/审批流/历史/时间/操作 |
| **表单（新建/编辑）** | `openRecordForm` :3349 / `submitForApproval` :4165 / `saveAsDraft` :4283 / 明细行 :3400+ | 新建/编辑 Modal、校验、审批流自动应用、草稿/提交 |
| **审批逻辑** | `executeApproval` :4390 / `renderApproval` :4481 / `doApproval` :4677 / `markItemProcessed` :4768 | 审批状态机、审批列表、通过/拒绝、明细处理标记 |
| **业务管理页** | products :5558 / customers :5811 / users :5900 / roles :6250 / approvalFlows :6661 / dictionaries :7023 | 各系统管理页 CRUD/导入导出/配置 |
| **核心数据模型与判定** | `normalizeProcessItem` :1810 / `itemProcessType/Progress` :1822 / `isPending*/isOverdue*` :2596–2607 / 常量 :1787–1809 | 处理类型/进度归一化、各类状态判定、映射常量 |
| **i18n 与权限** | `locales/i18n.js` 的 `t()` / `_PERM_CONFIG` :1260 / `hasPermission` :1751 / `canAccessPage` :1777 | 多语言、权限配置与校验 |
| **后端 API** | `server.js`（2332 行） | 全部路由、鉴权、`requireApiPermission`/`requireLogin`、飞书 OAuth、Webhook、附件、各资源 CRUD |
| **数据库** | `db.js`（409 行） | 表结构、初始化、迁移、**不可改** |
| **配置/部署** | `package.json` / `render.yaml` / `.env.example` / `manifest.json` / favicon | 版本号、Render 部署、环境变量、PWA 图标 |

**重构优先级建议**：
1. 先抽取 **i18n + 权限 + 数据模型/判定常量**（红线最多、被各处依赖，先固化契约）。
2. 再拆 **Layout/路由 + 各页面组件**（概览/列表/详情/表单/审批/管理页），把 `innerHTML` 字符串拼接改为组件化渲染。
3. 最后换 UI 库 / 设计系统（保持 `server.js` 接口契约与 `db.js` schema 不变）。

---

### 附：关键数据表字段速查（售后记录）

`aftersales_records`（核心表，JSONB `items`）：
- 头：`id, submitter_id, submitter_name, aftersales_date, status, brand, model, category, platforms(JSONB 文本), total_quantity, current_approval_level, approver_level1/2/3_id, approver_level1/2/3_name, approval_flow_id, approval_flow_name, approval_level1/2_status, approval_history(JSONB), created_at, updated_at`

`items[]` 单条明细字段（前端构造见 `submitForApproval` :4213 / import :5109）：
- `platform, shop_customer, sku_code, sn_code, order_no, quantity, return_reason, fault_description, process_type, process_progress, process_status, process_status_date, process_completed_date, return_stockin_date, erp_screenshots, process_logs`
