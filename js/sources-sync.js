/*
 * sources-sync.js — チームWBS（取込元・複数可）の読み取りと書き戻し（ブラウザ専用）
 *
 *   - 登録したチームWBSを数秒おきに確認し、保存されたら読み直す
 *   - 自分担当の新しいタスクは「新着」に出す（取り込むかは本人が選ぶ）
 *   - 取り込み済みのタスクは、チームWBSでの期限・タスク名などの変更を自動で反映し、通知に残す
 *   - 書き戻し権限（mode = 'write'）のある取込元には、状態・進捗・完了日を書き戻す。個人タスクを共通WBSに追加することもできる
 *   - 判定のロジックは sources-core.js（Core.reconcileSource など）にある
 */
(function (root) {
  'use strict';
  const { Core, Store, WBS } = root;
  const lib = WBS.lib;
  const listeners = [];
  const handles = new Map(); // sourceId → FileSystemFileHandle
  const status = new Map(); // sourceId → { status, message }
  const removedBy = new Map(); // sourceId → { removed: [taskId], reassigned: [taskId] }
  let busy = false;
  let again = false;

  const T = {
    canAutoSync: lib.canAutoSync,
    status: (id) => status.get(id) || { status: handles.has(id) ? 'connected' : 'offline', message: '' },
    problems: (id) => removedBy.get(id) || { removed: [], reassigned: [] },
    onChange: (fn) => listeners.push(fn),
  };
  const notify = () => listeners.forEach((fn) => fn());
  const setStatus = (id, st, message) => { status.set(id, { status: st, message: message || '' }); notify(); };
  const keyOf = (id) => `src:${id}`;
  const S = () => Store.state;
  const shortVal = (k, v) => {
    if (v === '' || v === null || v === undefined) return '（空）';
    if (['start', 'due', 'completedOn'].includes(k)) return Core.formatDate(v);
    if (k === 'status') return Core.STATUS[v];
    if (k === 'priority') return Core.PRIORITY[v];
    if (k === 'difficulty') return Core.DIFFICULTY[v];
    if (k === 'progress') return `${v}%`;
    if (k === 'estimateH') return `${v}h`;
    return v;
  };

  /* ---------- 読み取り ---------- */
  async function loadWorkbook(fileOrHandle) {
    const file = fileOrHandle.getFile ? await fileOrHandle.getFile() : fileOrHandle;
    const wb = new root.ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    return { wb, file };
  }
  /** ブック → レコード（行番号つき）。ID のない行はタスク名で仮の ID を付ける */
  function parseWorkbook(wb) {
    const info = lib.locate(wb);
    if (!info) throw new Error('「タスク」という見出しの列が見つかりません。');
    const parsed = Core.readWbsRows(lib.readRows(info));
    let noId = 0;
    const records = parsed.map((p) => {
      const rec = { ...p.rec, _row: p.rowNumber };
      if (!rec.wbsId) { rec.wbsId = `#${rec.title}`; rec._noId = true; noId++; }
      return rec;
    });
    return { info, records, noId };
  }

  /* ---------- 突き合わせと反映 ---------- */
  /** チームWBSのレコードをダッシュボードに反映し、書き戻すべきセルを返す */
  function apply(source, records) {
    const st = S();
    const res = Core.reconcileSource(records, st.tasks, source, { categories: st.categories, areas: st.areas, myName: st.settings.myName });
    const feed = [];
    const writes = []; // { row, key, value, task, keys }
    const resolve = (l1, l2) => Store.ensureCategory(l1, l2);
    const changed = res.updates.length > 0;

    // 新着の通知（初めて見たものだけ）
    const seen = new Set(source.seen || []);
    const fresh = res.inbox.filter((r) => !seen.has(String(r.wbsId)));
    fresh.forEach((r) => feed.push({ sourceId: source.id, kind: 'new', text: `新しいタスク: ${r._noId ? '' : `${r.wbsId} `}${r.title}${r.due ? `（期限 ${Core.formatDate(r.due)}）` : ''}` }));

    if (changed || fresh.length) {
      Store.transaction(() => {
        for (const u of res.updates) {
          const t = Store.task(u.taskId);
          if (!t) continue;
          if (u.toTask.length) {
            const patch = Core.taskPatchFromRecord(u.merged, u.toTask, resolve, t);
            Store.updateTask(t.id, patch, `「${source.name}」の変更を反映（${u.toTask.map((k) => Core.WBS_FIELD_LABEL[k]).join('・')}）`, { source: 'team' });
            u.changes.forEach((c) => feed.push({
              sourceId: source.id, kind: 'change', taskId: t.id,
              text: `「${t.title}」${Core.WBS_FIELD_LABEL[c.key]}: ${shortVal(c.key, c.from)} → ${shortVal(c.key, c.to)}`,
            }));
          }
          t.src.base = { ...u.rec };
          delete t.src.base._row; delete t.src.base._noId;
          t.src.deps = u.rec.deps ? u.rec.deps.split(',') : [];
          if (u.toSource.length && u.rec._row) {
            u.toSource.forEach((k) => writes.push({ row: u.rec._row, key: k, value: u.merged[k], task: t }));
          }
        }
        // 先行のつながりを付け直す
        st.tasks.forEach((t) => {
          if (!t.src || t.src.sourceId !== source.id) return;
          const deps = Core.mapSourceDeps(t, st.tasks);
          if (deps.join(',') !== (t.deps || []).join(',')) t.deps = deps;
        });
        Store.addFeed(feed, false);
        source.seen = [...new Set([...seen, ...res.inbox.map((r) => String(r.wbsId))])];
      }, { source: 'team' });
    }
    removedBy.set(source.id, { removed: res.removed, reassigned: res.reassigned });
    return { res, writes, fresh };
  }

  /* ---------- 1つの取込元を同期 ---------- */
  async function syncOne(id, reason) {
    const source = Store.source(id);
    const handle = handles.get(id);
    if (!source || !handle) return;
    setStatus(id, 'syncing', '読み取っています…');
    try {
      const { wb, file } = await loadWorkbook(handle);
      source._lastModified = file.lastModified;
      const { info, records, noId } = parseWorkbook(wb);
      const { writes, fresh } = apply(source, records);
      const rows = records.map((r) => { const x = { ...r }; delete x._row; return x; });
      Store.updateSource(id, { rows, lastRead: new Date().toISOString(), fileName: file.name });
      let message = noId ? `ID のない行が ${noId} 件あります（タスク名で照合しています）。` : '';
      if (writes.length && source.mode === 'write') {
        const ok = await writeCells(handle, wb, info, writes);
        if (ok) {
          Store.transaction(() => writes.forEach((w) => { if (w.task.src && w.task.src.base) w.task.src.base[w.key] = w.value; }), { source: 'team' });
          message = `${message}状態・進捗を ${new Set(writes.map((w) => w.task.id)).size} 件書き戻しました。`;
        } else {
          setStatus(id, 'locked', 'ほかの人が開いているか、書き込み権限がないため、まだ書き戻せていません。開放されたら自動で書き込みます。');
          return;
        }
      }
      setStatus(id, 'connected', message);
      if (fresh.length) T.lastFresh = { sourceId: id, count: fresh.length, at: Date.now() };
    } catch (e) {
      setStatus(id, 'error', e.message || String(e));
    }
  }

  async function writeCells(handle, wb, info, writes) {
    const { ws, cols } = info;
    const touched = new Set();
    for (const w of writes) {
      const col = cols[w.key];
      if (!col) continue;
      const cell = ws.getRow(w.row).getCell(col);
      if (lib.isFormula(cell) || lib.isMergedSlave(cell)) continue;
      cell.value = Core.wbsDisplayValue(w.key, w.value);
      touched.add(w.row);
    }
    if (cols.updated) touched.forEach((r) => { const c = ws.getRow(r).getCell(cols.updated); if (!lib.isFormula(c)) c.value = lib.stamp(); });
    return writeWorkbook(handle, wb);
  }
  async function writeWorkbook(handle, wb) {
    try {
      const buf = await wb.xlsx.writeBuffer();
      const w = await handle.createWritable();
      await w.write(buf);
      await w.close();
      return true;
    } catch (e) { return false; }
  }

  async function syncAll(reason) {
    if (busy) { again = true; return; }
    busy = true;
    try {
      for (const id of handles.keys()) await syncOne(id, reason);
    } finally {
      busy = false;
      if (again) { again = false; setTimeout(() => syncAll('再実行'), 300); }
    }
  }

  /* ---------- 監視 ---------- */
  let timer = null;
  function startPolling() {
    clearInterval(timer);
    const sec = Math.max(2, (S().settings.wbs && S().settings.wbs.pollSec) || 5);
    timer = setInterval(async () => {
      if (busy) return;
      for (const [id, h] of handles) {
        try {
          const f = await h.getFile();
          const src = Store.source(id);
          const st = T.status(id).status;
          if (src && (f.lastModified !== src._lastModified || st === 'locked' || (dirty && src.mode === 'write'))) { await syncOne(id, '更新を検知'); }
        } catch (e) { setStatus(id, 'error', 'ファイルを読めません。移動・削除されていないか確認してください。'); }
      }
      dirty = false;
    }, sec * 1000);
  }
  // 取り込んだタスクを個人側で更新したら、書き戻し権限のある取込元に反映する
  let dirty = false;
  let debounce = null;
  Store.onChange((st, meta) => {
    if (['team', 'team-meta', 'wbs-meta', 'journal', 'settings', 'routine'].includes(meta.source)) return;
    if (!st.sources.some((s) => s.mode === 'write' && handles.has(s.id))) return;
    dirty = true;
    clearTimeout(debounce);
    debounce = setTimeout(() => { dirty = false; st.sources.filter((s) => s.mode === 'write' && handles.has(s.id)).forEach((s) => syncOne(s.id, '個人の変更')); }, 1500);
  });

  /* ---------- 登録・解除 ---------- */
  async function attach(id, handle, ask) {
    handles.set(id, handle);
    const opts = { mode: Store.source(id).mode === 'write' ? 'readwrite' : 'read' };
    let perm = await handle.queryPermission(opts);
    if (perm !== 'granted' && ask) perm = await handle.requestPermission(opts);
    if (perm !== 'granted') { handles.delete(id); pendingHandles.set(id, handle); setStatus(id, 'needs-permission', 'ボタンを押して読み取りを許可してください。'); return; }
    pendingHandles.delete(id);
    await lib.idbSet(keyOf(id), handle);
    await syncOne(id, '接続');
    startPolling();
  }
  const pendingHandles = new Map();

  T.add = async () => {
    if (!T.canAutoSync) return;
    let handle;
    try { [handle] = await root.showOpenFilePicker({ types: WBS.XLSX_TYPES, multiple: false }); } catch (e) { return; }
    const name = handle.name.replace(/\.xlsx$/i, '').replace(/[_]+/g, ' ');
    const src = Store.addSource({ id: Store.uid('src'), name, fileName: handle.name, mode: 'read', scope: 'mine', includeUnassigned: false, dismissed: [], seen: [], rows: [], lastRead: null });
    await attach(src.id, handle, true);
  };
  /** 自動同期できない環境: ファイルを選んで読み取るだけ（書き戻しはしない） */
  T.addFile = async (file, existingId) => {
    try {
      const { wb } = await loadWorkbook(file);
      const { records, noId } = parseWorkbook(wb);
      let src = existingId ? Store.source(existingId) : S().sources.find((s) => s.fileName === file.name);
      if (!src) src = Store.addSource({ id: Store.uid('src'), name: file.name.replace(/\.xlsx$/i, '').replace(/[_]+/g, ' '), fileName: file.name, mode: 'read', scope: 'mine', includeUnassigned: false, dismissed: [], seen: [], rows: [], lastRead: null });
      apply(src, records);
      Store.updateSource(src.id, { rows: records.map((r) => { const x = { ...r }; delete x._row; return x; }), lastRead: new Date().toISOString(), fileName: file.name });
      setStatus(src.id, 'offline', `${noId ? `ID のない行が ${noId} 件あります。` : ''}このブラウザでは自動で読み直せないため、更新されたら同じファイルをもう一度読み込んでください。`);
    } catch (e) { root.UI && root.UI.toast && root.UI.toast(`読み込めませんでした: ${e.message}`); }
  };
  T.reconnect = async (id) => { const h = pendingHandles.get(id) || await lib.idbGet(keyOf(id)); if (h) await attach(id, h, true); };
  T.syncNow = (id) => (id ? syncOne(id, '手動') : syncAll('手動'));
  T.remove = async (id) => { handles.delete(id); status.delete(id); await lib.idbDel(keyOf(id)); Store.removeSource(id); };
  T.setMode = async (id, mode) => {
    Store.updateSource(id, { mode });
    const h = handles.get(id);
    if (h && mode === 'write') await attach(id, h, true); // 書き込み許可を取り直す
  };
  T.isConnected = (id) => handles.has(id);

  /* ---------- 取り込み・無視・紐づけ ---------- */
  T.takeIn = (sourceId, ids) => {
    const src = Store.source(sourceId);
    if (!src) return 0;
    const st = S();
    const keys = [...Core.SOURCE_PLAN_KEYS, ...Core.SOURCE_EXEC_KEYS];
    let n = 0;
    Store.transaction(() => {
      for (const id of ids) {
        const rec = (src.rows || []).find((r) => String(r.wbsId) === String(id));
        if (!rec || st.tasks.some((t) => t.src && t.src.sourceId === sourceId && String(t.src.id) === String(id))) continue;
        const patch = Core.taskPatchFromRecord(rec, keys, (l1, l2) => Store.ensureCategory(l1, l2), null);
        Store.addTask({
          ...patch, notes: rec.notes || '',
          src: { sourceId, id: rec.wbsId, label: `${src.name}:${rec.wbsId}`, base: { ...rec }, deps: rec.deps ? rec.deps.split(',') : [] },
        }, `「${src.name}」から取り込み`, { source: 'team' });
        n++;
      }
      st.tasks.forEach((t) => { if (t.src && t.src.sourceId === sourceId) t.deps = Core.mapSourceDeps(t, st.tasks); });
      Store.addFeed([{ sourceId, kind: 'take', text: `「${src.name}」から ${n} 件取り込みました` }], false);
    }, { source: 'team' });
    return n;
  };
  T.dismiss = (sourceId, ids) => {
    const src = Store.source(sourceId);
    if (src) Store.updateSource(sourceId, { dismissed: [...new Set([...(src.dismissed || []), ...ids.map(String)])] });
  };
  T.unlink = (taskId) => { const t = Store.task(taskId); if (t) Store.updateTask(taskId, { src: null, deps: [] }, 'チームWBSとの紐づけを外した', { source: 'team' }); };
  T.resolveProblems = (sourceId, action) => {
    const p = T.problems(sourceId);
    const ids = [...p.removed, ...p.reassigned];
    Store.transaction(() => ids.forEach((id) => {
      if (action === 'delete') Store.deleteTask(id, { source: 'team' });
      else { const t = Store.task(id); if (t) t.src = null; }
    }), { source: 'team' });
    removedBy.set(sourceId, { removed: [], reassigned: [] });
    notify();
  };

  /** 個人タスクを共通WBSに追加する（書き戻し権限がある取込元のみ） */
  T.promote = async (taskId, sourceId) => {
    const src = Store.source(sourceId);
    const handle = handles.get(sourceId);
    const t = Store.task(taskId);
    if (!src || !handle || !t || src.mode !== 'write') return false;
    try {
      const { wb } = await loadWorkbook(handle);
      const { info, records } = parseWorkbook(wb);
      const st = S();
      const id = Core.nextIdLike(records.filter((r) => !r._noId).map((r) => r.wbsId));
      const rec = { ...Core.recordFromTask(t, st.categories, st.areas), wbsId: id, owner: t.owner || st.settings.myName || '', origin: '' };
      const { ws, cols } = info;
      const last = records.length ? Math.max(...records.map((r) => r._row)) : info.headerRow;
      const styleRow = last > info.headerRow ? ws.getRow(last) : null;
      const row = ws.getRow(last + 1);
      Object.entries(cols).forEach(([k, c]) => {
        const cell = row.getCell(c);
        if (styleRow) cell.style = { ...styleRow.getCell(c).style };
        if (k === 'wbsId') cell.value = id;
        else if (k === 'updated') cell.value = lib.stamp();
        else if (k !== 'origin') cell.value = Core.wbsDisplayValue(k, rec[k] ?? '');
      });
      if (!(await writeWorkbook(handle, wb))) { setStatus(sourceId, 'locked', 'ほかの人が開いているか、書き込み権限がないため追加できませんでした。'); return false; }
      Store.updateTask(taskId, { src: { sourceId, id, label: `${src.name}:${id}`, base: rec, deps: [] } }, `「${src.name}」に ${id} として追加`, { source: 'team' });
      Store.addFeed([{ sourceId, kind: 'promote', taskId, text: `「${t.title}」を ${src.name} に ${id} として追加しました` }]);
      return id;
    } catch (e) { setStatus(sourceId, 'error', e.message || String(e)); return false; }
  };

  /** 起動時: 保存してあるファイル参照で再接続 */
  T.boot = async () => {
    if (!T.canAutoSync) { notify(); return; }
    for (const src of S().sources) {
      const h = await lib.idbGet(keyOf(src.id));
      if (h) await attach(src.id, h, false);
    }
    notify();
  };

  root.Team = T;
})(window);
