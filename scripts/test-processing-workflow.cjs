'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');
const start = source.indexOf('function processingJsonObject');
const end = source.indexOf("app.get('/api/processing-requests'");
assert.ok(start >= 0 && end > start, 'processing helper block must exist');

const helperBlock = source.slice(start, end);
const api = new Function(
  helperBlock +
  '\nreturn { initializeProcessingExecution, processingOverallProgress, applyProcessingActionToItem };'
)();

const NOW = '2026-09-19T10:00:00.000Z';

function expectStatus(fn, status) {
  assert.throws(fn, err => err && err.status === status);
}

{
  const item = { quantity: 1 };
  api.initializeProcessingExecution(item, { type: 'resellable' }, NOW);
  assert.equal(item.asset_process_node, 'pending_erp');
  assert.equal(item.process_progress, 'pending');
  api.applyProcessingActionToItem(item, 'confirm_erp_inbound', { inbound_date: '2026-09-19' }, NOW);
  assert.equal(item.asset_process_node, 'completed');
  assert.equal(item.process_progress, 'completed');
}

{
  const item = { quantity: 1 };
  api.initializeProcessingExecution(item, { type: 'replace_now_repair_return' }, NOW);
  assert.equal(item.customer_process_node, 'pending_replacement');
  assert.equal(item.asset_process_node, 'pending_factory_shipment');

  api.applyProcessingActionToItem(item, 'ship_replacement', {
    ship_date: '2026-09-19',
    replacement_sku: 'M916',
    replacement_sn: 'NEW001'
  }, NOW);
  assert.equal(item.customer_process_node, 'completed');
  assert.equal(item.process_progress, 'processing');

  api.applyProcessingActionToItem(item, 'ship_to_factory', { ship_date: '2026-09-20' }, NOW);
  api.applyProcessingActionToItem(item, 'confirm_factory_received', { date: '2026-09-21' }, NOW);
  api.applyProcessingActionToItem(item, 'start_repair', { date: '2026-09-21' }, NOW);
  api.applyProcessingActionToItem(item, 'complete_repair', { date: '2026-09-24' }, NOW);
  assert.equal(item.asset_process_node, 'pending_warehouse_inbound');
  assert.equal(item.process_progress, 'processing');

  api.applyProcessingActionToItem(item, 'confirm_warehouse_inbound', { inbound_date: '2026-09-27' }, NOW);
  assert.equal(item.process_progress, 'completed');
}

{
  const item = { quantity: 1 };
  api.initializeProcessingExecution(item, { type: 'repair_send_customer' }, NOW);
  api.applyProcessingActionToItem(item, 'ship_to_factory', { ship_date: '2026-09-20' }, NOW);
  api.applyProcessingActionToItem(item, 'confirm_factory_received', { date: '2026-09-21' }, NOW);
  api.applyProcessingActionToItem(item, 'start_repair', { date: '2026-09-21' }, NOW);
  api.applyProcessingActionToItem(item, 'complete_repair', { date: '2026-09-24' }, NOW);
  assert.equal(item.asset_process_node, 'pending_customer_shipment');
  api.applyProcessingActionToItem(item, 'ship_repaired_to_customer', { ship_date: '2026-09-25' }, NOW);
  assert.equal(item.process_progress, 'completed');
}

expectStatus(
  () => api.applyProcessingActionToItem({ processing_approval_status: 'pending' }, 'ship_to_factory', { date: '2026-09-20' }, NOW),
  409
);

{
  const item = {};
  api.initializeProcessingExecution(item, { type: 'resellable' }, NOW);
  expectStatus(() => api.applyProcessingActionToItem(item, 'ship_to_factory', { date: '2026-09-20' }, NOW), 409);
}

// Return approval must not complete or otherwise mutate after-sales processing.
{
  const approvalStart = source.indexOf('const APPROVAL_LEGACY_STATUS_TO_PROCESS');
  const approvalEnd = source.indexOf('// 专用审批接口（修复 413');
  assert.ok(approvalStart >= 0 && approvalEnd > approvalStart, 'return approval helper block must exist');
  const approvalBlock = source.slice(approvalStart, approvalEnd);
  const approvalApi = new Function(approvalBlock + '\nreturn { applyApprovalTransition };')();

  const record = {
    status: '待一级审批',
    current_approval_level: 1,
    approver_level1_id: 'u1',
    approver_level2_id: '',
    approver_level3_id: '',
    approval_history: [],
    items: [
      { return_reason: '可二次销售', process_type: 'erp', process_progress: 'pending', process_status: '待ERP入库' },
      { return_reason: '硬件故障', process_type: 'rma', process_progress: 'pending', process_status: '待RMA' }
    ]
  };
  const beforeItems = JSON.stringify(record.items);
  const result = approvalApi.applyApprovalTransition(
    record,
    { action: 'approve', expected_level: 1, operator_name: 'Tester', comment: 'ok' },
    'u1'
  );
  assert.equal(result.record.status, '审批通过');
  assert.equal(result.record.current_approval_level, 0);
  assert.equal(JSON.stringify(result.record.items), beforeItems);
  assert.equal(result.itemsChanged, false);
}

console.log('processing-workflow tests passed');
