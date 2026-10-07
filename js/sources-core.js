/*
 * sources-core.js — チームWBS（取込元）と個人タスクの対応づけ（画面・ファイルに依存しない純粋ロジック）
 *
 * 3層の考え方
 *   チームWBS（複数可）… 上位者が計画を決める「計画の正」。ダッシュボードは常に読み取る
 *   個人WBS / ダッシュボード … 自分の実行を管理する。チームWBSから自分のタスクを取り込む
 *   AI … 差分・遅延を読んで、影響と打ち手、報告文を提案する（反映するかは人が決める）
 *
 * 項目ごとの決まり
 *   計画の項目（タスク名・分類・期限・開始・見積・重要度・難易度・担当）… チームWBSで変わったら個人に反映。
 *     個人側で独自に変えた値は、チームWBSでその項目が変わるまで残す（両方で変わったらチームWBSが勝つ）
 *   実行の項目（状態・進捗・完了日）… 個人で更新する。書き戻し権限（mode = 'write'）があればチームWBSにも書く
 *   先行タスク … チームWBSの ID で持ち、取り込み済みのタスク同士は個人側でもつなぐ
 */
(function (root) {
  'use strict';
  const { Core } = root;

  Core.SOURCE_PLAN_KEYS = ['l1', 'l2', 'l3', 'title', 'owner', 'priority', 'difficulty', 'interrupt', 'start', 'due', 'estimateH'];
  Core.SOURCE_EXEC_KEYS = ['status', 'progress', 'completedOn'];

  const norm = (s) => String(s || '').replace(/[\s　]/g, '').toLowerCase();
  /** 担当欄に自分の名前が含まれるか（「佐藤・田中」「佐藤(主)」なども可） */
  Core.ownerIncludes = (owner, myName) => {
    if (!myName) return false;
    const o = norm(owner);
    return o.split(/[、,，/／・&＆]/).some((x) => x && (x === norm(myName) || x.startsWith(norm(myName))));
  };
  /** そのレコードが取り込み対象か。scope: 'mine'（自分担当）/ 'all'（全件） */
  Core.isMine = (rec, source, myName) => {
    if (source.scope === 'all') return true;
    if (!rec.owner) return !!source.includeUnassigned;
    return Core.ownerIncludes(rec.owner, myName);
  };

  /** 既存 ID の書式（D-012 など）に合わせて次の ID を作る */
  Core.nextIdLike = (existing) => {
    const counts = new Map();
    for (const id of existing) {
      const m = String(id).match(/^([A-Za-z]+[-_]?)(\d+)$/);
      if (m) {
        const c = counts.get(m[1]) || { n: 0, max: 0, width: 1 };
        c.n++; c.max = Math.max(c.max, Number(m[2])); c.width = Math.max(c.width, m[2].length);
        counts.set(m[1], c);
      }
    }
    if (!counts.size) return Core.nextWbsId(existing);
    const [prefix, c] = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    return `${prefix}${String(c.max + 1).padStart(c.width, '0')}`;
  };

  /** 取り込み候補: 自分担当（または全件）で、まだ取り込んでいない・無視していない行 */
  Core.sourceInbox = (records, tasks, source, myName) => {
    const linkedIds = new Set(tasks.filter((t) => t.src && t.src.sourceId === source.id).map((t) => String(t.src.id)));
    const dismissed = new Set(source.dismissed || []);
    return records.filter((r) => r.wbsId && r.status !== 'done' && !linkedIds.has(String(r.wbsId)) && !dismissed.has(String(r.wbsId)) && Core.isMine(r, source, myName));
  };

  /** タスクのレコード（比較用）。取り込み元の先行 ID は task.src.deps */
  const label = (rec) => `${rec.wbsId} ${rec.title}`;

  /**
   * チームWBSを読んだ結果と、個人タスクを突き合わせる。
   *   records: Core.readWbsRows(...).map(r => r.rec)
   *   source: { id, name, mode, scope, includeUnassigned, dismissed: [id] }
   * 戻り値:
   *   inbox      … 取り込み候補（自分担当で、まだ取り込んでいない・無視していない）
   *   updates    … [{ taskId, toTask: [key], toSource: [key], merged, rec, changes: [{ key, from, to }] }]
   *   removed    … チームWBSから消えたタスク
   *   reassigned … 担当が自分から外れたタスク
   */
  Core.reconcileSource = (records, tasks, source, ctx) => {
    const { categories, areas, myName } = ctx;
    const byId = new Map(records.map((r) => [String(r.wbsId), r]));
    const linked = tasks.filter((t) => t.src && t.src.sourceId === source.id);
    const inbox = Core.sourceInbox(records, tasks, source, myName);
    const updates = [];
    const removed = [];
    const reassigned = [];
    const writable = source.mode === 'write';
    for (const t of linked) {
      const rec = byId.get(String(t.src.id));
      if (!rec) { removed.push(t.id); continue; }
      const da = Core.recordFromTask(t, categories, areas);
      const base = t.src.base || null;
      const toTask = [];
      const toSource = [];
      const merged = {};
      const changes = [];
      for (const k of [...Core.SOURCE_PLAN_KEYS, ...Core.SOURCE_EXEC_KEYS]) {
        const e = rec[k] ?? '';
        const d = da[k] ?? '';
        const b = base ? (base[k] ?? '') : undefined;
        if (e === d) { merged[k] = e; continue; }
        const sourceChanged = b === undefined || e !== b;
        const dashChanged = b !== undefined && d !== b;
        const isExec = Core.SOURCE_EXEC_KEYS.includes(k);
        if (sourceChanged && (!dashChanged || !isExec)) {
          // チームWBSが変わった（計画の項目は両方変わってもチームWBSが勝つ）
          merged[k] = e; toTask.push(k); changes.push({ key: k, from: d, to: e });
        } else if (isExec && dashChanged && writable) {
          merged[k] = d; toSource.push(k);
        } else {
          merged[k] = d; // 個人だけの変更（読み取りのみの取込元、または個人で上書きした計画）
        }
      }
      if (source.scope !== 'all' && rec.owner && !Core.ownerIncludes(rec.owner, myName)) reassigned.push(t.id);
      const depsChanged = (t.src.deps || []).slice().sort().join(',') !== (rec.deps || '');
      if (toTask.length || toSource.length || depsChanged) updates.push({ taskId: t.id, toTask, toSource, merged, rec, changes, depsChanged });
    }
    return { inbox, updates, removed, reassigned };
  };

  /** 取り込み元の先行 ID を、取り込み済みの個人タスクのキー（wbsId か id）に置き換える */
  Core.mapSourceDeps = (task, tasks) => {
    if (!task.src) return task.deps || [];
    return (task.src.deps || []).map((d) => {
      const t = tasks.find((x) => x.src && x.src.sourceId === task.src.sourceId && String(x.src.id) === String(d));
      return t ? (t.wbsId || t.id) : null;
    }).filter(Boolean);
  };

  /**
   * 上流の問題: 取り込んだタスクの先行（他の人の担当を含む）が遅れている / 期限が自分の着手期限より後
   * sources: [{ id, name, rows: [rec] }]
   */
  Core.upstreamIssues = (tasks, sources, today, sched) => {
    const out = [];
    for (const t of tasks) {
      if (t.status === 'done' || !t.src) continue;
      const src = sources.find((s) => s.id === t.src.sourceId);
      if (!src) continue;
      const sc = sched && sched.get(t.id);
      for (const d of t.src.deps || []) {
        const rec = (src.rows || []).find((r) => String(r.wbsId) === String(d));
        if (!rec || rec.status === 'done') continue;
        const who = rec.owner ? `${rec.owner}さん担当` : '担当未定';
        if (rec.due && Core.diffDays(rec.due, today) < 0) {
          out.push({ task: t, rec, source: src, level: 'critical', text: `先行「${label(rec)}」（${who}）が期限を${Core.diffDays(today, rec.due)}日過ぎています` });
        } else if (rec.status === 'waiting') {
          out.push({ task: t, rec, source: src, level: 'warn', text: `先行「${label(rec)}」（${who}）が待ち状態です` });
        } else if (rec.due && sc && sc.latestStart && rec.due >= sc.latestStart) {
          out.push({ task: t, rec, source: src, level: 'warn', text: `先行「${label(rec)}」（${who}）の期限 ${Core.formatDate(rec.due)} が、このタスクの着手期限 ${Core.formatDate(sc.latestStart)} 以降です` });
        }
      }
      // 個人で期限をチームWBSより後ろにしている
      const rec = (src.rows || []).find((r) => String(r.wbsId) === String(t.src.id));
      if (rec && rec.due && t.due && t.due > rec.due) {
        out.push({ task: t, rec, source: src, level: 'warn', text: `個人の期限 ${Core.formatDate(t.due)} がチームWBSの期限 ${Core.formatDate(rec.due)} より後ろです` });
      }
    }
    return out;
  };

  /** チームWBSのレコードを集計用の疑似タスクにする */
  Core.recordAsTask = (r) => ({
    id: `${r.wbsId}`, wbsId: r.wbsId, title: r.title, status: r.status || 'todo', progress: Number(r.progress) || 0,
    due: r.due || null, start: r.start || null, estimate: r.estimateH ? Number(r.estimateH) * 60 : null,
    owner: r.owner, deps: r.deps ? r.deps.split(',') : [], difficulty: Number(r.difficulty) || 2, priority: Number(r.priority) || 2,
    createdAt: r.start || '', l1: r.l1, l2: r.l2, l3: r.l3,
  });

  /** チーム全体の状況: 大分類 > 中分類 の集計と、遅れているタスク */
  Core.teamOverview = (rows, today, settings) => {
    const tasks = rows.map(Core.recordAsTask);
    const sched = Core.schedule(tasks, today, settings);
    const groups = new Map();
    for (const t of tasks) {
      const k1 = t.l1 || '（大分類なし）';
      if (!groups.has(k1)) groups.set(k1, new Map());
      const g = groups.get(k1);
      const k2 = t.l2 || '（中分類なし）';
      if (!g.has(k2)) g.set(k2, []);
      g.get(k2).push(t);
    }
    const tree = [...groups.entries()].map(([name, g]) => {
      const all = [...g.values()].flat();
      return {
        name, rollup: Core.rollup(all, today, sched),
        children: [...g.entries()].map(([n2, list]) => ({ name: n2, rollup: Core.rollup(list, today, sched), tasks: list })),
      };
    });
    const late = tasks.filter((t) => t.status !== 'done' && ((t.due && Core.diffDays(t.due, today) < 0) || (sched.get(t.id) && sched.get(t.id).float < 0)))
      .map((t) => ({ task: t, overdue: t.due && Core.diffDays(t.due, today) < 0, float: sched.get(t.id).float }))
      .sort((a, b) => (a.task.due || '9').localeCompare(b.task.due || '9'));
    const owners = new Map();
    tasks.filter((t) => t.status !== 'done').forEach((t) => {
      const o = t.owner || '未割当';
      const c = owners.get(o) || { owner: o, open: 0, late: 0 };
      c.open++;
      if (late.some((l) => l.task === t)) c.late++;
      owners.set(o, c);
    });
    return { tree, late, owners: [...owners.values()].sort((a, b) => b.late - a.late || b.open - a.open), total: tasks.length, done: tasks.filter((t) => t.status === 'done').length };
  };

  /** 共通WBSへの追加を依頼する文（読み取りのみの人向け） */
  Core.addRequestText = (task, source, categories, areas, myName) => {
    const r = Core.recordFromTask(task, categories, areas);
    return [
      `【${source.name}】へのタスク追加のお願い`,
      '',
      `タスク: ${r.title}`,
      `分類: ${[r.l1, r.l2, r.l3].filter(Boolean).join(' / ') || '（未設定）'}`,
      `担当: ${r.owner || myName || '（自分）'}`,
      `期限: ${r.due ? Core.formatDate(r.due) : '未定'}${r.start ? `（開始予定 ${Core.formatDate(r.start)}）` : ''}`,
      `見積: ${r.estimateH ? `${r.estimateH}h` : '未定'} / 重要度: ${Core.PRIORITY[r.priority]} / 難易度: ${Core.DIFFICULTY[r.difficulty]}`,
      r.notes ? `補足: ${r.notes}` : '',
      '',
      '共通WBSへの追加をご検討ください。追加後はダッシュボードで自動的に紐づけます。',
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  };
})(typeof window !== 'undefined' ? window : globalThis);
