// Excel 同期の通しテスト。ファイル選択ダイアログだけをメモリ上の偽ファイルに差し替えて動かす。
// 実行: npm start（別ターミナル）→ npx playwright install chromium → npm run test:e2e
const { chromium } = require('playwright');
const URL = process.env.E2E_URL || 'http://localhost:8000/';
const assert = (c, m) => { if (!c) { console.log('FAIL:', m); process.exitCode = 1; } else console.log('ok  :', m); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(() => {
    const mk = (name) => {
      const f = { buf: null, mod: 1, locked: false };
      return { f, h: { name, kind: 'file', queryPermission: async () => 'granted', requestPermission: async () => 'granted',
        getFile: async () => new File([f.buf || new Blob([])], name, { lastModified: f.mod }),
        createWritable: async () => ({ chunks: [], async write(d) { this.chunks.push(d); }, async close() { if (f.locked) throw new Error('locked'); f.buf = new Blob(this.chunks); f.mod++; } }) } };
    };
    window.__team = mk('開発部_共通WBS.xlsx');
    window.__mine = mk('個人WBS.xlsx');
    window.showOpenFilePicker = async () => [window.__team.h];
    window.showSaveFilePicker = async () => window.__mine.h;
  });
  await p.goto(URL); await p.evaluate(() => localStorage.clear()); await p.reload({ waitUntil: 'load' });
  // 空の状態で開始し、自分の名前を設定
  await p.evaluate(async () => {
    Store.clearSample(); Store.updateSettings({ myName: '山田' });
    const rec = (o) => ({ wbsId: '', l1: '業務', l2: '開発推進', l3: 'CI', title: '', owner: '山田', priority: '2', difficulty: '2', interrupt: '', start: '', due: '', estimateH: '4', progress: '0', status: 'todo', deps: '', completedOn: '', notes: '', origin: '', ...o });
    const wb = Core.buildWbsWorkbook(ExcelJS, [
      rec({ wbsId: 'D-001', title: '環境払い出し', owner: '鈴木', due: '2026-10-05', status: 'doing', progress: '50' }),
      rec({ wbsId: 'D-002', title: 'パイプライン構築', due: '2026-10-16', deps: 'D-001' }),
      rec({ wbsId: 'D-003', title: '手順書更新', due: '2026-10-20', deps: 'D-002' }),
      rec({ wbsId: 'D-004', title: '負荷試験', owner: '高橋', due: '2026-10-25' }),
    ]);
    window.__team.f.buf = new Blob([await wb.xlsx.writeBuffer()]);
  });
  await p.click('.nav-btn[data-view="team"]');
  await p.click('[data-action="team-add"]');
  await p.waitForFunction(() => Store.state.sources.length === 1 && Store.state.sources[0].rows.length === 4, null, { timeout: 8000 });
  const inbox = await p.evaluate(() => Core.sourceInbox(Store.state.sources[0].rows, Store.state.tasks, Store.state.sources[0], '山田').map(r => r.wbsId));
  assert(inbox.join() === 'D-002,D-003', `自分担当だけが新着に出る（${inbox}）`);
  // 個人WBSを作成して接続
  await p.click('.nav-btn[data-view="wbs"]'); await p.click('[data-action="wbs-create"]');
  await p.waitForFunction(() => WBS.status === 'connected', null, { timeout: 8000 });
  // 取り込み
  await p.click('.nav-btn[data-view="team"]');
  await p.click('[data-action="inbox-take"]');
  await p.waitForTimeout(2500);
  const t1 = await p.evaluate(() => Store.state.tasks.filter(t => t.src).map(t => ({ title: t.title, due: t.due, deps: t.deps, wbsId: t.wbsId })));
  assert(t1.length === 2 && t1.every(t => t.wbsId), `2件取り込み、個人WBSの ID も採番（${t1.map(t => t.wbsId)}）`);
  assert(t1.find(t => t.title === '手順書更新').deps[0] === t1.find(t => t.title === 'パイプライン構築').wbsId, '先行のつながりを個人側でも再現');
  const personal = await p.evaluate(async () => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await __mine.f.buf.arrayBuffer()); const ws = wb.getWorksheet('WBS'); const m = Core.mapHeaders(ws.getRow(1).values.slice(1)); const out = []; ws.eachRow((r, n) => { if (n > 1) out.push([r.getCell(m.title + 1).value, r.getCell(m.origin + 1).value]); }); return out; });
  assert(personal.some(r => r[0] === '手順書更新' && /D-003/.test(r[1])), '個人WBS（Excel）に取込元つきで追加');
  // 上流の遅延
  const ups = await p.evaluate(() => Core.upstreamIssues(Store.state.tasks, Store.state.sources, Core.todayISO(), Core.schedule(Store.state.tasks, Core.todayISO(), Store.state.settings)).map(u => u.text));
  assert(ups.some(t => /鈴木さん担当.*過ぎ/.test(t)), '他メンバーの先行タスクの遅延を検出');
  // チームWBSで期限変更 + 新タスク追加
  await p.evaluate(async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await __team.f.buf.arrayBuffer()); const ws = wb.getWorksheet('WBS'); const m = Core.mapHeaders(ws.getRow(1).values.slice(1));
    ws.eachRow(r => { if (r.getCell(m.wbsId + 1).value === 'D-002') r.getCell(m.due + 1).value = new Date(Date.UTC(2026, 9, 14)); });
    const r = ws.getRow(ws.rowCount + 1); r.getCell(m.wbsId + 1).value = 'D-005'; r.getCell(m.title + 1).value = 'セキュリティ診断'; r.getCell(m.owner + 1).value = '山田'; r.getCell(m.l1 + 1).value = '業務'; r.getCell(m.l2 + 1).value = '開発推進';
    __team.f.buf = new Blob([await wb.xlsx.writeBuffer()]); __team.f.mod += 10;
  });
  await p.waitForFunction(() => Store.state.tasks.find(t => t.title === 'パイプライン構築').due === '2026-10-14', null, { timeout: 12000 });
  const feed = await p.evaluate(() => Store.state.feed.slice(0, 3).map(f => f.text));
  assert(true, 'チームWBSの期限変更を個人タスクに自動反映');
  assert(feed.some(t => /期限: 10\/16\(金\) → 10\/14\(水\)/.test(t)) && feed.some(t => /新しいタスク: D-005/.test(t)), `通知に変更と新着（${feed.join(' / ')}）`);
  await p.waitForTimeout(6500);
  const personalDue = await p.evaluate(async () => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await __mine.f.buf.arrayBuffer()); const ws = wb.getWorksheet('WBS'); const m = Core.mapHeaders(ws.getRow(1).values.slice(1)); let d = null; ws.eachRow(r => { if (r.getCell(m.title + 1).value === 'パイプライン構築') d = r.getCell(m.due + 1).value; }); return d && d.toISOString().slice(0, 10); });
  assert(personalDue === '2026-10-14', '変更が個人WBS（Excel）にも伝わる');
  // 読み取りのみ: 進捗は書き戻さない
  const readTeam = async () => p.evaluate(async () => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await __team.f.buf.arrayBuffer()); const ws = wb.getWorksheet('WBS'); const m = Core.mapHeaders(ws.getRow(1).values.slice(1)); const o = {}; ws.eachRow((r, n) => { if (n > 1) o[r.getCell(m.wbsId + 1).value] = { progress: r.getCell(m.progress + 1).value, status: r.getCell(m.status + 1).value, title: r.getCell(m.title + 1).value }; }); return o; });
  await p.evaluate(() => { const t = Store.state.tasks.find(t => t.title === 'パイプライン構築'); Store.updateTask(t.id, { progress: 30 }); });
  await p.waitForTimeout(4000);
  let team = await readTeam();
  assert(team['D-002'].progress !== 30, '読み取りのみの取込元には進捗を書かない');
  // 書き戻しありに変更
  await p.evaluate(() => Team.setMode(Store.state.sources[0].id, 'write'));
  await p.waitForTimeout(500);
  await p.evaluate(() => { const t = Store.state.tasks.find(t => t.title === 'パイプライン構築'); Store.updateTask(t.id, { progress: 60 }); });
  await p.waitForFunction(async () => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await __team.f.buf.arrayBuffer()); const ws = wb.getWorksheet('WBS'); const m = Core.mapHeaders(ws.getRow(1).values.slice(1)); let ok = false; ws.eachRow(r => { if (r.getCell(m.wbsId + 1).value === 'D-002' && r.getCell(m.progress + 1).value === 60 && r.getCell(m.status + 1).value === '進行中') ok = true; }); return ok; }, null, { timeout: 12000, polling: 500 });
  assert(true, '書き戻しありなら進捗60%・進行中をチームWBSへ書き戻し');
  // 個人タスクを共通WBSへ追加
  const id = await p.evaluate(async () => { const t = Store.addTask({ title: '性能測定の観点整理', categoryId: 'dev', due: '2026-10-23', estimate: 120 }); return Team.promote(t.id, Store.state.sources[0].id); });
  team = await readTeam();
  assert(id === 'D-006' && team['D-006'] && team['D-006'].title === '性能測定の観点整理', `個人タスクを共通WBSに ${id} として追加`);
  // チームWBSから行を削除 → 確認待ち
  await p.evaluate(async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await __team.f.buf.arrayBuffer()); const ws = wb.getWorksheet('WBS'); const m = Core.mapHeaders(ws.getRow(1).values.slice(1));
    let del = 0; ws.eachRow((r, n) => { if (r.getCell(m.wbsId + 1).value === 'D-003') del = n; }); ws.spliceRows(del, 1);
    __team.f.buf = new Blob([await wb.xlsx.writeBuffer()]); __team.f.mod += 10;
  });
  await p.waitForFunction(() => Team.problems(Store.state.sources[0].id).removed.length === 1, null, { timeout: 12000 });
  assert(await p.evaluate(() => !!Store.state.tasks.find(t => t.title === '手順書更新')), 'チームWBSで消えたタスクは確認するまで残す');
  assert(!errs.length, `ページのエラーなし ${errs.join(' / ')}`);
  await b.close();
})();
