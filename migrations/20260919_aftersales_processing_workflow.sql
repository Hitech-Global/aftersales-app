-- 2026-09-19
-- 售后处理工作流：退货审批与处理审批分离。
-- 本文件仅定义幂等 schema migration；当前 feature branch 不执行生产迁移。

BEGIN;

ALTER TABLE approval_flows
  ADD COLUMN IF NOT EXISTS flow_type VARCHAR(32) NOT NULL DEFAULT 'return_approval';

UPDATE approval_flows
SET flow_type = 'return_approval'
WHERE flow_type IS NULL OR flow_type = '';

ALTER TABLE aftersales_records
  ADD COLUMN IF NOT EXISTS process_logs JSONB DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS aftersales_processing_requests (
  id VARCHAR(64) PRIMARY KEY,
  flow_id VARCHAR(64) DEFAULT '',
  flow_name VARCHAR(255) DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  current_approval_level INTEGER NOT NULL DEFAULT 0,
  approver_level1_id VARCHAR(64) DEFAULT '',
  approver_level1_name VARCHAR(128) DEFAULT '',
  approver_level2_id VARCHAR(64) DEFAULT '',
  approver_level2_name VARCHAR(128) DEFAULT '',
  approver_level3_id VARCHAR(64) DEFAULT '',
  approver_level3_name VARCHAR(128) DEFAULT '',
  flow_nodes JSONB DEFAULT '[]'::jsonb,
  item_refs JSONB DEFAULT '[]'::jsonb,
  plan JSONB DEFAULT '{}'::jsonb,
  approval_history JSONB DEFAULT '[]'::jsonb,
  submitter_id VARCHAR(64) DEFAULT '',
  submitter_name VARCHAR(128) DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_flows_type
  ON approval_flows(flow_type, enabled);

CREATE INDEX IF NOT EXISTS idx_processing_requests_status
  ON aftersales_processing_requests(status, current_approval_level);

CREATE INDEX IF NOT EXISTS idx_processing_requests_created
  ON aftersales_processing_requests(created_at DESC);

COMMIT;
