-- AFTERSALES-COUNTRY-01: 售后记录国家
-- 规则：固定支持 ID / MY / TH / SG；历史记录统一回填 ID。
-- 幂等：可重复执行，不覆盖已有非空国家值，不删除/重算任何售后业务数据。

ALTER TABLE aftersales_records
  ADD COLUMN IF NOT EXISTS country VARCHAR(8) DEFAULT 'ID';

UPDATE aftersales_records
SET country = 'ID'
WHERE country IS NULL OR BTRIM(country) = '';

ALTER TABLE aftersales_records
  ALTER COLUMN country SET DEFAULT 'ID';

ALTER TABLE aftersales_records
  ALTER COLUMN country SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_records_country
  ON aftersales_records(country);
