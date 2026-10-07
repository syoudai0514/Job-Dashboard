// 実行: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/core.js');
require('../js/schedule.js');
require('../js/wbs-core.js');
const { Core } = globalThis;

const TODAY = '2026-10-06'; // 火曜
const S = { capacityMin: 360, focusHours: 3, urgentFloat: 2, earlyStartFloat: 10, staleDays: 5 };
const mk = (o) => ({ id: o.id, title: o.id, status: 'todo', priority: 2, difficulty: 2, progress: 0, deps: [], createdAt: TODAY, updatedAt: TODAY, ...o });

test('稼働日: 土日を飛ばして数える', () => {
  assert.equal(Core.workdayDiff('2026-10-12', TODAY), 4); // 水木金月
  assert.equal(Core.workdayDiff('2026-10-05', TODAY), -1);
  assert.equal(Core.addWorkdays(TODAY, 4), '2026-10-12');
  assert.equal(Core.endOfWeek(TODAY), '2026-10-09');
});

test('所要日数: 難易度高は1.5倍、進捗分は差し引く', () => {
  assert.equal(Core.durationDays(mk({ estimate: 360, difficulty: 2 }), S), 3); // 6h×1.2/3
  assert.equal(Core.durationDays(mk({ estimate: 360, difficulty: 3 }), S), 3); // 6h×1.5/3 = 3
  assert.equal(Core.durationDays(mk({ estimate: 600, difficulty: 3, progress: 50 }), S), 3); // 5h×1.5/3=2.5→3
});

test('CPM: 先行の遅れが後続の余裕を食う・後続数を数える', () => {
  const tasks = [
    mk({ id: 'a', wbsId: 'W-1', estimate: 360, due: '2026-10-08' }), // 3日
    mk({ id: 'b', wbsId: 'W-2', estimate: 360, due: '2026-10-12', deps: ['W-1'] }), // 3日、a の後
    mk({ id: 'c', wbsId: 'W-3', estimate: 60, deps: ['W-2'] }),
  ];
  const s = Core.schedule(tasks, TODAY, S);
  assert.equal(s.get('b').es, 3);
  assert.equal(s.get('b').lf, 5); // 10/12 = 4稼働日後 + 1
  assert.equal(s.get('b').float, -1); // 間に合わない
  assert.equal(s.get('a').lf, 2); // b の着手期限に引っ張られる
  assert.equal(s.get('a').downstream, 2);
  assert.deepEqual(s.get('b').blockedBy.map((t) => t.id), ['a']);
});

test('CPM: 循環参照でも止まらない', () => {
  const tasks = [mk({ id: 'a', wbsId: 'A', deps: ['B'], due: '2026-10-09' }), mk({ id: 'b', wbsId: 'B', deps: ['A'] })];
  const s = Core.schedule(tasks, TODAY, S);
  assert.ok(Number.isFinite(s.get('a').ef));
});

test('マトリクス: 期限が先でも重く難しいものは早期着手・余裕がなければ緊急', () => {
  const tasks = [
    mk({ id: 'early', priority: 1, difficulty: 3, estimate: 900, due: '2026-10-23' }), // 所要8日、余裕4日
    mk({ id: 'tight', priority: 2, difficulty: 3, estimate: 900, due: '2026-10-16' }), // 余裕0日 → 緊急
    mk({ id: 'small', priority: 3, difficulty: 1, estimate: 30, due: '2026-10-30' }),
    mk({ id: 'fire', priority: 3, interrupt: true }),
  ];
  const m = Core.matrix(tasks, TODAY, S, 'both');
  assert.deepEqual(m.q2.map((x) => x.task.id), ['early']);
  assert.ok(m.q2[0].early);
  assert.deepEqual(m.q1.map((x) => x.task.id), ['tight']); // 中×高=7 で重要
  assert.deepEqual(m.q3.map((x) => x.task.id), ['fire']);
  assert.deepEqual(m.q4.map((x) => x.task.id), ['small']);
  const m2 = Core.matrix(tasks, TODAY, S, 'importance');
  assert.deepEqual(m2.q3.map((x) => x.task.id).sort(), ['fire', 'tight']);
});

test('ボトルネック: 後続を止めている待ちタスクが上位', () => {
  const tasks = [
    mk({ id: 'w', wbsId: 'W-1', status: 'waiting', waitingFor: '佐藤', due: '2026-10-09' }),
    mk({ id: 'x', wbsId: 'W-2', deps: ['W-1'], due: '2026-10-20' }),
    mk({ id: 'y', wbsId: 'W-3', deps: ['W-2'], due: '2026-10-22' }),
    mk({ id: 'z', due: '2026-12-01' }),
  ];
  const b = Core.bottlenecks(tasks, TODAY, S);
  assert.equal(b.items[0].task.id, 'w');
  assert.ok(b.items[0].reasons.some((r) => /回答待ち/.test(r)));
  assert.ok(!b.items.some((i) => i.task.id === 'z'));
});

test('期限の山: 今日・今週・来週', () => {
  const tasks = [mk({ id: 'a', due: TODAY }), mk({ id: 'b', due: '2026-10-09' }), mk({ id: 'c', due: '2026-10-14' }), mk({ id: 'd', due: '2026-10-01' })];
  const b = Core.deadlineBuckets(tasks, TODAY);
  assert.deepEqual(b.today.map((t) => t.id), ['a']);
  assert.deepEqual(b.week.map((t) => t.id), ['a', 'b']);
  assert.deepEqual(b.nextWeek.map((t) => t.id), ['c']);
  assert.deepEqual(b.overdue.map((t) => t.id), ['d']);
});

test('集計: 遅れていれば矢印が下向き', () => {
  const tasks = [
    mk({ id: 'a', start: '2026-09-28', due: '2026-10-08', progress: 10, estimate: 600 }),
    mk({ id: 'b', status: 'done', progress: 100, estimate: 60 }),
  ];
  const r = Core.rollup(tasks, TODAY, Core.schedule(tasks, TODAY, S));
  assert.equal(r.trend, 'down');
  assert.equal(r.done, 1);
  const allDone = Core.rollup([tasks[1]], TODAY, null);
  assert.equal(allDone.trend, 'done');
});

test('見出しの対応づけ: 表記ゆれ・列順は自由', () => {
  const map = Core.mapHeaders(['No.', 'タスク名', '大項目', '担当者', '期日', '進捗率', 'ステータス', 'メモ欄', '先行']);
  assert.equal(map.wbsId, 0);
  assert.equal(map.title, 1);
  assert.equal(map.l1, 2);
  assert.equal(map.due, 4);
  assert.equal(map.progress, 5);
  assert.equal(map.status, 6);
  assert.equal(map.notes, 7);
  assert.equal(map.deps, 8);
});

test('セル値の正規化', () => {
  assert.equal(Core.parseWbsCell('due', new Date(Date.UTC(2026, 9, 15))), '2026-10-15');
  assert.equal(Core.parseWbsCell('due', '2026/10/5'), '2026-10-05');
  assert.equal(Core.parseWbsCell('due', 46310), '2026-10-15');
  assert.equal(Core.parseWbsCell('priority', '高'), '1');
  assert.equal(Core.parseWbsCell('difficulty', '高'), '3');
  assert.equal(Core.parseWbsCell('progress', 0.5), '50');
  assert.equal(Core.parseWbsCell('progress', '80%'), '80');
  assert.equal(Core.parseWbsCell('status', '着手中'), 'doing');
  assert.equal(Core.parseWbsCell('status', '済'), 'done');
  assert.equal(Core.parseWbsCell('interrupt', '○'), '1');
  assert.equal(Core.parseWbsCell('deps', 'W-2、W-1'), 'W-1,W-2');
});

test('行の読み取り: 分類の空欄は上を引き継ぎ、見出し行は飛ばす', () => {
  const rows = Core.readWbsRows([
    { rowNumber: 2, cells: { l1: '業務', l2: '標準化', l3: '規約', title: '' } },
    { rowNumber: 3, cells: { title: '規約レビュー', progress: 100 } },
    { rowNumber: 4, cells: { l3: 'テンプレ', title: 'テンプレ統一', progress: 30 } },
    { rowNumber: 5, cells: { l2: '開発推進', title: 'CI選定' } },
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].rec.l1, rows[0].rec.l2, rows[0].rec.l3, rows[0].rec.status], ['業務', '標準化', '規約', 'done']);
  assert.equal(rows[1].rec.l3, 'テンプレ');
  assert.equal(rows[1].rec.status, 'doing');
  assert.ok(rows[1].inherited.l2 && !rows[1].inherited.l3);
  assert.equal(rows[2].rec.l3, ''); // 中分類が変わったら小分類は引き継がない
});

test('3方向マージ: 変わった側を採用、両方なら実行系はダッシュボード優先', () => {
  const base = { title: 'A', due: '2026-10-10', status: 'todo', progress: '0' };
  const ex = { title: 'A2', due: '2026-10-12', status: 'todo', progress: '0' };
  const da = { title: 'A', due: '2026-10-11', status: 'doing', progress: '50' };
  const m = Core.mergeRecord(ex, da, base, ['title', 'due', 'status', 'progress']);
  assert.deepEqual(m.toTask.sort(), ['due', 'title']);
  assert.deepEqual(m.toExcel.sort(), ['progress', 'status']);
  assert.equal(m.merged.due, '2026-10-12'); // 両方変更 → 計画系は Excel
  assert.equal(m.conflicts.length, 1);
});

test('レコード↔タスク: 往復しても変わらない', () => {
  const cats = Core.DEFAULT_CATEGORIES;
  const task = mk({ id: 't', wbsId: 'W-9', categoryId: 'std', l3: '規約', title: '規約公開', priority: 1, difficulty: 3, interrupt: true, due: '2026-10-20', estimate: 90, progress: 40, status: 'doing', deps: ['W-2', 'W-1'], owner: '田中', notes: 'メモ' });
  const rec = Core.recordFromTask(task, cats, Core.AREAS);
  assert.equal(rec.l1, '業務');
  assert.equal(rec.estimateH, '1.5');
  assert.equal(rec.deps, 'W-1,W-2');
  const patch = Core.taskPatchFromRecord(rec, Core.WBS_SYNC_KEYS, (l1, l2) => cats.find((c) => Core.AREAS[c.area] === l1 && c.name === l2).id, task);
  const again = Core.recordFromTask({ ...task, ...patch }, cats, Core.AREAS);
  assert.deepEqual(again, rec);
});

test('採番: W-### の続き番号', () => {
  assert.equal(Core.nextWbsId(new Set(['W-001', 'W-010', '1.2'])), 'W-011');
});

test('テンプレート: ExcelJS で書いて読み戻せる', async (t) => {
  let ExcelJS;
  try { ExcelJS = require('exceljs'); } catch (e) { t.skip('exceljs 未インストール（npm install で入ります）'); return; }
  const rec = Core.recordFromTask(mk({ id: 't', wbsId: 'W-001', categoryId: 'ai', title: 'ガイドライン', due: '2026-10-20', priority: 1 }), Core.DEFAULT_CATEGORIES, Core.AREAS);
  const wb = Core.buildWbsWorkbook(ExcelJS, [rec]);
  const buf = await wb.xlsx.writeBuffer();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(buf);
  const ws = wb2.getWorksheet('WBS');
  const header = ws.getRow(1).values.slice(1);
  const map = Core.mapHeaders(header);
  const row = ws.getRow(2);
  assert.equal(row.getCell(map.title + 1).value, 'ガイドライン');
  assert.equal(Core.parseWbsCell('due', row.getCell(map.due + 1).value), '2026-10-20');
  assert.equal(row.getCell(map.priority + 1).value, '高');
});
