/*
 * schedule.js — 計画の分析（画面に依存しない純粋ロジック。core.js の後に読み込む）
 *
 *   Core.schedule    先行タスクと期限から、各タスクの「着手期限」と「余裕日数」を計算する
 *                    （クリティカルパス法 CPM。日数は土日を除いた稼働日、今日 = 0 日目）
 *   Core.matrix      緊急度 × 重要度（アイゼンハワー・マトリクス／7つの習慣の第1〜第4領域）
 *   Core.bottlenecks 後続を止めている・期限に間に合わない・担当が過負荷 のタスクを抽出
 *   Core.wbsTree / Core.rollup  大分類 > 中分類 > 小分類 の階層と、進捗・状況矢印の集計
 */
(function (root) {
  'use strict';
  const { Core } = root;

  /* ---------- 所要日数 ---------- */
  /** 難易度による所要日数の補正（不確実性のバッファ）。3=高 */
  Core.DIFF_FACTOR = { 1: 1, 2: 1.2, 3: 1.5 };
  Core.remainingHours = (t) => {
    if (t.status === 'done') return 0;
    const est = (t.estimate || 60) / 60;
    return est * (1 - Math.min(100, t.progress || 0) / 100);
  };
  /** 残りの所要稼働日数 = 残工数 × 難易度係数 ÷ 1日にそのタスクへ割ける時間（最低1日） */
  Core.durationDays = (t, settings) => {
    if (t.status === 'done') return 0;
    const perDay = (settings && settings.focusHours) || 3;
    return Math.max(1, Math.ceil((Core.remainingHours(t) * (Core.DIFF_FACTOR[t.difficulty || 2] || 1.2)) / perDay));
  };

  /* ---------- CPM ---------- */
  /**
   * 戻り値: Map(taskId → {
   *   duration, es, ef, lf, ls, float,    // 稼働日オフセット（今日=0）。期限なしは lf/ls/float = Infinity
   *   latestStart,                        // 着手期限（YYYY-MM-DD）。期限なしは null
   *   preds, succs, blockedBy, downstream // 先行・後続・未完了の先行・推移的な未完了の後続数
   * })
   */
  Core.schedule = (tasks, today, settings) => {
    const s = settings || {};
    const byKey = new Map();
    tasks.forEach((t) => { byKey.set(t.id, t); if (t.wbsId) byKey.set(String(t.wbsId), t); });
    const preds = new Map();
    const succs = new Map();
    tasks.forEach((t) => { preds.set(t.id, []); succs.set(t.id, []); });
    for (const t of tasks) {
      for (const d of t.deps || []) {
        const p = byKey.get(String(d));
        if (p && p.id !== t.id && !preds.get(t.id).includes(p)) {
          preds.get(t.id).push(p);
          succs.get(p.id).push(t);
        }
      }
    }
    const dur = new Map(tasks.map((t) => [t.id, Core.durationDays(t, s)]));

    const ef = new Map();
    const es = new Map();
    const visiting = new Set();
    const forward = (t) => {
      if (ef.has(t.id)) return ef.get(t.id);
      if (visiting.has(t.id) || t.status === 'done') return 0; // 循環参照・完了済みは制約にしない
      visiting.add(t.id);
      let start = 0;
      if (t.start && t.status === 'todo') start = Math.max(0, Core.workdayDiff(t.start, today));
      for (const p of preds.get(t.id)) start = Math.max(start, forward(p));
      visiting.delete(t.id);
      es.set(t.id, start);
      ef.set(t.id, start + dur.get(t.id));
      return start + dur.get(t.id);
    };

    const lf = new Map();
    const backward = (t) => {
      if (lf.has(t.id)) return lf.get(t.id);
      if (visiting.has(t.id)) return Infinity;
      visiting.add(t.id);
      // 期限日の終業までに終える = 期限日のオフセット + 1
      let f = t.due ? Core.workdayDiff(t.due, today) + 1 : Infinity;
      for (const c of succs.get(t.id)) {
        if (c.status === 'done') continue;
        f = Math.min(f, backward(c) - dur.get(c.id));
      }
      visiting.delete(t.id);
      lf.set(t.id, f);
      return f;
    };

    const countDownstream = (t) => {
      const seen = new Set();
      const stack = [...succs.get(t.id)];
      while (stack.length) {
        const c = stack.pop();
        if (seen.has(c.id) || c.id === t.id) continue;
        seen.add(c.id);
        if (c.status !== 'done') stack.push(...succs.get(c.id));
      }
      return [...seen].filter((id) => byKey.get(id).status !== 'done').length;
    };

    const out = new Map();
    for (const t of tasks) {
      if (t.status === 'done') {
        out.set(t.id, { duration: 0, es: 0, ef: 0, lf: Infinity, ls: Infinity, float: Infinity, latestStart: null, preds: preds.get(t.id), succs: succs.get(t.id), blockedBy: [], downstream: 0 });
        continue;
      }
      const e = forward(t);
      const f = backward(t);
      const d = dur.get(t.id);
      const ls = f - d;
      out.set(t.id, {
        duration: d, es: es.get(t.id) || 0, ef: e, lf: f, ls,
        float: Number.isFinite(f) ? ls - (es.get(t.id) || 0) : Infinity,
        latestStart: Number.isFinite(ls) ? Core.addWorkdays(today, ls) : null,
        preds: preds.get(t.id), succs: succs.get(t.id),
        blockedBy: preds.get(t.id).filter((p) => p.status !== 'done'),
        downstream: countDownstream(t),
      });
    }
    return out;
  };

  /* ---------- 緊急度 × 重要度 ---------- */
  /**
   * 横軸「重要度・難易度」: axis = 'both'（既定）なら 重要度×2 + 難易度 で 7 以上を重要とみなす
   *   （高×低=7 / 中×高=7 は重要、中×中=6 は重要でない）。axis = 'importance' なら重要度「高」のみ。
   * 縦軸「緊急度」: 突発 / 期限が明日まで / 着手期限までの余裕が urgentFloat 日以下 を緊急とみなす。
   *   → 期限が先でも、難しくて時間がかかるタスクは着手期限が早まるので緊急側に上がってくる。
   */
  Core.importanceWeight = (t) => (4 - (t.priority || 2)) * 2 + (t.difficulty || 2);
  Core.isImportant = (t, axis) => (axis === 'importance' ? t.priority === 1 : Core.importanceWeight(t) >= 7);

  Core.QUADRANTS = {
    q1: { name: '第1領域', tag: '緊急 × 重要', action: 'すぐやる', desc: '期限・着手期限が迫っている重要な仕事。先送りせず今日の最優先に。' },
    q2: { name: '第2領域', tag: '緊急でない × 重要', action: '計画して早めに着手', desc: 'ここに時間を使うほど第1領域の火消しが減る。難しいもの・長いものは今週中に手を付ける。' },
    q3: { name: '第3領域', tag: '緊急 × 重要でない', action: '短く済ませる・任せる', desc: '突発や依頼ごと。時間を区切るか、ほかの人に頼めないか考える。' },
    q4: { name: '第4領域', tag: '緊急でない × 重要でない', action: 'まとめて・やめる', desc: '空き時間にまとめて片付けるか、やめても困らないか見直す。' },
  };

  Core.matrix = (tasks, today, settings, axis, schedIn) => {
    const s = settings || {};
    const sched = schedIn || Core.schedule(tasks, today, s);
    const urgentFloat = s.urgentFloat ?? 1;
    const earlyFloat = s.earlyStartFloat ?? 10;
    const q = { q1: [], q2: [], q3: [], q4: [] };
    for (const t of tasks) {
      if (t.status === 'done') continue;
      const sc = sched.get(t.id);
      const dueIn = t.due ? Core.diffDays(t.due, today) : null;
      const reasons = [];
      if (t.interrupt) reasons.push('突発');
      if (dueIn !== null && dueIn < 0) reasons.push(`${-dueIn}日超過`);
      else if (dueIn !== null && dueIn <= 1) reasons.push(dueIn === 0 ? '今日期限' : '明日期限');
      if (sc && Number.isFinite(sc.float) && sc.float <= urgentFloat && !(dueIn !== null && dueIn <= 1)) {
        reasons.push(sc.float < 0 ? `着手が${-sc.float}日遅れ` : `着手期限 ${Core.formatDate(sc.latestStart)}`);
      }
      const urgent = reasons.length > 0;
      const important = Core.isImportant(t, axis);
      const early = !urgent && important && t.status === 'todo' && sc && Number.isFinite(sc.float)
        && (t.difficulty === 3 || sc.duration >= 3) && sc.float <= earlyFloat;
      const key = urgent ? (important ? 'q1' : 'q3') : (important ? 'q2' : 'q4');
      q[key].push({ task: t, sched: sc, urgent, important, early, reasons });
    }
    const f = (x) => (Number.isFinite(x.sched.float) ? x.sched.float : 9999);
    Object.values(q).forEach((arr) => arr.sort((a, b) => (b.early - a.early) || f(a) - f(b) || a.task.priority - b.task.priority));
    return { ...q, sched };
  };

  /* ---------- ボトルネック ---------- */
  Core.bottlenecks = (tasks, today, settings, schedIn) => {
    const s = settings || {};
    const sched = schedIn || Core.schedule(tasks, today, s);
    const horizon = 5;
    const me = s.myName || '自分';
    const capacity = Math.round(((s.capacityMin || 360) / 60) * horizon);

    // 担当別の負荷: 直近5稼働日に着手が必要（最早開始が5日以内かつ期限・着手期限が近い）残工数
    const loadMap = new Map();
    for (const t of tasks) {
      if (t.status === 'done' || t.status === 'waiting') continue;
      const sc = sched.get(t.id);
      if (!sc || sc.es >= horizon || !(Number.isFinite(sc.lf) && sc.lf <= horizon + 5)) continue;
      const owner = t.owner || me;
      loadMap.set(owner, (loadMap.get(owner) || 0) + Core.remainingHours(t));
    }
    const load = [...loadMap.entries()].map(([owner, hours]) => ({
      owner, hours: Math.round(hours * 10) / 10, capacity, pct: Math.round((hours / capacity) * 100),
    })).sort((a, b) => b.pct - a.pct);
    const over = new Map(load.filter((l) => l.pct > 100).map((l) => [l.owner, l.pct]));

    const items = [];
    for (const t of tasks) {
      if (t.status === 'done') continue;
      const sc = sched.get(t.id);
      let score = 0;
      const reasons = [];
      const overdue = t.due && Core.diffDays(t.due, today) < 0;
      if (sc.downstream) { score += 10 * sc.downstream; reasons.push(`後続${sc.downstream}件がこのタスクを待っている`); }
      if (overdue) { score += 30; reasons.push(`期限を${Core.diffDays(today, t.due)}日超過`); }
      else if (sc.float < 0) { score += 40; reasons.push(`このままだと期限に${-sc.float}日遅れる見込み`); }
      // 余裕が少ないだけの小さな作業は除き、後続がある・数日かかるものだけをクリティカルとみなす
      else if (sc.float <= 1 && (sc.downstream || sc.duration >= 2)) { score += 20; reasons.push(sc.float === 0 ? '余裕0日（クリティカル）' : '余裕1日'); }
      if (t.status === 'waiting' && sc.downstream) { score += 25; reasons.push(`${t.waitingFor ? `${t.waitingFor}さんの` : ''}回答待ちで後続が止まっている`); }
      const idle = Core.diffDays(today, (t.updatedAt || t.createdAt || today).slice(0, 10));
      if (t.status === 'doing' && idle >= (s.staleDays || 5) && sc.downstream) { score += 10; reasons.push(`${idle}日動きなし`); }
      if (t.difficulty === 3 && t.status === 'todo' && Number.isFinite(sc.float) && sc.float <= 5) { score += 10; reasons.push('難易度高・未着手'); }
      const owner = t.owner || me;
      // 過負荷は単独ではボトルネック扱いしない（ほかの理由があるときに上乗せ）
      if (over.has(owner) && sc.es < horizon && score > 0) { score += 5; reasons.push(`${owner}の直近5日の負荷 ${over.get(owner)}%`); }
      if (sc.blockedBy.length) reasons.push(`先行「${sc.blockedBy.map((p) => p.title).join('」「')}」が未完了`);
      if (score >= 20) items.push({ task: t, sched: sc, score, reasons });
    }
    items.sort((a, b) => b.score - a.score);
    return { items, load, capacity };
  };

  /* ---------- 階層と集計 ---------- */
  /** 大分類(area) > 中分類(category) > 小分類(l3) > タスク */
  Core.wbsTree = (tasks, categories, areas) => {
    const natural = (a, b) => String(a.wbsId || '~').localeCompare(String(b.wbsId || '~'), 'ja', { numeric: true }) || (a.due || '9').localeCompare(b.due || '9');
    const tree = [];
    for (const [areaId, areaName] of Object.entries(areas)) {
      const cats = categories.filter((c) => c.area === areaId).map((c) => {
        const own = tasks.filter((t) => t.categoryId === c.id);
        const groups = new Map();
        own.forEach((t) => {
          const k = t.l3 || '';
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(t);
        });
        const children = [...groups.entries()]
          .sort((a, b) => (a[0] === '') - (b[0] === '') || natural(a[1].slice().sort(natural)[0], b[1].slice().sort(natural)[0]))
          .map(([name, list]) => ({ type: 'l3', key: `${c.id}/${name}`, name: name || '（小分類なし）', tasks: list.sort(natural) }));
        return { type: 'l2', key: c.id, name: c.name, category: c, children, tasks: own };
      });
      tree.push({ type: 'l1', key: areaId, name: areaName, children: cats, tasks: cats.flatMap((c) => c.tasks) });
    }
    const orphan = tasks.filter((t) => !categories.some((c) => c.id === t.categoryId));
    if (orphan.length) tree.push({ type: 'l1', key: '_none', name: '未分類', children: [{ type: 'l2', key: '_none2', name: '未分類', children: [{ type: 'l3', key: '_none3', name: '（小分類なし）', tasks: orphan }], tasks: orphan }], tasks: orphan });
    return tree;
  };

  /**
   * 進捗と状況矢印の集計。
   *   actual   = 見積で重み付けした進捗率
   *   expected = 開始〜期限の経過割合から見た「今日時点であるべき進捗」
   *   trend: done（すべて完了）/ up（順調）/ flat（注意: 予定より5〜20pt遅れ・余裕1日以下）/ down（遅延: 20pt超の遅れ・期限超過・間に合わない見込み）
   */
  Core.rollup = (tasks, today, sched) => {
    let wSum = 0; let pSum = 0; let eW = 0; let eSum = 0;
    let overdue = 0; let late = 0; let done = 0; let minFloat = Infinity;
    let start = null; let end = null; let nextDue = null;
    for (const t of tasks) {
      const w = Math.max(0.5, (t.estimate || 60) / 60);
      const prog = t.status === 'done' ? 100 : Math.min(100, t.progress || 0);
      wSum += w; pSum += w * prog;
      if (t.status === 'done') done++;
      const s0 = t.start || (t.createdAt || '').slice(0, 10) || null;
      if (t.due) {
        const span = Math.max(1, Core.diffDays(t.due, s0 && s0 <= t.due ? s0 : t.due) + 1);
        const el = s0 ? Core.diffDays(today, s0) + 1 : 0;
        const exp = Math.max(0, Math.min(100, (el / span) * 100));
        eW += w; eSum += w * exp;
        if (t.status !== 'done' && Core.diffDays(t.due, today) < 0) overdue++;
        if (t.status !== 'done' && (!nextDue || t.due < nextDue)) nextDue = t.due;
      }
      const sc = sched && sched.get(t.id);
      if (sc && t.status !== 'done') {
        if (sc.float < minFloat) minFloat = sc.float;
        if (sc.float < 0 && !(t.due && Core.diffDays(t.due, today) < 0)) late++;
      }
      const a = t.start || t.due;
      const b = t.due || t.start;
      if (a && (!start || a < start)) start = a;
      if (b && (!end || b > end)) end = b;
    }
    const actual = wSum ? Math.round(pSum / wSum) : 0;
    const expected = eW ? Math.round(eSum / eW) : null;
    const gap = expected === null ? 0 : actual - expected;
    let trend = 'up';
    if (tasks.length && done === tasks.length) trend = 'done';
    else if (overdue || late || gap < -20) trend = 'down';
    else if (gap < -5 || minFloat <= 1) trend = 'flat';
    return { total: tasks.length, done, actual, expected, gap, overdue, late, minFloat, nextDue, start, end, trend };
  };
  Core.TREND = {
    up: { label: '順調', arrow: '↗' }, flat: { label: '注意', arrow: '→' }, down: { label: '遅延', arrow: '↘' }, done: { label: '完了', arrow: '✓' },
  };
})(typeof window !== 'undefined' ? window : globalThis);
