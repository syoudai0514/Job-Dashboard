// 実行: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/core.js');
require('../js/schedule.js');
require('../js/wbs-core.js');
require('../js/sources-core.js');
const { Core } = globalThis;

const TODAY = '2026-10-06';
const cats = Core.DEFAULT_CATEGORIES;
const ctx = { categories: cats, areas: Core.AREAS, myName: '山田' };
const R = (o) => ({ wbsId: '', l1: '業務', l2: '開発推進', l3: 'CI', title: '', owner: '山田', priority: '2', difficulty: '2', interrupt: '', start: '', due: '', estimateH: '', progress: '0', status: 'todo', deps: '', completedOn: '', notes: '', origin: '', ...o });
const linkedTask = (rec, extra) => ({
  id: `t-${rec.wbsId}`, title: rec.title, categoryId: 'dev', l3: rec.l3, owner: rec.owner, priority: Number(rec.priority), difficulty: Number(rec.difficulty),
  interrupt: false, start: rec.start || null, due: rec.due || null, estimate: rec.estimateH ? Number(rec.estimateH) * 60 : null,
  progress: Number(rec.progress), status: rec.status, deps: [], notes: '', createdAt: TODAY, updatedAt: TODAY,
  src: { sourceId: 's1', id: rec.wbsId, label: `開発:${rec.wbsId}`, base: { ...rec }, deps: rec.deps ? rec.deps.split(',') : [] },
  ...extra,
});
const source = { id: 's1', name: '開発', mode: 'read', scope: 'mine', dismissed: [] };

test('担当の判定: 複数担当・敬称つきも自分とみなす', () => {
  assert.ok(Core.ownerIncludes('佐藤・山田', '山田'));
  assert.ok(Core.ownerIncludes('山田(主)', '山田'));
  assert.ok(!Core.ownerIncludes('鈴木', '山田'));
  assert.ok(!Core.isMine(R({ owner: '' }), source, '山田'));
  assert.ok(Core.isMine(R({ owner: '' }), { ...source, includeUnassigned: true }, '山田'));
});

test('取り込み候補: 自分担当・未取込・未無視・未完了だけ', () => {
  const recs = [R({ wbsId: 'D-1', title: 'A' }), R({ wbsId: 'D-2', title: 'B' }), R({ wbsId: 'D-3', title: 'C', owner: '鈴木' }), R({ wbsId: 'D-4', title: 'D' }), R({ wbsId: 'D-5', title: 'E', status: 'done' })];
  const tasks = [linkedTask(recs[0])];
  const inbox = Core.sourceInbox(recs, tasks, { ...source, dismissed: ['D-4'] }, '山田');
  assert.deepEqual(inbox.map((r) => r.wbsId), ['D-2']);
});

test('チームWBSの期限変更は個人に反映、個人の進捗は読み取りのみなら書き戻さない', () => {
  const rec = R({ wbsId: 'D-1', title: 'A', due: '2026-10-12' });
  const task = linkedTask(rec, { progress: 40, status: 'doing' });
  const changed = { ...rec, due: '2026-10-09' };
  const res = Core.reconcileSource([changed], [task], source, ctx);
  const u = res.updates[0];
  assert.deepEqual(u.toTask, ['due']);
  assert.deepEqual(u.toSource, []);
  assert.equal(u.changes[0].to, '2026-10-09');
});

test('書き戻し権限ありなら、個人の進捗・状態をチームWBSへ', () => {
  const rec = R({ wbsId: 'D-1', title: 'A', due: '2026-10-12' });
  const task = linkedTask(rec, { progress: 40, status: 'doing' });
  const res = Core.reconcileSource([rec], [task], { ...source, mode: 'write' }, ctx);
  assert.deepEqual(res.updates[0].toSource.sort(), ['progress', 'status']);
});

test('個人で変えた期限は、チームWBSでその項目が変わるまで残す', () => {
  const rec = R({ wbsId: 'D-1', title: 'A', due: '2026-10-12' });
  const task = linkedTask(rec, { due: '2026-10-09' }); // 自分の目標を前倒し
  assert.equal(Core.reconcileSource([rec], [task], source, ctx).updates.length, 0);
  const res = Core.reconcileSource([{ ...rec, due: '2026-10-15' }], [task], source, ctx);
  assert.equal(res.updates[0].merged.due, '2026-10-15'); // 両方変わったらチームWBSが勝つ
});

test('チームWBSで消えた・担当が外れたタスクを検出', () => {
  const a = R({ wbsId: 'D-1', title: 'A' });
  const b = R({ wbsId: 'D-2', title: 'B' });
  const res = Core.reconcileSource([{ ...b, owner: '鈴木' }], [linkedTask(a), linkedTask(b)], source, ctx);
  assert.deepEqual(res.removed, ['t-D-1']);
  assert.deepEqual(res.reassigned, ['t-D-2']);
});

test('先行IDの付け替え: 取り込み済みのタスク同士だけつなぐ', () => {
  const a = linkedTask(R({ wbsId: 'D-1', title: 'A' }), { wbsId: 'W-010' });
  const b = linkedTask(R({ wbsId: 'D-2', title: 'B', deps: 'D-1,D-9' }));
  assert.deepEqual(Core.mapSourceDeps(b, [a, b]), ['W-010']);
});

test('上流の遅延: 他の人の先行タスクの超過・待ち・期限の食い込み', () => {
  const rows = [
    R({ wbsId: 'D-1', title: '環境払い出し', owner: '鈴木', due: '2026-10-02', status: 'doing' }),
    R({ wbsId: 'D-2', title: '構築', due: '2026-10-09', estimateH: '9', deps: 'D-1' }),
    R({ wbsId: 'D-3', title: 'API仕様', owner: '高橋', due: '2026-10-20' }),
    R({ wbsId: 'D-4', title: '結合', due: '2026-10-21', estimateH: '6', deps: 'D-3' }),
  ];
  const tasks = [linkedTask(rows[1]), linkedTask(rows[3])];
  const issues = Core.upstreamIssues(tasks, [{ id: 's1', name: '開発', rows }], TODAY, Core.schedule(tasks, TODAY, {}));
  assert.equal(issues.length, 2);
  assert.equal(issues[0].level, 'critical');
  assert.match(issues[0].text, /鈴木さん担当.*4日過ぎ/);
  assert.match(issues[1].text, /着手期限/);
});

test('チーム全体の状況: 遅延タスクと担当別の件数', () => {
  const rows = [
    R({ wbsId: 'D-1', title: 'A', owner: '鈴木', due: '2026-10-01' }),
    R({ wbsId: 'D-2', title: 'B', owner: '山田', due: '2026-10-30' }),
    R({ wbsId: 'D-3', title: 'C', owner: '鈴木', status: 'done', progress: '100' }),
  ];
  const o = Core.teamOverview(rows, TODAY, {});
  assert.equal(o.late.length, 1);
  assert.equal(o.owners[0].owner, '鈴木');
  assert.equal(o.owners[0].late, 1);
  assert.equal(o.tree[0].rollup.trend, 'down');
});

test('ID の採番は既存の書式に合わせる', () => {
  assert.equal(Core.nextIdLike(['D-001', 'D-014', 'X1']), 'D-015');
  assert.equal(Core.nextIdLike(['G-01', 'G-06']), 'G-07');
  assert.equal(Core.nextIdLike([]), 'W-001');
});

test('追加依頼文に必要な情報が入る', () => {
  const t = { title: '負荷試験の計画', categoryId: 'dev', l3: '性能', due: '2026-10-20', estimate: 240, priority: 1, difficulty: 3, status: 'todo', progress: 0, deps: [] };
  const text = Core.addRequestText(t, { name: '開発部 共通WBS' }, cats, Core.AREAS, '山田');
  assert.match(text, /開発部 共通WBS/);
  assert.match(text, /負荷試験の計画/);
  assert.match(text, /4h/);
});
