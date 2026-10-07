/*
 * wbs-sync.js — Excel の WBS ファイルとの同期（ブラウザ専用。ExcelJS と File System Access API を使う）
 *
 * 自動同期（Edge / Chrome）
 *   - 「Excel に接続」で選んだファイルの参照を IndexedDB に保存し、次回以降も同じファイルを使う
 *   - 数秒おきにファイルの更新日時を確認し、Excel で保存された変更を取り込む
 *   - ダッシュボードで変更すると、少し待ってから Excel に書き込む
 *   - Excel で開いている間は書き込めない（ファイルがロックされる）ので、閉じたときに書き込む
 * 手動同期（それ以外のブラウザ）
 *   - 「Excel を読み込む」で取り込み、「Excel に書き出す」で反映済みのファイルを保存する
 */
(function (root) {
  'use strict';
  const { Core, Store } = root;
  const listeners = [];
  const HANDLE_KEY = 'wbs-file';

  const canAutoSync = (() => {
    try { return typeof root.showOpenFilePicker === 'function' && root.self === root.top; } catch (e) { return false; }
  })();

  const W = {
    canAutoSync,
    status: canAutoSync ? 'disconnected' : 'manual',
    message: '',
    handle: null,
    fileName: '',
    lastModified: 0,
    syncing: false,
    again: false,
    dirty: false,
    manualBuffer: null, // 手動同期で作った反映済みファイル
    pendingWrites: 0,
    missing: [], // Excel から消えたタスク
  };

  const notify = () => listeners.forEach((fn) => fn(W));
  const setStatus = (status, message) => { W.status = status; W.message = message || ''; notify(); };
  const hasExcel = () => typeof root.ExcelJS !== 'undefined';

  /* ---------- IndexedDB（ファイル参照の保存） ---------- */
  const idb = (mode, fn) => new Promise((resolve, reject) => {
    const open = indexedDB.open('job-dashboard', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      try {
        const tx = open.result.transaction('kv', mode);
        const req = fn(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      } catch (e) { reject(e); } // 保存できない値など
    };
  });
  const idbGet = (k) => idb('readonly', (s) => s.get(k)).catch(() => null);
  const idbSet = (k, v) => idb('readwrite', (s) => s.put(v, k)).catch(() => null);
  const idbDel = (k) => idb('readwrite', (s) => s.delete(k)).catch(() => null);

  /* ---------- ブックの読み取り ---------- */
  const cellRaw = (cell) => {
    let v = cell.value;
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v;
    if (typeof v === 'object') {
      if ('result' in v) v = v.result;
      else if (v.richText) v = v.richText.map((r) => r.text).join('');
      else if ('text' in v) v = v.text;
      else if (v.error) return '';
    }
    return v ?? '';
  };
  const isFormula = (cell) => !!(cell.formula || (cell.value && typeof cell.value === 'object' && ('formula' in cell.value || 'sharedFormula' in cell.value)));
  const isMergedSlave = (cell) => cell.isMerged && cell.master && cell.master.address !== cell.address;

  /** 見出し（「タスク」列）がある最初のシートを探す。「WBS」という名前のシートを優先 */
  function locate(wb) {
    const sheets = [...wb.worksheets].sort((a, b) => (b.name.toUpperCase() === 'WBS') - (a.name.toUpperCase() === 'WBS'));
    for (const ws of sheets) {
      for (let r = 1; r <= Math.min(15, ws.rowCount); r++) {
        const row = ws.getRow(r);
        const cells = [];
        for (let c = 1; c <= Math.max(row.cellCount, 1); c++) cells.push(String(cellRaw(row.getCell(c)) ?? ''));
        const map = Core.mapHeaders(cells);
        if (map.title !== undefined) {
          const cols = {};
          Object.entries(map).forEach(([k, i]) => { cols[k] = i + 1; });
          return { ws, headerRow: r, cols };
        }
      }
    }
    return null;
  }

  function readRows(info) {
    const { ws, headerRow, cols } = info;
    const rows = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells = {};
      let any = false;
      for (const [k, c] of Object.entries(cols)) {
        const v = cellRaw(row.getCell(c));
        cells[k] = v;
        if (v !== '' && v !== null) any = true;
      }
      if (any) rows.push({ rowNumber: r, cells });
    }
    return rows;
  }

  const stamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const labelOf = (keys) => keys.map((k) => Core.WBS_FIELD_LABEL[k]).join('・');
  const shortVal = (k, v) => (v === '' ? '（空）' : k === 'status' ? Core.STATUS[v] : k === 'priority' ? Core.PRIORITY[v] : k === 'difficulty' ? Core.DIFFICULTY[v] : v);

  /**
   * 1回分の同期。wb を読み、ダッシュボードへ反映し、Excel 側に書くべき変更を wb に書き込む。
   * 戻り値: { log, wroteExcel, finalize(): 書き込み成功後に呼ぶ }
   */
  function reconcile(wb, reason) {
    const info = locate(wb);
    if (!info) throw new Error('「タスク」という見出しの列が見つかりません。WBS テンプレートを作成して使うか、見出し名を合わせてください。');
    if (!info.cols.wbsId) throw new Error('「ID」列が見つかりません。見出しが「ID」の列を追加してください（中身は空欄で構いません）。');
    const st = Store.state;
    const keys = Core.WBS_SYNC_KEYS.filter((k) => info.cols[k] !== undefined);
    const parsed = Core.readWbsRows(readRows(info));
    const log = { at: new Date().toISOString(), reason, created: [], toTask: [], toExcel: [], appended: [], conflicts: [], skipped: [], duplicates: [], missing: [] };

    const allIds = new Set([...parsed.map((p) => p.rec.wbsId).filter(Boolean), ...st.tasks.map((t) => t.wbsId).filter(Boolean)]);
    const byId = new Map(st.tasks.filter((t) => t.wbsId).map((t) => [String(t.wbsId), t]));
    const seen = new Set();
    const cellWrites = []; // { row, key, value }
    const finalizers = [];
    let wroteExcel = false;

    const resolve = (l1, l2) => Store.ensureCategory(l1, l2);

    Store.transaction(() => {
      // 先に、これから行を追加するタスクに ID を振り、チームWBS由来の先行のつながりを ID で付け直す
      for (const t of st.tasks) {
        if (t.wbsSkip || t.recurringId || t.wbsId) continue;
        if (!st.settings.wbs.appendNew && !t.src) continue;
        t.wbsId = Core.nextWbsId(allIds); allIds.add(t.wbsId);
      }
      if (Core.mapSourceDeps) {
        st.tasks.forEach((t) => {
          if (!t.src) return;
          const deps = Core.mapSourceDeps(t, st.tasks);
          if (deps.join(',') !== (t.deps || []).join(',')) t.deps = deps;
        });
      }
      for (const p of parsed) {
        const hadId = !!p.rec.wbsId;
        let id = p.rec.wbsId;
        if (!id) {
          // 前回 ID を書き込めなかった行は、同じタスク名のタスクに結びつける
          const pending = st.tasks.find((t) => t.wbsPendingId && t.title === p.rec.title && !seen.has(t.wbsId));
          id = pending ? pending.wbsId : Core.nextWbsId(allIds);
          allIds.add(id);
          p.rec.wbsId = id;
          cellWrites.push({ row: p.rowNumber, key: 'wbsId', value: id });
          if (pending) byId.set(id, pending);
        }
        if (seen.has(id)) { log.duplicates.push(`${id}（${p.rowNumber}行目）`); continue; }
        seen.add(id);
        const task = byId.get(id);
        if (!task) {
          const patch = Core.taskPatchFromRecord(p.rec, keys, resolve, null);
          const t = Store.addTask({ ...patch, wbsId: id, wbsBase: { ...p.rec }, wbsPendingId: !hadId }, 'WBSから追加', { source: 'wbs' });
          log.created.push(t.title);
          if (t.wbsPendingId) finalizers.push(() => { t.wbsPendingId = false; });
          continue;
        }
        const da = Core.recordFromTask(task, Store.state.categories, Store.state.areas);
        const m = Core.mergeRecord(p.rec, da, task.wbsBase, keys);
        if (m.toTask.length) {
          const patch = Core.taskPatchFromRecord(m.merged, m.toTask, resolve, task);
          Store.updateTask(task.id, patch, `WBSの変更を反映（${labelOf(m.toTask)}）`, { source: 'wbs' });
          log.toTask.push(`${task.title}: ${labelOf(m.toTask)}`);
        }
        m.conflicts.forEach((c) => log.conflicts.push(`${task.title}「${Core.WBS_FIELD_LABEL[c.key]}」Excel=${shortVal(c.key, c.excel)} / ダッシュボード=${shortVal(c.key, c.dash)} → ${c.winner === 'excel' ? 'Excel' : 'ダッシュボード'}を採用`));
        // 基準値: Excel に書けた項目だけ新しい値にする（書けなかったら次回もう一度書く）
        const base = { ...(task.wbsBase || {}), ...m.merged, wbsId: id };
        m.toExcel.forEach((k) => { base[k] = p.rec[k]; });
        task.wbsBase = base;
        if (m.toExcel.length) {
          m.toExcel.forEach((k) => cellWrites.push({ row: p.rowNumber, key: k, value: m.merged[k], parsed: p }));
          log.toExcel.push(`${task.title}: ${labelOf(m.toExcel)}`);
          finalizers.push(() => { m.toExcel.forEach((k) => { task.wbsBase[k] = m.merged[k]; }); });
        }
        if (task.wbsPendingId) {
          if (hadId) task.wbsPendingId = false;
          else finalizers.push(() => { task.wbsPendingId = false; });
        }
      }

      // Excel に無いタスク
      W.missing = [];
      for (const t of Store.state.tasks) {
        if (t.wbsSkip || t.recurringId) continue;
        if (t.wbsId && seen.has(String(t.wbsId))) continue;
        if (t.wbsId && t.wbsBase) { W.missing.push(t.id); log.missing.push(t.title); continue; } // 前回あった → Excel で削除された
        if (!t.wbsId && !st.settings.wbs.appendNew && !t.src) continue; // チームWBSから取り込んだタスクは常に載せる
        if (!t.wbsId) { t.wbsId = Core.nextWbsId(allIds); allIds.add(t.wbsId); }
        const rec = Core.recordFromTask(t, Store.state.categories, Store.state.areas);
        cellWrites.push({ append: true, rec, task: t });
        log.appended.push(t.title);
        finalizers.push(() => { t.wbsBase = { ...rec }; });
      }
    }, { source: 'wbs' });

    // ---- wb への書き込み ----
    const { ws, cols } = info;
    const lastRow = parsed.length ? Math.max(...parsed.map((p) => p.rowNumber)) : info.headerRow;
    const touched = new Set();
    const put = (rowNum, key, value) => {
      const col = cols[key];
      if (!col) return;
      const cell = ws.getRow(rowNum).getCell(col);
      if (isFormula(cell)) { log.skipped.push(`${rowNum}行目「${Core.WBS_FIELD_LABEL[key]}」は数式のため書き込みませんでした`); return; }
      if (isMergedSlave(cell)) { log.skipped.push(`${rowNum}行目「${Core.WBS_FIELD_LABEL[key]}」は結合セルのため書き込みませんでした`); return; }
      cell.value = key === 'wbsId' ? value : Core.wbsDisplayValue(key, value);
      touched.add(rowNum);
      wroteExcel = true;
    };
    for (const w of cellWrites.filter((x) => !x.append)) {
      // 分類を書き換えるときは、下の行が引き継いでいた値を明示して崩れないようにする
      if (['l1', 'l2', 'l3'].includes(w.key) && w.parsed) {
        const idx = parsed.indexOf(w.parsed);
        for (let i = idx + 1; i < parsed.length && parsed[i].inherited[w.key]; i++) put(parsed[i].rowNumber, w.key, parsed[i].rec[w.key]);
      }
      put(w.row, w.key, w.value);
    }
    const styleRow = lastRow > info.headerRow ? ws.getRow(lastRow) : null;
    let next = lastRow + 1;
    for (const w of cellWrites.filter((x) => x.append)) {
      const row = ws.getRow(next);
      Object.entries(cols).forEach(([k, c]) => {
        const cell = row.getCell(c);
        if (styleRow) cell.style = { ...styleRow.getCell(c).style };
        if (k === 'wbsId') cell.value = w.rec.wbsId;
        else if (k !== 'updated') cell.value = Core.wbsDisplayValue(k, w.rec[k] ?? '');
        if (['start', 'due', 'completedOn'].includes(k)) cell.numFmt = 'yyyy/mm/dd';
      });
      touched.add(next);
      wroteExcel = true;
      next++;
    }
    if (cols.updated) touched.forEach((r) => { const c = ws.getRow(r).getCell(cols.updated); if (!isFormula(c)) c.value = stamp(); });

    return {
      log, wroteExcel,
      finalize() { Store.transaction(() => finalizers.forEach((f) => f()), { source: 'wbs' }); },
    };
  }

  /* ---------- 自動同期 ---------- */
  async function ensurePermission(handle, ask) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (!ask) return false;
    return (await handle.requestPermission(opts)) === 'granted';
  }

  async function syncNow(reason) {
    if (!W.handle || !hasExcel()) return;
    if (W.syncing) { W.again = true; return; }
    W.syncing = true;
    W.dirty = false;
    setStatus('syncing', '同期しています…');
    try {
      const file = await W.handle.getFile();
      W.lastModified = file.lastModified;
      const wb = new root.ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      const res = reconcile(wb, reason);
      if (res.wroteExcel) {
        try {
          const buf = await wb.xlsx.writeBuffer();
          const writable = await W.handle.createWritable();
          await writable.write(buf);
          await writable.close();
          W.lastModified = (await W.handle.getFile()).lastModified;
          res.finalize();
          W.pendingWrites = 0;
        } catch (e) {
          W.pendingWrites = res.log.toExcel.length + res.log.appended.length + 1;
          Store.setWbsMeta({ log: res.log, lastSync: new Date().toISOString() });
          setStatus('locked', 'Excel で開いているため、ダッシュボードの変更をまだ書き込めていません。Excel を閉じると自動で書き込みます。');
          return;
        }
      }
      Store.setWbsMeta({ fileName: W.fileName, lastSync: new Date().toISOString(), log: res.log });
      setStatus('connected', '');
    } catch (e) {
      setStatus('error', e.message || String(e));
    } finally {
      W.syncing = false;
      if (W.again) { W.again = false; setTimeout(() => syncNow('再実行'), 300); }
    }
  }

  let pollTimer = null;
  function startPolling() {
    clearInterval(pollTimer);
    const sec = Math.max(2, (Store.state.settings.wbs && Store.state.settings.wbs.pollSec) || 5);
    pollTimer = setInterval(async () => {
      if (!W.handle || W.syncing || !['connected', 'locked', 'error'].includes(W.status)) return;
      try {
        const f = await W.handle.getFile();
        if (f.lastModified !== W.lastModified) syncNow('Excelが保存された');
        else if (W.dirty || W.status === 'locked') syncNow(W.status === 'locked' ? '書き込みの再試行' : 'ダッシュボードの変更');
      } catch (e) { setStatus('error', 'ファイルを読めません。移動・削除されていないか確認してください。'); }
    }, sec * 1000);
  }

  let debounce = null;
  Store.onChange((st, meta) => {
    if (['wbs', 'wbs-meta', 'team-meta', 'journal', 'settings', 'routine'].includes(meta.source)) return;
    W.dirty = true;
    if (W.handle && W.status === 'connected') {
      clearTimeout(debounce);
      debounce = setTimeout(() => syncNow('ダッシュボードの変更'), 1500);
    }
  });

  async function attach(handle, ask) {
    W.handle = handle;
    W.fileName = handle.name;
    if (!(await ensurePermission(handle, ask))) {
      setStatus('needs-permission', `前回の WBS（${handle.name}）に再接続するには、ボタンを押して読み書きを許可してください。`);
      return false;
    }
    await idbSet(HANDLE_KEY, handle);
    W.lastModified = 0;
    await syncNow('接続');
    startPolling();
    return true;
  }

  const XLSX_TYPES = W.XLSX_TYPES = [{ description: 'Excel ブック', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }];

  W.connect = async () => {
    if (!canAutoSync) return;
    let handle;
    try { [handle] = await root.showOpenFilePicker({ types: XLSX_TYPES, multiple: false }); } catch (e) { return; } // キャンセル
    if (Store.state.sample) Store.clearSample();
    await attach(handle, true);
  };
  W.reconnect = async () => { if (W.handle) await attach(W.handle, true); };
  W.disconnect = async () => {
    clearInterval(pollTimer);
    W.handle = null; W.fileName = ''; W.missing = [];
    await idbDel(HANDLE_KEY);
    Store.setWbsMeta({ fileName: '' });
    setStatus(canAutoSync ? 'disconnected' : 'manual', '');
  };
  W.syncNow = () => syncNow('手動');

  /** 今のタスクから WBS ファイルを新しく作る（自動同期できる環境ではそのまま接続する） */
  W.createNew = async () => {
    if (!hasExcel()) { setStatus('error', 'Excel 読み書き用のライブラリを読み込めませんでした。'); return; }
    const st = Store.state;
    const targets = st.tasks.filter((t) => !t.wbsSkip && !t.recurringId);
    const ids = new Set(st.tasks.map((t) => t.wbsId).filter(Boolean));
    Store.transaction(() => targets.forEach((t) => { if (!t.wbsId) { t.wbsId = Core.nextWbsId(ids); ids.add(t.wbsId); } }), { source: 'wbs' });
    const natural = (a, b) => String(a.wbsId).localeCompare(String(b.wbsId), 'ja', { numeric: true });
    const records = targets.slice().sort(natural).map((t) => ({ ...Core.recordFromTask(t, st.categories, st.areas), updated: stamp() }));
    const wb = Core.buildWbsWorkbook(root.ExcelJS, records);
    const buf = await wb.xlsx.writeBuffer();
    if (canAutoSync) {
      let handle;
      try { handle = await root.showSaveFilePicker({ suggestedName: 'WBS.xlsx', types: XLSX_TYPES }); } catch (e) { return; }
      const w = await handle.createWritable();
      await w.write(buf);
      await w.close();
      Store.transaction(() => targets.forEach((t) => { t.wbsBase = Core.recordFromTask(t, st.categories, st.areas); }), { source: 'wbs' });
      await attach(handle, true);
    } else {
      download(buf, 'WBS.xlsx');
      Store.transaction(() => targets.forEach((t) => { t.wbsBase = null; }), { source: 'wbs' });
    }
  };

  /* ---------- 手動同期 ---------- */
  function download(buf, name) {
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  W.importFile = async (file) => {
    if (!hasExcel()) { setStatus('error', 'Excel 読み書き用のライブラリを読み込めませんでした。'); return; }
    try {
      if (Store.state.sample) Store.clearSample();
      const wb = new root.ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      const res = reconcile(wb, '手動読み込み');
      // 手動同期では書き出したファイルで置き換えられたか分からないので、基準値は確定しない
      W.manualBuffer = res.wroteExcel ? await wb.xlsx.writeBuffer() : null;
      W.fileName = file.name;
      Store.setWbsMeta({ fileName: file.name, lastSync: new Date().toISOString(), log: res.log });
      setStatus('manual', res.wroteExcel ? 'ダッシュボード側の変更があります。「Excel に書き出す」で保存し、元のファイルと置き換えてください。' : '');
    } catch (e) { setStatus('error', e.message || String(e)); }
  };
  W.exportFile = () => { if (W.manualBuffer) download(W.manualBuffer, W.fileName || 'WBS.xlsx'); };

  /** Excel から消えたタスクの扱い */
  W.resolveMissing = (action) => {
    const ids = W.missing.slice();
    W.missing = [];
    Store.transaction(() => {
      ids.forEach((id) => {
        if (action === 'delete') Store.deleteTask(id, { source: 'wbs' });
        else { const t = Store.task(id); if (t) t.wbsBase = null; } // 次の同期で Excel に戻す
      });
    }, { source: action === 'delete' ? 'wbs' : 'user' });
    if (action !== 'delete') syncNow('Excelに戻す');
    notify();
  };

  W.onChange = (fn) => listeners.push(fn);
  /** チームWBSの同期（sources-sync.js）と共用する部品 */
  W.lib = { cellRaw, isFormula, isMergedSlave, locate, readRows, stamp, idbGet, idbSet, idbDel, canAutoSync, XLSX_TYPES };

  /** 起動時: 前回のファイルに自動で再接続（許可が切れていればボタン表示） */
  W.boot = async () => {
    if (!canAutoSync) { notify(); return; }
    const handle = await idbGet(HANDLE_KEY);
    if (handle) await attach(handle, false);
    else notify();
  };

  root.WBS = W;
})(window);
