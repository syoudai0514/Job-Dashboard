// Excel 同期の通しテスト。ファイル選択ダイアログだけをメモリ上の偽ファイルに差し替えて動かす。
// 実行: npm start（別ターミナル）→ npx playwright install chromium → npm run test:e2e
const { chromium } = require('playwright');
const URL = process.env.E2E_URL || 'http://localhost:8000/';
const assert = (c, m) => { if (!c) { console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok  :', m); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(() => {
    window.__file = { buf: null, mod: 1 };
    window.__locked = false;
    const handle = {
      name: 'WBS.xlsx', kind: 'file',
      queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      getFile: async () => new File([window.__file.buf || new Blob([])], 'WBS.xlsx', { lastModified: window.__file.mod }),
      createWritable: async () => ({ chunks: [], async write(d) { this.chunks.push(d); }, async close() { if (window.__locked) throw new Error('locked'); window.__file.buf = new Blob(this.chunks); window.__file.mod++; } }),
    };
    window.showSaveFilePicker = async () => handle;
    window.showOpenFilePicker = async () => [handle];
  });
  await p.goto(URL, { waitUntil: 'load' });
  await p.evaluate(() => { localStorage.clear(); });
  await p.reload({ waitUntil: 'load' });
  await p.click('.nav-btn[data-view="wbs"]');
  await p.click('[data-action="wbs-create"]');
  await p.waitForTimeout(3000);
  await p.waitForFunction(() => WBS.status === 'connected', null, { timeout: 8000 });
  assert(true, 'WBS を作成して接続');

  // Excel 内容を読む関数
  const readExcel = () => p.evaluate(async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await window.__file.buf.arrayBuffer());
    const ws = wb.getWorksheet('WBS'); const head = ws.getRow(1).values.slice(1); const map = Core.mapHeaders(head);
    const rows = [];
    ws.eachRow((r, n) => { if (n === 1) return; const o = {}; for (const [k, i] of Object.entries(map)) { let v = r.getCell(i + 1).value; if (v instanceof Date) v = v.toISOString().slice(0, 10); o[k] = v; } rows.push(o); });
    return rows;
  });
  let rows = await readExcel();
  assert(rows.length >= 18 && rows.every(r => r.wbsId), `Excel に ${rows.length} 行（全行 ID あり）`);
  assert(!rows.some(r => r.title === '9月分の交通費精算'), 'WBS 対象外のタスクは書き出さない');

  // --- Excel 側で編集（期限変更・状態変更・ID なしの新規行・分類空欄の新規行） ---
  await p.evaluate(async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await window.__file.buf.arrayBuffer());
    const ws = wb.getWorksheet('WBS'); const map = Core.mapHeaders(ws.getRow(1).values.slice(1)); const c = (k) => map[k] + 1;
    ws.eachRow((r, n) => {
      if (r.getCell(c('wbsId')).value === 'W-102') r.getCell(c('due')).value = new Date(Date.UTC(2026, 9, 20));
      if (r.getCell(c('wbsId')).value === 'W-301') { r.getCell(c('status')).value = '完了'; }
    });
    const n = ws.rowCount + 1;
    const r1 = ws.getRow(n); r1.getCell(c('l1')).value = '業務'; r1.getCell(c('l2')).value = '開発推進'; r1.getCell(c('l3')).value = 'テスト自動化'; r1.getCell(c('title')).value = 'E2Eテストの導入検討'; r1.getCell(c('priority')).value = '高'; r1.getCell(c('difficulty')).value = '高'; r1.getCell(c('deps')).value = 'W-302';
    const r2 = ws.getRow(n + 1); r2.getCell(c('title')).value = 'テスト方針のドラフト'; r2.getCell(c('estimate' in map ? 'estimate' : 'estimateH')).value = 4;
    const r3 = ws.getRow(n + 2); r3.getCell(c('l1')).value = 'お客様A案件'; r3.getCell(c('l2')).value = '要件定義'; r3.getCell(c('title')).value = 'ヒアリング準備';
    window.__file.buf = new Blob([await wb.xlsx.writeBuffer()]); window.__file.mod += 10;
  });
  await p.waitForFunction(() => Store.state.tasks.some(t => t.title === 'テスト方針のドラフト'), null, { timeout: 12000 });
  const st1 = await p.evaluate(() => {
    const by = (w) => Store.state.tasks.find(t => t.wbsId === w);
    const draft = Store.state.tasks.find(t => t.title === 'テスト方針のドラフト');
    const e2e = Store.state.tasks.find(t => t.title === 'E2Eテストの導入検討');
    const hear = Store.state.tasks.find(t => t.title === 'ヒアリング準備');
    return { due102: by('W-102').due, st301: by('W-301').status, draft: { l3: draft.l3, cat: Store.category(draft.categoryId).name, est: draft.estimate, id: draft.wbsId },
      e2e: { pr: e2e.priority, df: e2e.difficulty, deps: e2e.deps }, hearArea: Core.AREAS[Store.category(hear.categoryId).area], log: Store.state.wbs.log };
  });
  assert(st1.due102 === '2026-10-20', 'Excel の期限変更を取り込み');
  assert(st1.st301 === 'done', 'Excel の状態変更（完了）を取り込み');
  assert(st1.draft.l3 === 'テスト自動化' && st1.draft.cat === '開発推進' && st1.draft.est === 240, '分類空欄の行は上の行を引き継ぐ・見積(h)→分');
  assert(st1.e2e.pr === 1 && st1.e2e.df === 3 && st1.e2e.deps[0] === 'W-302', '重要度・難易度・先行を取り込み');
  assert(st1.hearArea === 'お客様A案件', '新しい大分類を自動で追加');
  await p.waitForTimeout(300);
  rows = await readExcel();
  assert(rows.filter(r => !r.wbsId).length === 0, `ID なしの行に採番して書き戻し（${st1.draft.id}）`);
  assert(rows.find(r => r.title === 'テスト方針のドラフト').l2 == null, '引き継ぎ空欄のセルはそのまま');

  // --- ダッシュボード側で編集 → Excel に書き戻し ---
  await p.evaluate(() => { const t = Store.state.tasks.find(t => t.wbsId === 'W-103'); Store.updateTask(t.id, { progress: 40 }); });
  await p.waitForFunction(async () => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await window.__file.buf.arrayBuffer()); let ok = false; const ws = wb.getWorksheet('WBS'); const map = Core.mapHeaders(ws.getRow(1).values.slice(1)); ws.eachRow(r => { if (r.getCell(map.wbsId + 1).value === 'W-103' && r.getCell(map.progress + 1).value === 40 && r.getCell(map.status + 1).value === '進行中') ok = true; }); return ok; }, null, { timeout: 8000, polling: 300 });
  assert(true, 'ダッシュボードの進捗40%（→進行中）を Excel に書き戻し');

  // --- Excel で開いている（ロック）→ 閉じたら書き込み ---
  await p.evaluate(() => { window.__locked = true; const t = Store.state.tasks.find(t => t.wbsId === 'W-104'); Store.updateTask(t.id, { status: 'done' }); });
  await p.waitForFunction(() => WBS.status === 'locked', null, { timeout: 8000 });
  assert(true, 'ロック中は「書き込み待ち」になる');
  // ロック中に Excel 側で別の項目を編集して保存
  await p.evaluate(async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await window.__file.buf.arrayBuffer());
    const ws = wb.getWorksheet('WBS'); const map = Core.mapHeaders(ws.getRow(1).values.slice(1));
    ws.eachRow(r => { if (r.getCell(map.wbsId + 1).value === 'W-104') r.getCell(map.notes + 1).value = '部長確認済み'; });
    window.__file.buf = new Blob([await wb.xlsx.writeBuffer()]); window.__file.mod += 10;
  });
  await p.waitForTimeout(6000);
  const mid = await p.evaluate(() => { const t = Store.state.tasks.find(t => t.wbsId === 'W-104'); return { st: t.status, notes: t.notes, s: WBS.status }; });
  assert(mid.st === 'done' && mid.notes === '部長確認済み', 'ロック中も Excel の変更は取り込み、ダッシュボードの完了は保持');
  await p.evaluate(() => { window.__locked = false; });
  await p.waitForFunction(() => WBS.status === 'connected', null, { timeout: 12000 });
  rows = await readExcel();
  const r104 = rows.find(r => r.wbsId === 'W-104');
  assert(r104.status === '完了' && r104.progress === 100 && r104.notes === '部長確認済み', 'ロック解除後に完了を書き込み（Excel のメモも残る）');

  // --- Excel で行を削除 → 削除の確認 ---
  await p.evaluate(async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await window.__file.buf.arrayBuffer());
    const ws = wb.getWorksheet('WBS'); const map = Core.mapHeaders(ws.getRow(1).values.slice(1));
    let del = 0; ws.eachRow((r, n) => { if (r.getCell(map.wbsId + 1).value === 'W-113') del = n; }); ws.spliceRows(del, 1);
    window.__file.buf = new Blob([await wb.xlsx.writeBuffer()]); window.__file.mod += 10;
  });
  await p.waitForFunction(() => WBS.missing.length === 1, null, { timeout: 12000 });
  assert(await p.evaluate(() => !!Store.state.tasks.find(t => t.wbsId === 'W-113')), 'Excel で消えた行は確認するまで消さない');
  assert(!errs.length, `ページのエラーなし ${errs.join(' / ')}`);
  await b.close();
})();
