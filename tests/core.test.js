// 実行: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/core.js');
const { Core } = globalThis;

const cats = Core.DEFAULT_CATEGORIES;
const TODAY = '2026-10-06'; // 火曜

test('クイック入力: 日付・優先・見積・関係者・区分推定', () => {
  const r = Core.parseQuickAdd('明日 コーディング規約のレビュー !高 30分 @佐藤', TODAY, cats);
  assert.equal(r.title, 'コーディング規約のレビュー');
  assert.equal(r.due, '2026-10-07');
  assert.equal(r.priority, 1);
  assert.equal(r.estimate, 30);
  assert.deepEqual(r.people, ['佐藤']);
  assert.equal(r.categoryId, 'std'); // 「規約」の方が「レビュー」より長く一致
});

test('クイック入力: 曜日・来週・日付・#区分', () => {
  assert.equal(Core.parseQuickAdd('金曜 交通費精算', TODAY, cats).due, '2026-10-09');
  assert.equal(Core.parseQuickAdd('来週火曜 研修', TODAY, cats).due, '2026-10-13');
  assert.equal(Core.parseQuickAdd('10/20 資料', TODAY, cats).due, '2026-10-20');
  assert.equal(Core.parseQuickAdd('1/10 予算', TODAY, cats).due, '2027-01-10');
  assert.equal(Core.parseQuickAdd('月末 見込', TODAY, cats).due, '2026-10-31');
  const r = Core.parseQuickAdd('資料まとめ #育成関連 1.5h', TODAY, cats);
  assert.equal(r.categoryId, 'edu');
  assert.equal(r.estimate, 90);
  assert.equal(r.title, '資料まとめ');
});

test('区分推定: 「社内定例」は自社作業の定例', () => {
  assert.equal(Core.guessCategory('社内定例の議事録', cats).id, 'own-routine');
  assert.equal(Core.guessCategory('週次定例の資料', cats).id, 'work-routine');
});

test('スコア: 期限超過 > 今日締切 > 期限なし', () => {
  const base = { status: 'todo', priority: 2, createdAt: TODAY, updatedAt: TODAY };
  const over = Core.scoreTask({ ...base, due: '2026-10-04' }, TODAY, {}).score;
  const today = Core.scoreTask({ ...base, due: TODAY }, TODAY, {}).score;
  const none = Core.scoreTask({ ...base }, TODAY, {}).score;
  assert.ok(over > today && today > none);
});

test('今日の計画: 容量内に収め、超過・ピンは必ず入れる', () => {
  const mk = (id, o) => ({ id, status: 'todo', priority: 2, estimate: 120, createdAt: TODAY, updatedAt: TODAY, ...o });
  const tasks = [
    mk('a', { due: '2026-10-01' }), mk('b', { priority: 1, due: '2026-10-07' }),
    mk('c', { priority: 1, due: '2026-10-08' }), mk('d', { todayPin: TODAY, priority: 3 }),
    mk('w', { status: 'waiting' }),
  ];
  const p = Core.planToday(tasks, TODAY, { capacityMin: 300 });
  const ids = p.focus.map((i) => i.task.id);
  assert.equal(ids[0], 'd');
  assert.ok(ids.includes('a'));
  assert.equal(p.waiting.length, 1);
  assert.ok(p.minutes >= 240);
});

test('定例: 平日 / 毎週 / 月末', () => {
  assert.equal(Core.routineDueOn({ freq: 'weekday' }, '2026-10-10'), false); // 土
  assert.equal(Core.routineDueOn({ freq: 'weekly', day: 2 }, TODAY), true);
  assert.equal(Core.routineDueOn({ freq: 'monthly', day: 31 }, '2026-09-30'), true);
});

test('フォロー: 超過・待ち・停滞を検出し、重い順に並ぶ', () => {
  const tasks = [
    { id: 'x', title: 'X', status: 'waiting', priority: 2, createdAt: '2026-09-01', updatedAt: '2026-10-01', categoryId: 'ai' },
    { id: 'y', title: 'Y', status: 'todo', priority: 2, due: '2026-10-05', createdAt: TODAY, categoryId: 'std' },
    { id: 'z', title: 'Z', status: 'doing', priority: 2, createdAt: '2026-09-01', updatedAt: '2026-09-20', categoryId: 'dev' },
  ];
  const f = Core.followUps(tasks, TODAY, { waitingDays: 3, staleDays: 5 }, cats);
  assert.equal(f[0].id, 'overdue:y');
  assert.ok(f.some((i) => i.id.startsWith('waiting:x')));
  assert.ok(f.some((i) => i.id.startsWith('stale:z')));
  assert.ok(f.some((i) => i.id.startsWith('quiet:edu')));
});

test('AI回答の解析: コードブロック内のJSONと本文を分離', () => {
  const text = 'まずは超過分から片付けましょう。\n```json\n{"order":[{"id":"a","reason":"超過"}],"defer":[{"id":"b","newDue":"2026-10-09","reason":"余裕あり"}]}\n```';
  const { data, prose } = Core.extractJSON(text);
  assert.equal(data.order[0].id, 'a');
  assert.equal(prose, 'まずは超過分から片付けましょう。');
  const props = Core.proposalsFrom('plan', data, { tasks: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], categories: cats, today: TODAY });
  assert.deepEqual(props.map((p) => p.kind), ['pin', 'due']);
});

test('AI回答の解析: 囲みなしJSON / 抽出タスクの区分解決', () => {
  const { data } = Core.extractJSON('以下です {"tasks":[{"title":"予算案を作る","category":"自社作業/業績管理","priority":1,"due":"2026-10-10"}]}');
  const props = Core.proposalsFrom('extract', data, { tasks: [], categories: cats, today: TODAY });
  assert.equal(props[0].payload.categoryId, 'perf');
  assert.equal(props[0].payload.priority, 1);
});

test('プロンプト生成: 各モードで JSON 形式の指示を含む', () => {
  const ctx = { today: TODAY, tasks: [], categories: cats, settings: {}, text: 'メモ', task: { id: 't', title: 'T', status: 'todo', priority: 2 } };
  for (const m of Object.keys(Core.AI_MODES)) {
    const p = Core.buildPrompt(m, ctx);
    assert.match(p.user, /```json/);
  }
});
