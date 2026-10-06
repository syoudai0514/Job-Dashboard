/*
 * store.js — 状態の保持と永続化（localStorage）
 * データはこのブラウザの中だけに保存される。バックアップは設定画面の書き出しで。
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
    staleDays: 5,
    waitingDays: 3,
    snoozed: {},
    ai: { mode: 'manual', endpoint: '', model: '', authHeader: 'bearer', apiKey: '' },
  });

  /** 初回表示用のサンプル（today 基準の相対日付）。画面上に「サンプル」と明示する */
  function sampleState(today) {
    const d = (n) => Core.addDays(today, n);
    const at = (n) => `${d(n)}T09:00:00.000Z`;
    const t = (o) => ({
      id: uid('t'), status: 'todo', priority: 2, due: null, estimate: null, notes: '', waitingFor: '',
      subtasks: [], log: [], todayPin: null, createdAt: at(-3), updatedAt: at(-1), completedAt: null, ...o,
    });
    const st = (title, done) => ({ id: uid('s'), title, done: !!done });
    const tasks = [
      t({ title: 'Copilot社内利用ガイドライン案を作成', categoryId: 'ai', priority: 1, status: 'doing', due: d(2), estimate: 120,
        subtasks: [st('他社事例・公開ガイドラインを3件確認', true), st('禁止事項・入力NG情報を整理', true), st('利用申請フローの案を書く'), st('情シスにレビュー依頼')],
        log: [{ at: at(-1), text: '入力NG情報の一覧を法務に確認済み' }] }),
      t({ title: '各部署の生成AI活用事例をヒアリング', categoryId: 'ai', status: 'waiting', waitingFor: '佐藤', due: d(6), estimate: 60, updatedAt: at(-4) }),
      t({ title: 'コーディング規約v2のレビュー指摘を反映', categoryId: 'std', priority: 2, due: d(-1), estimate: 90 }),
      t({ title: '設計書テンプレートの統一案を作る', categoryId: 'std', priority: 2, estimate: 240 }),
      t({ title: 'CI導入のパイロット案件を選定', categoryId: 'dev', priority: 1, status: 'doing', due: d(5), estimate: 60, updatedAt: at(-7) }),
      t({ title: 'リリース判定会の資料準備', categoryId: 'dev', priority: 2, due: d(3), estimate: 45 }),
      t({ title: '月次業績見込を更新して部長に共有', categoryId: 'perf', priority: 1, due: d(1), estimate: 45 }),
      t({ title: '新人Aさんとの1on1準備', categoryId: 'edu', priority: 2, due: today, estimate: 20 }),
      t({ title: 'セキュリティ研修（eラーニング）を受講', categoryId: 'train', priority: 3, due: d(9), estimate: 60 }),
      t({ title: '9月分の交通費精算', categoryId: 'admin', priority: 2, due: d(3), estimate: 15 }),
      t({ title: '生成AI勉強会の参加者アンケート集計', categoryId: 'ai', status: 'done', completedAt: at(-1), updatedAt: at(-1), estimate: 30 }),
      t({ title: 'レビュー観点チェックリストを公開', categoryId: 'std', status: 'done', completedAt: at(-2), updatedAt: at(-2) }),
      t({ title: '週次進捗報告', categoryId: 'work-routine', status: 'done', completedAt: at(-6), updatedAt: at(-6) }),
      t({ title: 'ビルド時間の計測結果をまとめる', categoryId: 'dev', status: 'done', completedAt: at(-3), updatedAt: at(-3) }),
      t({ title: '勤怠の締め確認', categoryId: 'admin', status: 'done', completedAt: at(-5), updatedAt: at(-5) }),
      t({ title: 'Copilotハンズオンの議事録共有', categoryId: 'ai', status: 'done', completedAt: at(0), updatedAt: at(0) }),
    ];
    const routines = [
      { id: uid('r'), title: 'メール・チャットの確認と返信', categoryId: 'work-routine', freq: 'weekday', day: 1, priority: 2, estimate: 30, lastGenerated: null },
      { id: uid('r'), title: '週次進捗報告を作成', categoryId: 'work-routine', freq: 'weekly', day: 5, priority: 1, estimate: 45, lastGenerated: null },
      { id: uid('r'), title: '勤怠の締め確認', categoryId: 'admin', freq: 'monthly', day: 31, priority: 2, estimate: 15, lastGenerated: null },
    ];
    return {
      version: 1, sample: true, tasks, routines,
      categories: Core.DEFAULT_CATEGORIES.map((c) => ({ ...c, keywords: [...c.keywords] })),
      settings: defaultSettings(),
      journal: { [today]: { plan: '午前中にガイドライン案を仕上げて、午後は規約の反映。', reflection: '' } },
    };
  }

  function emptyState() {
    return {
      version: 1, sample: false, tasks: [], routines: [],
      categories: Core.DEFAULT_CATEGORIES.map((c) => ({ ...c, keywords: [...c.keywords] })),
      settings: defaultSettings(), journal: {},
    };
  }

  function normalize(s) {
    const base = emptyState();
    const out = { ...base, ...s };
    out.settings = { ...base.settings, ...(s.settings || {}), ai: { ...base.settings.ai, ...((s.settings || {}).ai || {}) } };
    out.tasks = (s.tasks || []).map((t) => ({ subtasks: [], log: [], ...t }));
    return out;
  }

  let state;
  let storageOK = true;
  try {
    const raw = localStorage.getItem(KEY);
    state = raw ? normalize(JSON.parse(raw)) : sampleState(Core.todayISO());
  } catch (e) {
    storageOK = false;
    state = sampleState(Core.todayISO());
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); storageOK = true; } catch (e) { storageOK = false; }
    listeners.forEach((fn) => fn(state));
  }

  const Store = {
    get state() { return state; },
    get storageOK() { return storageOK; },
    uid,
    onChange(fn) { listeners.push(fn); },
    category(id) { return state.categories.find((c) => c.id === id) || null; },
    task(id) { return state.tasks.find((t) => t.id === id) || null; },

    addTask(fields, logText) {
      const now = nowISO();
      const task = {
        id: uid('t'), title: '', categoryId: null, status: 'todo', priority: 2, due: null, estimate: null,
        notes: '', waitingFor: '', subtasks: [], log: [], todayPin: null, createdAt: now, updatedAt: now, completedAt: null,
        ...fields,
      };
      if (logText) task.log.push({ at: now, text: logText });
      state.tasks.unshift(task);
      save();
      return task;
    },

    updateTask(id, patch, logText) {
      const t = Store.task(id);
      if (!t) return null;
      const now = nowISO();
      Object.assign(t, patch, { updatedAt: now });
      if (patch.status === 'done' && !t.completedAt) t.completedAt = now;
      if (patch.status && patch.status !== 'done') t.completedAt = null;
      if (logText) t.log.push({ at: now, text: logText });
      save();
      return t;
    },

    deleteTask(id) {
      const i = state.tasks.findIndex((t) => t.id === id);
      if (i === -1) return null;
      const [removed] = state.tasks.splice(i, 1);
      save();
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
      save();
    },
    updateSettings(patch) {
      state.settings = { ...state.settings, ...patch };
      save();
    },
    snooze(followId, untilISO) {
      state.settings.snoozed = { ...(state.settings.snoozed || {}), [followId]: untilISO };
      save();
    },
    setCategories(categories) { state.categories = categories; save(); },
    setRoutines(routines) { state.routines = routines; save(); },

    /** 今日分の定例タスクを生成する（1日1回） */
    ensureRoutines(today) {
      let created = 0;
      for (const r of state.routines) {
        if (r.lastGenerated === today || !Core.routineDueOn(r, today)) continue;
        const exists = state.tasks.some((t) => t.recurringId === r.id && t.due === today);
        if (!exists) {
          const now = nowISO();
          state.tasks.unshift({
            id: uid('t'), title: r.title, categoryId: r.categoryId, status: 'todo', priority: r.priority || 2,
            due: today, estimate: r.estimate || null, notes: '', waitingFor: '', subtasks: [], log: [],
            todayPin: null, recurringId: r.id, createdAt: now, updatedAt: now, completedAt: null,
          });
          created++;
        }
        r.lastGenerated = today;
      }
      if (created) save();
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
      state = { ...emptyState(), categories: state.categories, settings: { ...state.settings, snoozed: {} } };
      save();
    },
    loadSample() { state = sampleState(Core.todayISO()); save(); },
  };

  root.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
