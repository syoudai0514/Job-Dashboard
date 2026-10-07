// WBS テンプレート（templates/WBS_template.xlsx）を作り直す: npm run template
// ダッシュボードの「WBS テンプレートを作成」と同じ Core.buildWbsWorkbook を使う。
const path = require('path');
const ExcelJS = require('exceljs');
require('../js/core.js');
require('../js/schedule.js');
require('../js/wbs-core.js');
const { Core } = globalThis;

const sample = [
  ['W-001', '業務', '生成AI導入', 'ガイドライン整備', 'Copilot社内利用ガイドライン案を作成', '', '1', '3', '', '2026-10-01', '2026-10-09', '8', '50', 'doing', '', '', ''],
  ['W-002', '業務', '生成AI導入', 'ガイドライン整備', '情シス・法務のレビュー', '田中', '2', '2', '', '', '2026-10-14', '3', '0', 'todo', 'W-001', '', ''],
  ['W-003', '業務', '標準化', 'コーディング規約', 'コーディング規約v2の公開', '', '2', '1', '', '', '2026-10-16', '1', '0', 'todo', '', '', ''],
  ['W-004', '自社作業', '育成関連', '新人育成', 'OJT計画の見直し', '', '2', '2', '', '', '2026-10-20', '2', '0', 'todo', '', '', ''],
];
const keys = ['wbsId', 'l1', 'l2', 'l3', 'title', 'owner', 'priority', 'difficulty', 'interrupt', 'start', 'due', 'estimateH', 'progress', 'status', 'deps', 'completedOn', 'notes'];
const records = sample.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i]])));

(async () => {
  const wb = Core.buildWbsWorkbook(ExcelJS, records);
  const out = path.join(__dirname, '..', 'templates', 'WBS_template.xlsx');
  await wb.xlsx.writeFile(out);
  console.log(`作成しました: ${out}`);
})();
