/**
 * 一次性存量数据修复脚本（治标）
 * --------------------------------------------------------------
 * 将符合条件的存量明细置为「已处理」：
 *   - record.status 为 已完成 / 审批通过 / completed
 *   - item 满足：process_type = erp / ERP入库  或  return_reason = 可二次销售 / resellable
 *   - 且 item.process_progress 为 pending / 空
 * 更新：process_progress='completed', process_status='已处理', process_completed_date=当前时间
 *
 * 不影响其他处理类型（待换彩盒 / 待补配件 / 待RMA / 待报废）。
 *
 * 用法：
 *   node scripts/fix_resellable_pending.js            # 真正执行更新
 *   node scripts/fix_resellable_pending.js --dry-run  # 只打印将要修改的记录，不写库
 *
 * 依赖 DATABASE_URL 环境变量（取自项目 .env）。
 */
const { query } = require('../db');

const DRY_RUN = process.argv.includes('--dry-run');
const COMPLETED_PROGRESS = 'completed';
const COMPLETED_STATUS = '已处理';

function isResellable(item){
  const rawType = (item.process_type || '').toString();
  const rawReason = (item.return_reason || '').toString();
  return rawType.toLowerCase() === 'erp'
      || rawType === 'ERP入库'
      || rawReason === '可二次销售'
      || rawReason.toLowerCase() === 'resellable';
}

function isPending(item){
  const p = (item.process_progress || '').toString();
  return p === 'pending' || p === '' || p === '待处理' || p === null || p === undefined;
}

function recordMatchable(rec){
  const s = (rec.status || '').toString();
  return s === '已完成' || s === '审批通过' || s.toLowerCase() === 'completed';
}

(async () => {
  const { rows } = await query(
    "SELECT id, status, items FROM aftersales_records WHERE status IN ('已完成','审批通过','completed') ORDER BY id ASC"
  );
  console.log(`匹配记录数(已完成/审批通过/completed): ${rows.length}`);

  let totalItems = 0, fixedItems = 0, fixedRecords = 0;

  for (const rec of rows){
    const items = Array.isArray(rec.items) ? rec.items : [];
    let changed = false;
    const completedDate = new Date().toISOString();
    const newItems = items.map(it => {
      totalItems++;
      if (isResellable(it) && isPending(it)){
        fixedItems++;
        changed = true;
        return {
          ...it,
          process_progress: COMPLETED_PROGRESS,
          process_status: COMPLETED_STATUS,
          process_completed_date: completedDate
        };
      }
      return it;
    });

    if (changed){
      fixedRecords++;
      if (DRY_RUN){
        console.log(`  [DRY-RUN] 将修复记录 id=${rec.id} status=${rec.status} (明细 ${newItems.length} 条)`);
      } else {
        await query(
          "UPDATE aftersales_records SET items=$1::jsonb, updated_at=$2 WHERE id=$3",
          [JSON.stringify(newItems), completedDate, rec.id]
        );
        console.log(`  已修复记录 id=${rec.id} status=${rec.status}`);
      }
    }
  }

  console.log(`完成: 扫描记录=${rows.length}, 修复记录=${fixedRecords}, 修复明细=${fixedItems}/${totalItems}`);
  console.log(DRY_RUN ? '（DRY-RUN 模式，未写入数据库）' : '（已写入数据库）');
})().catch(e => {
  console.error('ERR', e.message || e);
  process.exit(1);
});
