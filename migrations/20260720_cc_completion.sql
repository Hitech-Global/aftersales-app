-- AFTERSALES-CC-COMPLETION-01: 结束后抄送（最终审批通过触发）
-- 说明：
--   1) aftersales_records.cc_notify_on_completion 标识该记录是否启用“结束后 CC”
--      —— 仅新逻辑上线后首次提交的记录（非草稿且有审批流）为 true。
--   2) aftersales_records.cc_completion_notified_at 记录完成通知已发送时间；
--      非空即禁止重复发送（服务端原子 claim 幂等）。
--   3) aftersales_records.cc_completion_claimed_at 记录服务端原子 claim 时间；
--      仅当 flag=true、claimed_at IS NULL、notified_at IS NULL 时才写入，并发/重复请求只有一个获得。
-- 历史兼容（二.2 / 三.7）：旧记录三个时间字段均保持默认（flag=false，claimed_at/notified_at=NULL），
--   不触发新的完成通知，也不回填任何伪造时间值。
-- 幂等：可重复执行；不改写已有 cc_users 快照、不重写旧记录、不回填时间字段、不 DROP/TRUNCATE。
--
-- 字段约束：
--   - cc_notify_on_completion: BOOLEAN NOT NULL DEFAULT FALSE
--   - cc_completion_claimed_at: TIMESTAMPTZ NULL
--   - cc_completion_notified_at: TIMESTAMPTZ NULL

ALTER TABLE aftersales_records ADD COLUMN IF NOT EXISTS cc_notify_on_completion BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE aftersales_records ADD COLUMN IF NOT EXISTS cc_completion_claimed_at TIMESTAMPTZ;
ALTER TABLE aftersales_records ADD COLUMN IF NOT EXISTS cc_completion_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN aftersales_records.cc_notify_on_completion IS '新逻辑上线后提交=true；旧记录默认 false，不触发结束后抄送';
COMMENT ON COLUMN aftersales_records.cc_completion_claimed_at IS '服务端原子 claim 时间；写入即代表已尝试发送，最多一次';
COMMENT ON COLUMN aftersales_records.cc_completion_notified_at IS '完成后抄送通知已发送时间；非空即幂等禁止重复发送';
