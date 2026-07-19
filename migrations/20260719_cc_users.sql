-- AFTERSALES-CC-01: 审批流 CC 抄送用户
-- 说明：
--   1) approval_flows.cc_users 存储该审批流配置的多选 CC 用户 [{id, name}]
--   2) aftersales_records.cc_users 存储记录提交时的 CC 用户快照（历史不变）
-- 幂等：可重复执行；重复运行安全（列已存在/已 NOT NULL 时均为 no-op）。
--
-- 字段约束（二.4）：
--   - JSONB 类型
--   - 默认 '[]'::jsonb
--   - 旧 NULL 回填为 '[]'::jsonb
--   - 最终 NOT NULL
--   - 不修改其他业务字段

-- approval_flows.cc_users
ALTER TABLE approval_flows ADD COLUMN IF NOT EXISTS cc_users JSONB DEFAULT '[]'::jsonb;
UPDATE approval_flows SET cc_users = '[]'::jsonb WHERE cc_users IS NULL;
ALTER TABLE approval_flows ALTER COLUMN cc_users SET DEFAULT '[]'::jsonb;
ALTER TABLE approval_flows ALTER COLUMN cc_users SET NOT NULL;

-- aftersales_records.cc_users
ALTER TABLE aftersales_records ADD COLUMN IF NOT EXISTS cc_users JSONB DEFAULT '[]'::jsonb;
UPDATE aftersales_records SET cc_users = '[]'::jsonb WHERE cc_users IS NULL;
ALTER TABLE aftersales_records ALTER COLUMN cc_users SET DEFAULT '[]'::jsonb;
ALTER TABLE aftersales_records ALTER COLUMN cc_users SET NOT NULL;

-- 为历史记录补齐索引（按用户 id 反查“抄送给我的”）
CREATE INDEX IF NOT EXISTS idx_records_cc_users ON aftersales_records USING gin (cc_users);
