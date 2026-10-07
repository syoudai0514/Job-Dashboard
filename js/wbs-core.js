/*
 * wbs-core.js — Excel の WBS とダッシュボードの対応づけ（画面・ファイルに依存しない純粋ロジック）
 *
 * 同期の考え方
 *   - 1行 = 1タスク。「ID」列で対応づける（空欄の行にはダッシュボードが W-001 形式で採番して書き戻す）
 *   - 列は見出しの名前で探す（列の順番・余分な列は自由）。見つからない列は同期しない
 *   - 大分類・中分類・小分類が空欄の行は、上の行の値を引き継ぐ（セル結合風の書き方に対応）
 *   - 前回同期した時点の値（base）と比べて、変わった側の値を採用する（項目ごとの3方向マージ）
 *   - 両方で変わっていたら、実行系の項目（状態・進捗・完了日）はダッシュボード、それ以外は Excel を優先
 */
(function (root) {
  'use strict';
  const { Core } = root;

  /** key: 内部名 / headers: 見出しの候補（先頭一致も可） */
  Core.WBS_FIELDS = [
    { key: 'wbsId', label: 'ID', headers: ['ID', 'WBS', 'WBSID', 'WBS番号', 'No', 'No.', '番号'], width: 9 },
    { key: 'l1', label: '大分類', headers: ['大分類', '大項目', '大'], width: 12 },
    { key: 'l2', label: '中分類', headers: ['中分類', '中項目', '中'], width: 14 },
    { key: 'l3', label: '小分類', headers: ['小分類', '小項目', '小'], width: 18 },
    { key: 'title', label: 'タスク', headers: ['タスク', 'タスク名', '作業', '作業内容', '作業項目'], width: 36 },
    { key: 'owner', label: '担当', headers: ['担当', '担当者'], width: 10 },
    { key: 'priority', label: '重要度', headers: ['重要度', '優先度'], width: 8 },
    { key: 'difficulty', label: '難易度', headers: ['難易度'], width: 8 },
    { key: 'interrupt', label: '突発', headers: ['突発', '割込', '割り込み'], width: 6 },
    { key: 'start', label: '開始予定', headers: ['開始予定', '開始予定日', '開始日', '開始'], width: 12 },
    { key: 'due', label: '期限', headers: ['期限', '期日', '締切', '終了予定', '終了予定日', '完了予定'], width: 12 },
    { key: 'estimateH', label: '見積(h)', headers: ['見積(h)', '見積', '工数(h)', '工数', '予定工数'], width: 9 },
    { key: 'progress', label: '進捗(%)', headers: ['進捗(%)', '進捗率', '進捗'], width: 9 },
    { key: 'status', label: '状態', headers: ['状態', 'ステータス'], width: 9 },
    { key: 'deps', label: '先行タスク', headers: ['先行タスク', '先行', '依存', '前提タスク'], width: 14 },
    { key: 'completedOn', label: '完了日', headers: ['完了日', '実績終了日', '完了実績'], width: 12 },
    { key: 'notes', label: '備考', headers: ['備考', 'メモ', 'コメント'], width: 30 },
    { key: 'updated', label: '最終更新', headers: ['最終更新', '更新日時', '更新日'], width: 17 },
  ];
  /** 両方で変わったときにダッシュボード側を優先する項目 */
  Core.WBS_EXEC_KEYS = ['status', 'progress', 'completedOn'];
  /** 同期対象の項目（ID・最終更新は除く） */
  Core.WBS_SYNC_KEYS = Core.WBS_FIELDS.map((f) => f.key).filter((k) => k !== 'wbsId' && k !== 'updated');
  const DATE_KEYS = ['start', 'due', 'completedOn'];

  Core.normHeader = (s) => String(s ?? '')
    .replace(/[（）]/g, (c) => (c === '（' ? '(' : ')'))
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]/g, '')
    .toUpperCase();

  /** 見出し行（文字列の配列、0始まり）→ { key: 列インデックス } */
  Core.mapHeaders = (headerCells) => {
    const norm = headerCells.map(Core.normHeader);
    const map = {};
    const used = new Set();
    for (const exact of [true, false]) {
      for (const f of Core.WBS_FIELDS) {
        if (map[f.key] !== undefined) continue;
        const cands = f.headers.map(Core.normHeader);
        const i = norm.findIndex((h, idx) => !used.has(idx) && h && cands.some((c) => (exact ? h === c : h.startsWith(c))));
        if (i !== -1) { map[f.key] = i; used.add(i); }
      }
    }
    return map;
  };

  /* ---------- 値の正規化（比較しやすい文字列にそろえる） ---------- */
  const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]' && !Number.isNaN(v.getTime());
  const isoFromUTCDate = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const LEVEL = { 高: '3', 中: '2', 低: '1', H: '3', M: '2', L: '1', A: '3', B: '2', C: '1', '◎': '3', '○': '2', '△': '1' };
  const STATUS_WORDS = [
    [/^(完了|済|完|done|close)/i, 'done'],
    [/^(待ち|保留|確認待|回答待|wait|pend|block)/i, 'waiting'],
    [/^(進行|着手|対応中|作業中|実施中|doing|wip|in ?progress)/i, 'doing'],
    [/^(未着手|未|todo|open|new)/i, 'todo'],
  ];

  /** Excel から読んだ生の値（文字列・数値・Date）を、項目ごとの正規形（文字列）にする */
  Core.parseWbsCell = (key, raw) => {
    if (raw === null || raw === undefined) return '';
    if (DATE_KEYS.includes(key)) {
      if (isDate(raw)) return isoFromUTCDate(raw);
      if (typeof raw === 'number' && raw > 20000 && raw < 80000) return isoFromUTCDate(new Date(Math.round((raw - 25569) * 86400000)));
      const m = String(raw).trim().match(/^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})/);
      return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
    }
    const s = String(isDate(raw) ? isoFromUTCDate(raw) : raw).trim();
    if (key === 'priority') {
      if (/^[123]$/.test(s)) return s; // 数値の 1=高
      const v = LEVEL[s.slice(0, 1).toUpperCase()];
      return v ? String(4 - Number(v)) : '';
    }
    if (key === 'difficulty') {
      if (/^[123]$/.test(s)) return s; // 数値は 3=高
      return LEVEL[s.slice(0, 1).toUpperCase()] || '';
    }
    if (key === 'interrupt') return /^(○|〇|◯|✓|✔|1|true|yes|y|あり|有|突発)/i.test(s) ? '1' : '';
    if (key === 'progress') {
      if (!s) return '';
      let n = parseFloat(s.replace('%', ''));
      if (Number.isNaN(n)) return '';
      if (typeof raw === 'number' && raw > 0 && raw <= 1 && !/%/.test(s)) n = raw * 100; // 0.5 = 50%
      return String(Math.max(0, Math.min(100, Math.round(n))));
    }
    if (key === 'estimateH') {
      const n = parseFloat(s);
      return Number.isNaN(n) ? '' : String(Math.round(n * 100) / 100);
    }
    if (key === 'status') {
      const hit = STATUS_WORDS.find(([re]) => re.test(s));
      return hit ? hit[1] : '';
    }
    if (key === 'deps') return s.split(/[,、，\s;；]+/).map((x) => x.trim()).filter(Boolean).sort().join(',');
    return s;
  };

  /**
   * シートの行 → レコード。rows: [{ rowNumber, cells: { key: 生の値 } }]
   * 大・中・小分類の空欄は上の行から引き継ぎ、inherited に記録する。タスク名が空の行は見出し・区切り行として飛ばす。
   */
  Core.readWbsRows = (rows) => {
    const carry = { l1: '', l2: '', l3: '' };
    const out = [];
    for (const r of rows) {
      const rec = {};
      for (const f of Core.WBS_FIELDS) rec[f.key] = Core.parseWbsCell(f.key, r.cells[f.key]);
      const inherited = {};
      // 上位が変わったら下位の引き継ぎは切る
      if (rec.l1) { if (rec.l1 !== carry.l1) { carry.l2 = ''; carry.l3 = ''; } carry.l1 = rec.l1; }
      if (rec.l2) { if (rec.l2 !== carry.l2) carry.l3 = ''; carry.l2 = rec.l2; }
      if (rec.l3) carry.l3 = rec.l3;
      for (const k of ['l1', 'l2', 'l3']) {
        if (!rec[k] && carry[k]) { rec[k] = carry[k]; inherited[k] = true; }
      }
      if (!rec.title) continue;
      if (!rec.status && rec.progress === '100') rec.status = 'done';
      else if (!rec.status) rec.status = Number(rec.progress) > 0 ? 'doing' : 'todo';
      out.push({ rowNumber: r.rowNumber, rec, inherited });
    }
    return out;
  };

  /** タスク → レコード（Excel と比べる形） */
  Core.recordFromTask = (task, categories, areas) => {
    const cat = categories.find((c) => c.id === task.categoryId);
    const done = task.status === 'done';
    return {
      wbsId: task.wbsId || '',
      l1: cat ? (areas[cat.area] || '') : '',
      l2: cat ? cat.name : '',
      l3: task.l3 || '',
      title: task.title || '',
      owner: task.owner || '',
      priority: String(task.priority || 2),
      difficulty: String(task.difficulty || 2),
      interrupt: task.interrupt ? '1' : '',
      start: task.start || '',
      due: task.due || '',
      estimateH: task.estimate ? String(Math.round((task.estimate / 60) * 100) / 100) : '',
      progress: String(done ? 100 : Math.max(0, Math.min(100, Math.round(task.progress || 0)))),
      status: task.status || 'todo',
      deps: (task.deps || []).map(String).sort().join(','),
      completedOn: done && task.completedAt ? task.completedAt.slice(0, 10) : '',
      notes: task.notes || '',
    };
  };

  /**
   * レコード（の一部）→ タスクの更新内容。
   * resolveCategory(l1, l2) は categoryId を返す（なければ作る）関数。
   */
  Core.taskPatchFromRecord = (rec, keys, resolveCategory, current) => {
    const p = {};
    const has = (k) => keys.includes(k);
    if (has('l1') || has('l2')) p.categoryId = rec.l1 || rec.l2 ? resolveCategory(rec.l1, rec.l2) : null;
    if (has('l3')) p.l3 = rec.l3;
    if (has('title')) p.title = rec.title;
    if (has('owner')) p.owner = rec.owner;
    if (has('priority')) p.priority = Number(rec.priority) || 2;
    if (has('difficulty')) p.difficulty = Number(rec.difficulty) || 2;
    if (has('interrupt')) p.interrupt = rec.interrupt === '1';
    if (has('start')) p.start = rec.start || null;
    if (has('due')) p.due = rec.due || null;
    if (has('estimateH')) p.estimate = rec.estimateH ? Math.round(Number(rec.estimateH) * 60) : null;
    if (has('progress')) p.progress = Number(rec.progress) || 0;
    if (has('status')) p.status = rec.status || 'todo';
    if (has('deps')) p.deps = rec.deps ? rec.deps.split(',') : [];
    if (has('completedOn')) p.completedAt = rec.completedOn ? `${rec.completedOn}T09:00:00.000Z` : null;
    if (has('notes')) p.notes = rec.notes;
    // 進捗100% は完了、完了は進捗100%
    const status = p.status ?? (current && current.status);
    if (p.progress === 100 && status !== 'done') p.status = 'done';
    if (p.status === 'done' && !p.completedAt && !(current && current.completedAt)) p.completedAt = new Date().toISOString();
    if (p.status && p.status !== 'done' && has('status')) p.completedAt = null;
    return p;
  };

  /**
   * 項目ごとの3方向マージ。
   *   ex: Excel のレコード / da: ダッシュボードのレコード / base: 前回同期時のレコード（初回は null）
   *   keys: Excel に列がある項目
   * 戻り値: { merged, toTask: [key], toExcel: [key], conflicts: [{ key, excel, dash, winner }] }
   */
  Core.mergeRecord = (ex, da, base, keys) => {
    const merged = {};
    const toTask = [];
    const toExcel = [];
    const conflicts = [];
    for (const k of keys) {
      const e = ex[k] ?? '';
      const d = da[k] ?? '';
      const b = base ? (base[k] ?? '') : undefined;
      if (e === d) { merged[k] = e; continue; }
      if (b !== undefined && d === b) { merged[k] = e; toTask.push(k); continue; }
      if (b !== undefined && e === b) { merged[k] = d; toExcel.push(k); continue; }
      const dashWins = Core.WBS_EXEC_KEYS.includes(k);
      merged[k] = dashWins ? d : e;
      (dashWins ? toExcel : toTask).push(k);
      if (b !== undefined) conflicts.push({ key: k, excel: e, dash: d, winner: dashWins ? 'dashboard' : 'excel' });
    }
    return { merged, toTask, toExcel, conflicts };
  };

  /** 既存の ID から次の W-### を採番する */
  Core.nextWbsId = (existing) => {
    let max = 0;
    for (const id of existing) {
      const m = String(id).match(/^W-(\d+)$/i);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `W-${String(max + 1).padStart(3, '0')}`;
  };

  /** Excel に書くときの表示値 */
  Core.wbsDisplayValue = (key, v) => {
    if (v === '' || v === null || v === undefined) return null;
    if (DATE_KEYS.includes(key)) {
      const [y, m, d] = v.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d));
    }
    if (key === 'priority') return Core.PRIORITY[v] || null;
    if (key === 'difficulty') return Core.DIFFICULTY[v] || null;
    if (key === 'interrupt') return v === '1' ? '○' : null;
    if (key === 'progress' || key === 'estimateH') return Number(v);
    if (key === 'status') return Core.STATUS[v] || null;
    if (key === 'deps') return v.split(',').join(', ');
    return v;
  };
  Core.WBS_FIELD_LABEL = Object.fromEntries(Core.WBS_FIELDS.map((f) => [f.key, f.label]));

  /**
   * WBS テンプレート（ExcelJS のブック）を作る。records を渡すとその行を入れる。
   * ブラウザでも Node（scripts/build-template.js）でも同じものを作れるよう ExcelJS を引数で受け取る。
   */
  Core.buildWbsWorkbook = (ExcelJS, records) => {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Job Dashboard';
    const ws = wb.addWorksheet('WBS', { views: [{ state: 'frozen', ySplit: 1, xSplit: 0 }] });
    ws.columns = Core.WBS_FIELDS.map((f) => ({ header: f.label, key: f.key, width: f.width }));
    const head = ws.getRow(1);
    head.height = 22;
    head.eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D6A66' } };
      c.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    (records || []).forEach((rec) => {
      const row = {};
      Core.WBS_FIELDS.forEach((f) => { row[f.key] = f.key === 'updated' ? rec.updated || null : Core.wbsDisplayValue(f.key, rec[f.key] ?? ''); });
      ws.addRow(row);
    });
    const last = Math.max(200, (records || []).length + 100);
    const col = (k) => ws.getColumn(k).letter;
    ['start', 'due', 'completedOn'].forEach((k) => { ws.getColumn(k).numFmt = 'yyyy/mm/dd'; });
    const list = (k, values) => {
      for (let r = 2; r <= last; r++) {
        ws.getCell(`${col(k)}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${values}"`] };
      }
    };
    list('priority', '高,中,低');
    list('difficulty', '高,中,低');
    list('interrupt', '○');
    list('status', '未着手,進行中,待ち,完了');
    for (let r = 2; r <= last; r++) {
      ws.getCell(`${col('progress')}${r}`).dataValidation = { type: 'whole', operator: 'between', allowBlank: true, formulae: [0, 100], showErrorMessage: true, error: '0〜100 の整数で入力してください' };
    }
    ws.autoFilter = { from: 'A1', to: `${ws.getColumn(Core.WBS_FIELDS.length).letter}1` };
    // 期限超過は赤、完了は灰色
    const range = `A2:${ws.getColumn(Core.WBS_FIELDS.length).letter}${last}`;
    ws.addConditionalFormatting({
      ref: range,
      rules: [
        { type: 'expression', priority: 1, formulae: [`$${col('status')}2="完了"`], style: { font: { color: { argb: 'FF8A949E' } } } },
        { type: 'expression', priority: 2, formulae: [`AND($${col('due')}2<>"",$${col('due')}2<TODAY(),$${col('status')}2<>"完了")`], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFF8E3E1' } } } },
      ],
    });

    const help = wb.addWorksheet('使い方');
    help.getColumn(1).width = 110;
    [
      'Job Dashboard と同期する WBS です。',
      '',
      '・1行 = 1タスク。「ID」はダッシュボードが空欄に W-001 形式で採番します。IDは変更しないでください。',
      '・大分類 = 業務 / 自社作業 など、中分類 = 生成AI導入 / 標準化 など、小分類 = 作業のまとまり。空欄は上の行を引き継ぎます。',
      '・重要度・難易度は 高 / 中 / 低。突発作業は「突発」に ○。',
      '・先行タスクには、先に終わっている必要があるタスクの ID をカンマ区切りで書きます（例: W-001, W-002）。ボトルネックの判定に使います。',
      '・見積(h) は残りではなく全体の工数。進捗(%) と合わせて残り日数を計算します。',
      '・状態・進捗・完了日はダッシュボードで更新したものが優先されます。それ以外はこのファイルの編集が優先されます。',
      '・列の順番は入れ替えても、列を増やしても構いません（見出し名で判断します）。',
      '・ダッシュボードは Excel で保存した内容を数秒で読み込みます。Excel で開いている間はダッシュボードから書き込めないため、閉じたときにまとめて書き込みます。',
      '・グラフ・ピボット・画像は書き込み時に失われることがあるため、このブックには置かないでください。',
    ].forEach((t, i) => { help.getCell(`A${i + 1}`).value = t; });
    help.getCell('A1').font = { bold: true, size: 13 };
    return wb;
  };
})(typeof window !== 'undefined' ? window : globalThis);
