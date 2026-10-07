/*
 * store.js — 状態の保持と永続化（localStorage）
 * データはこのブラウザの中だけに保存される。WBS（Excel）との同期は wbs-sync.js が担当する。
 * 共有・複数端末が必要になったら、この層だけを API / SharePoint / Supabase 等に差し替える。
 */
(function (root) {
  'use strict';
  const { Core } = root;
  const KEY = 'job-dashboard:v1';
  const listeners = [];

  const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
  const nowISO = () => new Date().toISOString();

  const defaultSettings = () => ({
    capacityMin: 360,
    focusHours: 3,
    urgentFloat: 1,
    earlyStartFloat: 10,
    staleDays: 5,
    waitingDays: 3,
    myName: '',
    matrixAxis: 'both',
    snoozed: {},
    wbs: { appendNew: true, pollSec: 5 },
    ai: { mode: 'manual', endpoint: '', model: '', authHeader: 'bearer', apiKey: '' },
  });

  /** タスクの全項目と既定値 */
  const taskDefaults = () => ({
    title: '', categoryId: null, l3: '', status: 'todo', priority: 2, difficulty: 2, interrupt: false,
    start: null, due: null, estimate: null, progress: 0, owner: '', deps: [],
    notes: '', waitingFor: '', subtasks: [], log: [], todayPin: null, todayOrder: null,
    wbsId: null, wbsSkip: false, wbsBase: null, recurringId: null,
    src: null, // チームWBSから取り込んだとき { sourceId, id, label, base, deps }
    createdAt: null, updatedAt: null, completedAt: null,
  });

  /** 初回表示用のサンプル（today 基準の相対日付）。画面上に「サンプル」と明示する */
  function sampleState(today) {
    const d = (n) => Core.addDays(today, n);
    const at = (n) => `${d(n)}T09:00:00.000Z`;
    const t = (o) => ({ ...taskDefaults(), id: uid('t'), createdAt: at(-10), updatedAt: at(-1), ...o });
    const st = (title, done) => ({ id: uid('s'), title, done: !!done });
    const done = (n) => ({ status: 'done', progress: 100, completedAt: at(n), updatedAt: at(n) });
    const tasks = [
      // 業務 / 生成AI導入
      t({ wbsId: 'W-101', categoryId: 'ai', l3: 'ガイドライン整備', title: '他社事例・公開ガイドラインの調査', estimate: 240, start: d(-9), due: d(-4), ...done(-4) }),
      t({ wbsId: 'W-102', categoryId: 'ai', l3: 'ガイドライン整備', title: 'Copilot社内利用ガイドライン案を作成', priority: 1, difficulty: 3, status: 'doing', progress: 50, start: d(-3), due: d(2), estimate: 480, deps: ['W-101'],
        subtasks: [st('禁止事項・入力NG情報を整理', true), st('利用申請フローの案を書く'), st('FAQを10問作る')], log: [{ at: at(-1), text: '入力NG情報の一覧を法務に確認済み' }] }),
      t({ wbsId: 'W-103', categoryId: 'ai', l3: 'ガイドライン整備', title: '情シス・法務のレビュー', owner: '田中', start: d(3), due: d(6), estimate: 180, deps: ['W-102'] }),
      t({ wbsId: 'W-104', categoryId: 'ai', l3: 'ガイドライン整備', title: 'ガイドライン公開・全社周知', priority: 1, due: d(9), estimate: 120, deps: ['W-103'] }),
      t({ wbsId: 'W-111', categoryId: 'ai', l3: '展開・定着', title: '各部署の生成AI活用事例をヒアリング', status: 'waiting', waitingFor: '佐藤', owner: '佐藤', due: d(6), estimate: 60, updatedAt: at(-4) }),
      t({ wbsId: 'W-112', categoryId: 'ai', l3: '展開・定着', title: 'Copilotハンズオン研修の企画', priority: 1, difficulty: 3, start: d(1), due: d(16), estimate: 900, deps: ['W-104'] }),
      t({ wbsId: 'W-113', categoryId: 'ai', l3: '展開・定着', title: '利用状況レポートのひな形作成', priority: 3, difficulty: 2, due: d(24), estimate: 180 }),
      // 業務 / 標準化
      t({ wbsId: 'W-201', categoryId: 'std', l3: 'コーディング規約', title: 'コーディング規約v2のレビュー指摘を反映', priority: 1, status: 'doing', progress: 60, due: d(-1), estimate: 240 }),
      t({ wbsId: 'W-202', categoryId: 'std', l3: 'コーディング規約', title: 'コーディング規約v2の公開', due: d(4), estimate: 60, deps: ['W-201'] }),
      t({ wbsId: 'W-211', categoryId: 'std', l3: '設計テンプレート', title: '設計書テンプレートの統一案を作る', priority: 2, difficulty: 3, due: d(13), estimate: 720 }),
      t({ wbsId: 'W-212', categoryId: 'std', l3: '設計テンプレート', title: 'レビュー観点チェックリストを公開', estimate: 120, ...done(-2) }),
      // 業務 / 開発推進
      t({ wbsId: 'W-301', categoryId: 'dev', l3: 'CI導入', title: 'CI導入のパイロット案件を選定', priority: 1, status: 'doing', progress: 30, due: d(3), estimate: 240, updatedAt: at(-7) }),
      t({ wbsId: 'W-302', categoryId: 'dev', l3: 'CI導入', title: 'CIパイプライン構築（パイロット）', priority: 1, difficulty: 3, due: d(10), estimate: 960, deps: ['W-301'] }),
      t({ wbsId: 'W-303', categoryId: 'dev', l3: 'CI導入', title: 'パイロット結果の振り返りと展開計画', priority: 2, due: d(15), estimate: 180, deps: ['W-302'] }),
      t({ wbsId: 'W-311', categoryId: 'dev', l3: 'リリース', title: 'リリース判定会の資料準備', due: d(3), estimate: 90 }),
      t({ wbsId: 'W-312', categoryId: 'dev', l3: 'リリース', title: '本番障害の問い合わせ対応', interrupt: true, priority: 2, status: 'doing', due: today, estimate: 60, createdAt: at(0) }),
      t({ wbsId: 'W-321', categoryId: 'dev', l3: 'CI導入', title: 'ビルド時間の計測結果をまとめる', estimate: 120, ...done(-3) }),
      // 自社作業
      t({ wbsId: 'W-501', categoryId: 'perf', l3: '月次', title: '月次業績見込を更新して部長に共有', priority: 1, due: d(1), estimate: 60 }),
      t({ wbsId: 'W-601', categoryId: 'edu', l3: '新人育成', title: '新人Aさんとの1on1準備', due: today, estimate: 20 }),
      t({ wbsId: 'W-602', categoryId: 'edu', l3: '新人育成', title: 'OJT計画の見直し', difficulty: 2, due: d(8), estimate: 120 }),
      t({ wbsId: 'W-701', categoryId: 'train', l3: '必須研修', title: 'セキュリティ研修（eラーニング）を受講', priority: 3, difficulty: 1, due: d(9), estimate: 60 }),
      t({ categoryId: 'admin', title: '9月分の交通費精算', priority: 2, difficulty: 1, due: d(3), estimate: 15, wbsSkip: true }),
      t({ categoryId: 'ai', title: '生成AI勉強会の参加者アンケート集計', estimate: 30, wbsSkip: true, ...done(-1) }),
      t({ categoryId: 'work-routine', title: '週次進捗報告', estimate: 45, wbsSkip: true, ...done(-6) }),
      t({ categoryId: 'admin', title: '勤怠の締め確認', estimate: 15, wbsSkip: true, ...done(-5) }),
      t({ categoryId: 'ai', title: 'Copilotハンズオンの議事録共有', estimate: 30, wbsSkip: true, ...done(0) }),
    ];
    // ---- チームWBS（サンプル）----
    const R = (o) => ({ wbsId: '', l1: '業務', l2: '', l3: '', title: '', owner: '', priority: '2', difficulty: '2', interrupt: '', start: '', due: '', estimateH: '', progress: '0', status: 'todo', deps: '', completedOn: '', notes: '', origin: '', ...o });
    const devRows = [
      R({ wbsId: 'D-101', l2: '開発推進', l3: 'CI導入', title: 'CI導入のパイロット案件を選定', owner: '山田', priority: '1', due: d(3), estimateH: '4', progress: '30', status: 'doing' }),
      R({ wbsId: 'D-102', l2: '開発推進', l3: 'CI導入', title: 'CIパイプライン構築（パイロット）', owner: '山田', priority: '1', difficulty: '3', due: d(10), estimateH: '16', deps: 'D-101,D-104' }),
      R({ wbsId: 'D-103', l2: '開発推進', l3: 'CI導入', title: 'パイロット結果の振り返りと展開計画', owner: '山田', due: d(15), estimateH: '3', deps: 'D-102' }),
      R({ wbsId: 'D-104', l2: '開発推進', l3: 'CI導入', title: '検証用ビルド環境の払い出し', owner: '鈴木', due: d(-2), estimateH: '6', progress: '50', status: 'doing' }),
      R({ wbsId: 'D-105', l2: '開発推進', l3: 'セキュリティ', title: '脆弱性診断の手配', owner: '山田', priority: '1', due: d(12), estimateH: '3' }),
      R({ wbsId: 'D-106', l2: '開発推進', l3: 'リリース', title: 'リリース手順書の更新', owner: '山田', due: d(8), estimateH: '4', deps: 'D-107' }),
      R({ wbsId: 'D-107', l2: '開発推進', l3: 'リリース', title: '本番切替のリハーサル', owner: '高橋', due: d(6), estimateH: '8', difficulty: '3' }),
      R({ wbsId: 'D-108', l2: '開発推進', l3: 'リリース', title: '移行データの検証', owner: '高橋', due: d(-1), estimateH: '6', progress: '20', status: 'doing' }),
      R({ wbsId: 'D-201', l2: '標準化', l3: 'コーディング規約', title: '規約v2のレビュー会', owner: '鈴木', due: d(-6), status: 'done', progress: '100', completedOn: d(-6) }),
      R({ wbsId: 'D-202', l2: '標準化', l3: 'テンプレート', title: 'テスト仕様書テンプレートの改訂', owner: '鈴木', due: d(9), estimateH: '6', progress: '10', status: 'doing' }),
      R({ wbsId: 'D-203', l2: '標準化', l3: 'テンプレート', title: 'レビュー記録票の様式統一', owner: '', due: d(20), estimateH: '4' }),
    ];
    const aiRows = [
      R({ wbsId: 'G-01', l2: '生成AI導入', l3: 'ガイドライン整備', title: 'Copilot社内利用ガイドライン案を作成', owner: '山田', priority: '1', difficulty: '3', start: d(-3), due: d(2), estimateH: '8', progress: '50', status: 'doing' }),
      R({ wbsId: 'G-02', l2: '生成AI導入', l3: 'ガイドライン整備', title: '情シス・法務のレビュー', owner: '田中', due: d(6), estimateH: '3', deps: 'G-01' }),
      R({ wbsId: 'G-03', l2: '生成AI導入', l3: 'ガイドライン整備', title: 'ガイドライン公開・全社周知', owner: '山田', priority: '1', due: d(9), estimateH: '2', deps: 'G-02' }),
      R({ wbsId: 'G-04', l2: '生成AI導入', l3: '展開・定着', title: '部門別ユースケース集の作成', owner: '山田', priority: '1', difficulty: '2', due: d(18), estimateH: '10' }),
      R({ wbsId: 'G-05', l2: '生成AI導入', l3: '展開・定着', title: '利用ログの分析レポート', owner: '佐藤', due: d(-3), estimateH: '5', progress: '40', status: 'doing' }),
      R({ wbsId: 'G-06', l2: '生成AI導入', l3: '展開・定着', title: '各部署の生成AI活用事例をヒアリング', owner: '佐藤', due: d(6), estimateH: '1', status: 'waiting' }),
    ];
    const sources = [
      { id: 'src_dev', name: '開発部 共通WBS', fileName: '開発部_共通WBS.xlsx', mode: 'write', scope: 'mine', includeUnassigned: false, dismissed: [], seen: ['D-105'], rows: devRows, lastRead: at(0) },
      { id: 'src_ai', name: '生成AI推進WG', fileName: '生成AI推進WG_WBS.xlsx', mode: 'read', scope: 'mine', includeUnassigned: false, dismissed: [], seen: [], rows: aiRows, lastRead: at(0) },
    ];
    const link = (wbsId, source, rec) => {
      const t = tasks.find((x) => x.wbsId === wbsId);
      t.src = { sourceId: source.id, id: rec.wbsId, label: `${source.name}:${rec.wbsId}`, base: { ...rec }, deps: rec.deps ? rec.deps.split(',') : [] };
      t.due = rec.due || t.due;
    };
    link('W-301', sources[0], devRows[0]);
    link('W-302', sources[0], devRows[1]);
    link('W-303', sources[0], devRows[2]);
    link('W-102', sources[1], aiRows[0]);
    link('W-104', sources[1], aiRows[2]);
    const feed = [
      { id: uid('f'), at: at(0), sourceId: 'src_dev', kind: 'change', taskId: tasks.find((x) => x.wbsId === 'W-302').id, text: '「CIパイプライン構築（パイロット）」期限: ' + Core.formatDate(d(12)) + ' → ' + Core.formatDate(d(10)), read: false },
      { id: uid('f'), at: at(0), sourceId: 'src_dev', kind: 'new', text: '新しいタスク: D-105 脆弱性診断の手配', read: false },
      { id: uid('f'), at: at(-1), sourceId: 'src_ai', kind: 'change', taskId: tasks.find((x) => x.wbsId === 'W-104').id, text: '「ガイドライン公開・全社周知」重要度: 中 → 高', read: true },
    ];

    const routines = [
      { id: uid('r'), title: 'メール・チャットの確認と返信', categoryId: 'work-routine', freq: 'weekday', day: 1, priority: 2, estimate: 30, lastGenerated: null },
      { id: uid('r'), title: '週次進捗報告を作成', categoryId: 'work-routine', freq: 'weekly', day: 5, priority: 1, estimate: 45, lastGenerated: null },
      { id: uid('r'), title: '勤怠の締め確認', categoryId: 'admin', freq: 'monthly', day: 31, priority: 2, estimate: 15, lastGenerated: null },
    ];
    return {
      version: 3, sample: true, tasks, routines,
      areas: { work: '業務', own: '自社作業' },
      categories: Core.DEFAULT_CATEGORIES.map((c) => ({ ...c, keywords: [...c.keywords] })),
      settings: { ...defaultSettings(), myName: '山田' },
      journal: { [today]: { plan: '午前中にガイドライン案を仕上げて、午後は規約の反映。', reflection: '' } },
      wbs: { fileName: '', lastSync: null, log: null },
      sources, feed,
    };
  }

  function emptyState() {
    return {
      version: 3, sample: false, tasks: [], routines: [],
      areas: { work: '業務', own: '自社作業' },
      categories: Core.DEFAULT_CATEGORIES.map((c) => ({ ...c, keywords: [...c.keywords] })),
      settings: defaultSettings(), journal: {},
      wbs: { fileName: '', lastSync: null, log: null },
      sources: [], feed: [],
    };
  }

  /** 古い形式のデータにも新しい項目の既定値を入れる */
  function normalize(s) {
    const base = emptyState();
    const out = { ...base, ...s };
    out.settings = {
      ...base.settings, ...(s.settings || {}),
      ai: { ...base.settings.ai, ...((s.settings || {}).ai || {}) },
      wbs: { ...base.settings.wbs, ...((s.settings || {}).wbs || {}) },
    };
    out.areas = { ...base.areas, ...(s.areas || {}) };
    out.wbs = { ...base.wbs, ...(s.wbs || {}) };
    out.sources = (s.sources || []).map((x) => ({ mode: 'read', scope: 'mine', includeUnassigned: false, dismissed: [], seen: [], rows: [], ...x }));
    out.feed = s.feed || [];
    out.tasks = (s.tasks || []).map((t) => ({ ...taskDefaults(), ...t }));
    out.version = 3;
    return out;
  }

  let state;
  let storageOK = true;
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? JSON.parse(raw) : null;
    // 旧バージョンのサンプルのままなら、WBS 項目入りの新しいサンプルに入れ替える
    state = saved && !(saved.sample && (saved.version || 1) < 3) ? normalize(saved) : sampleState(Core.todayISO());
  } catch (e) {
    storageOK = false;
    state = sampleState(Core.todayISO());
  }
  const syncAreas = () => {
    Object.keys(Core.AREAS).forEach((k) => { if (!(k in state.areas)) delete Core.AREAS[k]; });
    Object.assign(Core.AREAS, state.areas);
  };
  syncAreas();

  // transaction 中は保存と通知をまとめる
  let batching = 0;
  let pendingMeta = null;
  function save(meta) {
    if (batching) { pendingMeta = { ...(pendingMeta || {}), ...(meta || {}) }; return; }
    syncAreas();
    try { localStorage.setItem(KEY, JSON.stringify(state)); storageOK = true; } catch (e) { storageOK = false; }
    listeners.forEach((fn) => fn(state, meta || {}));
  }

  const Store = {
    get state() { return state; },
    get storageOK() { return storageOK; },
    uid,
    taskDefaults,
    /** fn(state, meta) — meta.source === 'wbs' は WBS 同期による変更 */
    onChange(fn) { listeners.push(fn); },
    /** 複数の変更を1回の保存にまとめる */
    transaction(fn, meta) {
      batching++;
      try { fn(); } finally {
        batching--;
        if (!batching) { const m = { ...(pendingMeta || {}), ...(meta || {}) }; pendingMeta = null; save(m); }
      }
    },
    category(id) { return state.categories.find((c) => c.id === id) || null; },
    task(id) { return state.tasks.find((t) => t.id === id) || null; },

    /** 大分類名 → id（なければ作る） */
    ensureArea(name) {
      const n = String(name || '').trim();
      const hit = Object.entries(state.areas).find(([, v]) => v === n);
      if (hit) return hit[0];
      const id = uid('a');
      state.areas[id] = n;
      return id;
    },
    /** 大分類名・中分類名 → categoryId（なければ作る） */
    ensureCategory(l1, l2) {
      const name = String(l2 || '').trim() || '（中分類なし）';
      if (!l1) {
        const any = state.categories.find((c) => c.name === name);
        if (any) return any.id;
      }
      const areaId = l1 ? Store.ensureArea(l1) : 'work';
      const hit = state.categories.find((c) => c.area === areaId && c.name === name);
      if (hit) return hit.id;
      const c = { id: uid('c'), area: areaId, name, keywords: [] };
      state.categories.push(c);
      return c.id;
    },

    addTask(fields, logText, meta) {
      const now = nowISO();
      const task = { ...taskDefaults(), id: uid('t'), createdAt: now, updatedAt: now, ...fields };
      if (task.status === 'done') { task.progress = 100; task.completedAt = task.completedAt || now; }
      if (logText) task.log.push({ at: now, text: logText });
      state.tasks.unshift(task);
      save(meta);
      return task;
    },

    updateTask(id, patch, logText, meta) {
      const t = Store.task(id);
      if (!t) return null;
      const now = nowISO();
      const p = { ...patch };
      // 状態と進捗を連動させる
      if (p.status === 'done') p.progress = 100;
      if (p.progress === 100 && (p.status ?? t.status) !== 'done') p.status = 'done';
      if (p.progress > 0 && p.progress < 100 && (p.status ?? t.status) === 'todo') p.status = 'doing';
      if (p.status && p.status !== 'done' && t.status === 'done' && p.progress === undefined && t.progress === 100) p.progress = 0;
      Object.assign(t, p, { updatedAt: now });
      if (p.status === 'done' && !t.completedAt) t.completedAt = now;
      if (p.status && p.status !== 'done') t.completedAt = null;
      if (logText) t.log.push({ at: now, text: logText });
      save(meta);
      return t;
    },

    deleteTask(id, meta) {
      const i = state.tasks.findIndex((t) => t.id === id);
      if (i === -1) return null;
      const [removed] = state.tasks.splice(i, 1);
      save(meta);
      return { task: removed, index: i };
    },
    restoreTask(task, index) {
      state.tasks.splice(Math.min(index, state.tasks.length), 0, task);
      save();
    },

    addSubtask(id, title) {
      const t = Store.task(id);
      if (!t || !title.trim()) return;
      t.subtasks.push({ id: uid('s'), title: title.trim(), done: false });
      t.updatedAt = nowISO();
      save();
    },
    toggleSubtask(id, sid) {
      const t = Store.task(id);
      const s = t && t.subtasks.find((x) => x.id === sid);
      if (!s) return;
      s.done = !s.done;
      t.updatedAt = nowISO();
      if (t.status === 'todo' && s.done) t.status = 'doing';
      save();
    },
    removeSubtask(id, sid) {
      const t = Store.task(id);
      if (!t) return;
      t.subtasks = t.subtasks.filter((x) => x.id !== sid);
      save();
    },

    setJournal(date, field, text) {
      state.journal[date] = { plan: '', reflection: '', ...(state.journal[date] || {}), [field]: text };
      save({ source: 'journal' });
    },
    updateSettings(patch) {
      state.settings = { ...state.settings, ...patch };
      save({ source: 'settings' });
    },
    /* ---- チームWBS（取込元） ---- */
    source(id) { return state.sources.find((x) => x.id === id) || null; },
    addSource(src) { state.sources.push(src); save({ source: 'team-meta' }); return src; },
    updateSource(id, patch, meta) {
      const src = Store.source(id);
      if (!src) return null;
      Object.assign(src, patch);
      save(meta || { source: 'team-meta' });
      return src;
    },
    removeSource(id) {
      state.sources = state.sources.filter((x) => x.id !== id);
      state.tasks.forEach((t) => { if (t.src && t.src.sourceId === id) t.src = null; });
      save({ source: 'team-meta' });
    },
    /** 変更の通知を追加（新しい順に最大200件） */
    addFeed(items, meta) {
      if (!items.length) return;
      const now = nowISO();
      state.feed = [...items.map((x) => ({ id: uid('f'), at: now, read: false, ...x })), ...state.feed].slice(0, 200);
      if (meta !== false) save(meta || { source: 'team-meta' });
    },
    markFeedRead() { state.feed.forEach((f) => { f.read = true; }); save({ source: 'team-meta' }); },

    setWbsMeta(patch) {
      state.wbs = { ...state.wbs, ...patch };
      save({ source: 'wbs-meta' });
    },
    snooze(followId, untilISO) {
      state.settings.snoozed = { ...(state.settings.snoozed || {}), [followId]: untilISO };
      save({ source: 'settings' });
    },
    setCategories(categories) { state.categories = categories; save(); },
    setAreas(areas) { state.areas = areas; save(); },
    setRoutines(routines) { state.routines = routines; save({ source: 'settings' }); },

    /** 今日分の定例タスクを生成する（1日1回）。定例は WBS には載せない */
    ensureRoutines(today) {
      let created = 0;
      for (const r of state.routines) {
        if (r.lastGenerated === today || !Core.routineDueOn(r, today)) continue;
        const exists = state.tasks.some((t) => t.recurringId === r.id && t.due === today);
        if (!exists) {
          const now = nowISO();
          state.tasks.unshift({
            ...taskDefaults(), id: uid('t'), title: r.title, categoryId: r.categoryId, priority: r.priority || 2,
            due: today, estimate: r.estimate || null, recurringId: r.id, wbsSkip: true, createdAt: now, updatedAt: now,
          });
          created++;
        }
        r.lastGenerated = today;
      }
      if (created) save({ source: 'routine' });
      return created;
    },

    exportJSON() { return JSON.stringify({ ...state, exportedAt: nowISO() }, null, 2); },
    importJSON(text) {
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.tasks)) throw new Error('tasks 配列が見つかりません');
      state = normalize({ ...data, sample: false });
      save();
    },
    clearSample() {
      state = { ...emptyState(), categories: state.categories, areas: state.areas, settings: { ...state.settings, snoozed: {}, myName: '' }, wbs: state.wbs };
      save();
    },
    loadSample() { state = sampleState(Core.todayISO()); save(); },
  };

  root.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
