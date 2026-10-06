/*
 * core.js — 画面に依存しない純粋ロジック
 *   日付ユーティリティ / クイック入力の解析 / 優先度スコア / 今日の計画 /
 *   フォロー判定 / 定例タスク生成 / AIプロンプト生成と回答の解析 / 日報生成
 * ブラウザでは window.Core、Node では globalThis.Core として使える（tests/ 参照）。
 */
(function (root) {
  'use strict';

  const Core = {};
  const DAY_MS = 86400000;

  /* ---------- 日付 ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  Core.WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  Core.toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  Core.parseISO = (s) => {
    const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  Core.todayISO = () => Core.toISO(new Date());
  Core.addDays = (iso, n) => {
    const d = Core.parseISO(iso);
    d.setDate(d.getDate() + n);
    return Core.toISO(d);
  };
  /** a - b を日数で返す */
  Core.diffDays = (a, b) => Math.round((Core.parseISO(a) - Core.parseISO(b)) / DAY_MS);
  Core.weekday = (iso) => Core.parseISO(iso).getDay();
  Core.formatDate = (iso) => {
    const d = Core.parseISO(iso);
    return `${d.getMonth() + 1}/${d.getDate()}(${Core.WEEK[d.getDay()]})`;
  };
  Core.formatLongDate = (iso) => {
    const d = Core.parseISO(iso);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${Core.WEEK[d.getDay()]})`;
  };
  /** 期限の相対表示と状態（overdue / today / soon / later） */
  Core.dueInfo = (due, today) => {
    if (!due) return { label: '期限なし', state: 'none', days: null };
    const d = Core.diffDays(due, today);
    if (d < 0) return { label: `${-d}日超過`, state: 'overdue', days: d };
    if (d === 0) return { label: '今日', state: 'today', days: d };
    if (d === 1) return { label: '明日', state: 'soon', days: d };
    if (d <= 3) return { label: `${d}日後 ${Core.formatDate(due)}`, state: 'soon', days: d };
    return { label: Core.formatDate(due), state: 'later', days: d };
  };
  Core.lastDayOfMonth = (iso) => {
    const d = Core.parseISO(iso);
    return Core.toISO(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  };

  /* ---------- 区分・カテゴリ ---------- */
  Core.AREAS = { work: '業務', own: '自社作業' };
  Core.STATUS = { todo: '未着手', doing: '進行中', waiting: '待ち', done: '完了' };
  Core.PRIORITY = { 1: '高', 2: '中', 3: '低' };
  Core.DEFAULT_CATEGORIES = [
    { id: 'ai', area: 'work', name: '生成AI導入', keywords: ['生成AI', 'Copilot', 'ChatGPT', 'プロンプト', 'LLM', 'AI'] },
    { id: 'std', area: 'work', name: '標準化', keywords: ['標準化', '規約', 'テンプレ', '手順書', 'ガイドライン', 'ルール'] },
    { id: 'dev', area: 'work', name: '開発推進', keywords: ['開発', '実装', 'リリース', 'レビュー', '設計', 'テスト', 'CI'] },
    { id: 'work-routine', area: 'work', name: '定例作業', keywords: ['定例', '週次', '月次', '進捗報告'] },
    { id: 'own-routine', area: 'own', name: '定例作業', keywords: ['社内定例', '部会', '朝会'] },
    { id: 'perf', area: 'own', name: '業績管理', keywords: ['業績', '売上', '予算', '稼働', '見込', '実績'] },
    { id: 'edu', area: 'own', name: '育成関連', keywords: ['育成', '1on1', 'OJT', 'メンター', '新人', '面談'] },
    { id: 'train', area: 'own', name: '研修受講等', keywords: ['研修', '受講', 'eラーニング', '資格', 'セミナー'] },
    { id: 'admin', area: 'own', name: '事務作業', keywords: ['経費', '勤怠', '申請', '精算', '稟議', '交通費'] },
  ];
  Core.categoryLabel = (cat) => (cat ? `${Core.AREAS[cat.area]}/${cat.name}` : '未分類');

  /**
   * キーワードからカテゴリを推定する（なければ null）。
   * 文中で先に出てくるキーワードを優先し（「規約のレビュー」→ 標準化）、同じ位置なら長い方を採る。
   */
  Core.guessCategory = (text, categories) => {
    const lower = String(text).toLowerCase();
    let best = null;
    let bestPos = Infinity;
    let bestLen = 0;
    for (const c of categories) {
      for (const k of c.keywords || []) {
        const kw = String(k).trim().toLowerCase();
        const pos = kw ? lower.indexOf(kw) : -1;
        if (pos === -1) continue;
        if (pos < bestPos || (pos === bestPos && kw.length > bestLen)) {
          best = c; bestPos = pos; bestLen = kw.length;
        }
      }
    }
    return best;
  };

  /** 「業務/標準化」「標準化」「std」いずれの表記でもカテゴリを探す */
  Core.findCategory = (label, categories) => {
    if (!label) return null;
    const s = String(label).trim();
    const byId = categories.find((c) => c.id === s);
    if (byId) return byId;
    const full = categories.find((c) => Core.categoryLabel(c) === s.replace(/[：:・]/g, '/'));
    if (full) return full;
    return categories.find((c) => c.name === s) || categories.find((c) => c.name.includes(s) || s.includes(c.name)) || null;
  };

  /* ---------- クイック入力の解析 ----------
   * 例: 「明日 規約レビュー !高 30分 @佐藤」
   *   日付: 今日/明日/明後日/N日後/今週/来週/月末/金曜/来週火曜/10/15/10月15日
   *   優先: !高 !中 !低（「至急」「急ぎ」も高）
   *   区分: #標準化  ／ 見積: 30分 1h 2時間 ／ 関係者: @名前
   */
  Core.parseQuickAdd = (text, today, categories) => {
    let t = ` ${String(text).replace(/　/g, ' ')} `;
    const out = { title: '', due: null, priority: 2, categoryId: null, estimate: null, people: [], hints: [] };
    const take = (m) => { t = t.replace(m[0], ' '); };

    const pr = t.match(/[!！](高|中|低|1|2|3)/);
    if (pr) { out.priority = { 高: 1, 1: 1, 中: 2, 2: 2, 低: 3, 3: 3 }[pr[1]]; take(pr); }
    else if (/至急|急ぎ|緊急/.test(t)) out.priority = 1;

    const hc = t.match(/[#＃](\S+)/);
    if (hc) {
      const c = Core.findCategory(hc[1], categories);
      if (c) { out.categoryId = c.id; take(hc); }
    }

    const est = t.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*(分|min|h|時間)(?=\s|$)/i);
    if (est) {
      const n = parseFloat(est[1]);
      out.estimate = /分|min/i.test(est[2]) ? Math.round(n) : Math.round(n * 60);
      take(est);
    }

    let m;
    const setDue = (iso, match) => { if (!out.due) out.due = iso; take(match); };
    if ((m = t.match(/明後日|あさって/))) setDue(Core.addDays(today, 2), m);
    if ((m = t.match(/明日|あした/))) setDue(Core.addDays(today, 1), m);
    if ((m = t.match(/今日中?|本日中?/))) setDue(today, m);
    if ((m = t.match(/(\d+)日後/))) setDue(Core.addDays(today, Number(m[1])), m);
    if ((m = t.match(/月末/))) setDue(Core.lastDayOfMonth(today), m);
    if ((m = t.match(/(来週)?([月火水木金土日])曜日?/))) {
      const target = Core.WEEK.indexOf(m[2]);
      const cur = Core.weekday(today);
      let add = (target - cur + 7) % 7;
      if (m[1]) {
        // 来週X曜 = 次の月曜から始まる週のX曜
        const toNextMon = ((1 - cur + 7) % 7) || 7;
        add = toNextMon + ((target + 6) % 7);
      }
      setDue(Core.addDays(today, add), m);
    }
    if ((m = t.match(/今週中?/))) {
      const cur = Core.weekday(today);
      setDue(cur >= 5 || cur === 0 ? today : Core.addDays(today, 5 - cur), m);
    }
    if ((m = t.match(/来週中?/))) {
      const cur = Core.weekday(today);
      setDue(Core.addDays(today, (((1 - cur + 7) % 7) || 7) + 4), m);
    }
    if ((m = t.match(/(?:^|\s)(\d{1,2})[/月](\d{1,2})日?(?=\s|$|まで)/))) {
      const y = Core.parseISO(today).getFullYear();
      let iso = Core.toISO(new Date(y, Number(m[1]) - 1, Number(m[2])));
      if (Core.diffDays(iso, today) < -60) iso = Core.toISO(new Date(y + 1, Number(m[1]) - 1, Number(m[2])));
      setDue(iso, m);
    }
    t = t.replace(/まで(に)?/g, ' ');

    const people = t.match(/[@＠]\S+/g);
    if (people) {
      out.people = people.map((p) => p.slice(1));
      people.forEach((p) => { t = t.replace(p, ' '); });
    }

    out.title = t.replace(/\s+/g, ' ').trim() || String(text).trim();
    if (!out.categoryId) {
      const g = Core.guessCategory(out.title, categories);
      if (g) { out.categoryId = g.id; out.hints.push('キーワードから区分を推定'); }
    }
    return out;
  };

  /* ---------- 優先度スコア ----------
   * 高いほど今日やるべき。reasons は画面に「なぜ上位か」として表示する。
   */
  Core.scoreTask = (task, today, settings) => {
    if (task.status === 'done') return { score: -1, reasons: [] };
    const s = settings || {};
    let score = 0;
    const reasons = [];
    if (task.todayPin === today) { score += 100; reasons.push('今日やると決めた'); }
    if (task.due) {
      const d = Core.diffDays(task.due, today);
      if (d < 0) { score += 60 + Math.min(-d, 10) * 3; reasons.push(`${-d}日超過`); }
      else if (d === 0) { score += 45; reasons.push('今日締切'); }
      else if (d === 1) { score += 28; reasons.push('明日締切'); }
      else if (d <= 3) { score += 16; reasons.push(`${d}日後締切`); }
      else if (d <= 7) { score += 8; reasons.push('1週間以内'); }
    }
    score += { 1: 30, 2: 12, 3: 0 }[task.priority] || 0;
    if (task.priority === 1) reasons.push('重要度 高');
    if (task.status === 'doing') { score += 10; reasons.push('進行中'); }
    if (task.status === 'waiting') score -= 40;
    if (task.recurringId && task.due === today) { score += 10; reasons.push('定例'); }
    const last = (task.updatedAt || task.createdAt || today).slice(0, 10);
    const idle = Core.diffDays(today, last);
    if (idle >= (s.staleDays || 5) && task.status !== 'waiting') { score += 6; reasons.push(`${idle}日動きなし`); }
    return { score, reasons };
  };

  /**
   * 今日の計画: 容量（分）に収まる範囲で上位から「今日やる」に積む。
   * ピン留め・期限超過・今日締切は容量を超えても必ず入れる。
   */
  Core.planToday = (tasks, today, settings) => {
    const capacity = (settings && settings.capacityMin) || 360;
    const open = tasks.filter((t) => t.status !== 'done');
    const scored = open
      .filter((t) => t.status !== 'waiting')
      .map((t) => ({ task: t, ...Core.scoreTask(t, today, settings) }))
      .sort((a, b) => {
        const pa = a.task.todayPin === today ? (a.task.todayOrder ?? 99) : 999;
        const pb = b.task.todayPin === today ? (b.task.todayOrder ?? 99) : 999;
        return pa - pb || b.score - a.score;
      });
    const focus = [];
    const more = [];
    let minutes = 0;
    for (const item of scored) {
      const est = item.task.estimate || 30;
      const must = item.task.todayPin === today || (item.task.due && Core.diffDays(item.task.due, today) <= 0);
      if (must || (minutes + est <= capacity && item.score >= 20)) {
        focus.push(item);
        minutes += est;
      } else if (item.score >= 8) {
        more.push(item);
      }
    }
    const waiting = open.filter((t) => t.status === 'waiting');
    return { focus, more: more.slice(0, 8), waiting, minutes, capacity };
  };

  /* ---------- 定例タスク ---------- */
  /** freq: weekday(平日毎日) / weekly(day=0-6) / monthly(day=1-31, 31は月末扱い) */
  Core.routineDueOn = (routine, iso) => {
    const wd = Core.weekday(iso);
    if (routine.freq === 'weekday') return wd >= 1 && wd <= 5;
    if (routine.freq === 'weekly') return wd === Number(routine.day);
    if (routine.freq === 'monthly') {
      const last = Core.parseISO(Core.lastDayOfMonth(iso)).getDate();
      const target = Math.min(Number(routine.day), last);
      return Core.parseISO(iso).getDate() === target;
    }
    return false;
  };
  Core.routineLabel = (r) => {
    if (r.freq === 'weekday') return '平日毎日';
    if (r.freq === 'weekly') return `毎週${Core.WEEK[Number(r.day)]}曜`;
    if (r.freq === 'monthly') return Number(r.day) >= 31 ? '毎月末' : `毎月${r.day}日`;
    return '';
  };

  /* ---------- フォロー（声かけ）判定 ---------- */
  Core.followUps = (tasks, today, settings, categories) => {
    const s = settings || {};
    const snoozed = s.snoozed || {};
    const items = [];
    const push = (it) => {
      if (snoozed[it.id] && Core.diffDays(snoozed[it.id], today) > 0) return;
      items.push(it);
    };
    const open = tasks.filter((t) => t.status !== 'done');

    for (const t of open) {
      const last = (t.updatedAt || t.createdAt || today).slice(0, 10);
      const idle = Core.diffDays(today, last);
      if (t.due && Core.diffDays(t.due, today) < 0) {
        push({
          id: `overdue:${t.id}`, level: 'critical', taskId: t.id,
          title: `「${t.title}」が期限を${Core.diffDays(today, t.due)}日過ぎています`,
          detail: '今日片付けるか、現実的な期限に引き直しましょう。期限を動かすなら関係者への一報も忘れずに。',
          actions: ['pin', 'due+1', 'due+friday', 'done'],
        });
      }
      if (t.status === 'waiting' && idle >= (s.waitingDays || 3)) {
        const who = t.waitingFor ? `${t.waitingFor}さん` : '相手';
        push({
          id: `waiting:${t.id}:${last}`, level: 'warn', taskId: t.id,
          title: `「${t.title}」の${who}待ちが${idle}日続いています`,
          detail: 'リマインドを送るか、待たずに進められる部分を切り出しましょう。',
          actions: ['remind', 'touch', 'resume'],
        });
      }
      if (t.status === 'doing' && idle >= (s.staleDays || 5)) {
        push({
          id: `stale:${t.id}:${last}`, level: 'warn', taskId: t.id,
          title: `「${t.title}」が進行中のまま${idle}日動いていません`,
          detail: '止まっている理由は何でしょう。次の一手が曖昧なら、AIと分解すると動き出しやすくなります。',
          actions: ['breakdown', 'pin', 'touch'],
        });
      }
      if (t.priority === 1 && !t.due) {
        push({
          id: `nodue:${t.id}`, level: 'info', taskId: t.id,
          title: `重要度高の「${t.title}」に期限がありません`,
          detail: '期限がないと毎日後回しになりがちです。仮でも置いておきましょう。',
          actions: ['due+friday', 'open'],
        });
      }
      if ((t.estimate || 0) >= 180 && !(t.subtasks || []).length) {
        push({
          id: `big:${t.id}`, level: 'info', taskId: t.id,
          title: `「${t.title}」は見積${Math.round(t.estimate / 60)}時間。分解しませんか`,
          detail: '1つ30〜90分の単位に分けると、今日の計画に入れやすくなります。',
          actions: ['breakdown'],
        });
      }
      if (!t.categoryId) {
        push({
          id: `nocat:${t.id}`, level: 'info', taskId: t.id,
          title: `「${t.title}」の区分が未設定です`,
          detail: '区分を付けると、振り返りで時間の使い方が見えるようになります。',
          actions: ['open'],
        });
      }
    }

    const plan = Core.planToday(tasks, today, s);
    if (plan.minutes > plan.capacity) {
      push({
        id: `overload:${today}`, level: 'warn',
        title: `今日の予定が容量を${plan.minutes - plan.capacity}分超えています`,
        detail: `予定 ${plan.minutes}分 / 容量 ${plan.capacity}分。何を明日以降に回すか、AIと相談しましょう。`,
        actions: ['ai-plan'],
      });
    }

    // 2週間、何も動いていない区分（定例作業は除く）
    const since = Core.addDays(today, -14);
    for (const c of categories || []) {
      if (/定例/.test(c.name)) continue;
      const related = tasks.filter((t) => t.categoryId === c.id);
      const hasOpen = related.some((t) => t.status !== 'done');
      const recentDone = related.some((t) => t.completedAt && Core.diffDays(t.completedAt.slice(0, 10), since) >= 0);
      if (!hasOpen && !recentDone) {
        push({
          id: `quiet:${c.id}:${today}`, level: 'info', categoryId: c.id,
          title: `「${Core.categoryLabel(c)}」のタスクが2週間ありません`,
          detail: '本当にやることがないか、抜け漏れがないか一度考えてみましょう。',
          actions: ['add-in-category', 'ai-consult'],
        });
      }
    }

    const rank = { critical: 0, warn: 1, info: 2 };
    return items.sort((a, b) => rank[a.level] - rank[b.level]);
  };

  /** 待ちタスク向けのリマインド文 */
  Core.reminderText = (task) => {
    const who = task.waitingFor ? `${task.waitingFor}さん` : '〇〇さん';
    const due = task.due ? `${Core.formatDate(task.due)}までに進めたいため、` : '';
    return `${who}\nお疲れさまです。先日ご相談した「${task.title}」の件、その後いかがでしょうか。\n${due}お手すきの際にご確認いただけますと幸いです。よろしくお願いいたします。`;
  };

  /* ---------- AI: プロンプト生成 ---------- */
  const catLabelOf = (task, categories) => Core.categoryLabel(categories.find((c) => c.id === task.categoryId));
  Core.taskForPrompt = (t, categories) => {
    const o = {
      id: t.id, title: t.title, 区分: catLabelOf(t, categories), 状態: Core.STATUS[t.status],
      重要度: Core.PRIORITY[t.priority], 期限: t.due || null, 見積分: t.estimate || null,
    };
    if (t.waitingFor) o.待ち相手 = t.waitingFor;
    if ((t.subtasks || []).length) o.サブタスク = t.subtasks.map((s) => (s.done ? '✓' : '・') + s.title);
    if (t.notes) o.メモ = t.notes.slice(0, 200);
    return o;
  };

  Core.AI_MODES = {
    plan: { label: '今日の優先順位', desc: '今日の候補と容量を渡して、やる順番と後ろ倒しを提案してもらう' },
    breakdown: { label: 'タスク分解', desc: '大きい・止まっているタスクを30〜90分単位の手順に分ける' },
    extract: { label: 'メモからタスク化', desc: '議事録・チャット・メモを貼り付けてタスクを抜き出す' },
    consult: { label: '壁打ち', desc: '進め方や判断に迷っていることを一緒に考える' },
    review: { label: '週次振り返り', desc: '今週の実績から、良かった点・課題・来週の重点を整理する' },
  };

  const SYSTEM = 'あなたは社内業務に精通した、率直で実務的なタスク管理のパートナーです。日本語で簡潔に答えてください。';
  const JSON_RULE = '回答の最後に、次の形式のJSONを ```json と ``` で囲んで必ず1つだけ出力してください。日付は YYYY-MM-DD、区分は一覧の表記をそのまま使ってください。';

  /**
   * ctx: { today, tasks, categories, settings, task?, text?, journal? }
   * 戻り値: { system, user } — 手動モードでは連結してコピーする
   */
  Core.buildPrompt = (mode, ctx) => {
    const { today, tasks, categories, settings } = ctx;
    const catList = categories.map(Core.categoryLabel).join(' / ');
    const open = tasks.filter((t) => t.status !== 'done');
    const head = `今日は ${Core.formatLongDate(today)} です。\n区分一覧: ${catList}\n`;
    let user = '';
    if (mode === 'plan') {
      const plan = Core.planToday(tasks, today, settings);
      const cand = [...plan.focus, ...plan.more].map((i) => ({ ...Core.taskForPrompt(i.task, categories), スコア: i.score }));
      user = `${head}今日使える作業時間は約${plan.capacity}分です（会議等を除く）。\n`
        + `${ctx.text ? `補足: ${ctx.text}\n` : ''}`
        + `以下は今日の候補タスクです。期限・重要度・依存関係を踏まえ、今日やる順番を決めてください。容量に収まらないものは後ろ倒し先の日付を提案してください。\n`
        + `\n候補:\n${JSON.stringify(cand, null, 1)}\n`
        + `\n待ち状態のタスク:\n${JSON.stringify(plan.waiting.map((t) => Core.taskForPrompt(t, categories)), null, 1)}\n\n`
        + `${JSON_RULE}\n{"order":[{"id":"タスクID","reason":"理由"}],"defer":[{"id":"タスクID","newDue":"YYYY-MM-DD","reason":"理由"}],"advice":"今日の進め方のひとこと"}`;
    } else if (mode === 'breakdown') {
      const t = ctx.task;
      user = `${head}次のタスクを、30〜90分で終わる具体的な作業手順に分解してください。最初の一手はすぐ着手できる粒度にしてください。\n`
        + `${ctx.text ? `補足: ${ctx.text}\n` : ''}`
        + `\nタスク:\n${JSON.stringify(t ? Core.taskForPrompt(t, categories) : {}, null, 1)}\n\n`
        + `${JSON_RULE}\n{"subtasks":["手順1","手順2"],"estimate":合計見積分(数値),"nextAction":"最初にやること","risks":["詰まりそうな点"]}`;
    } else if (mode === 'extract') {
      user = `${head}以下のメモから、私（読み手）がやるべきタスクを抜き出してください。他人の作業は含めず、曖昧なものは確認タスクにしてください。\n`
        + `\nメモ:\n"""\n${ctx.text || ''}\n"""\n\n`
        + `${JSON_RULE}\n{"tasks":[{"title":"動詞で終わるタスク名","category":"区分","priority":1,"due":"YYYY-MM-DD または null","estimate":30,"note":"補足"}]}\n※priority は 1=高 2=中 3=低`;
    } else if (mode === 'consult') {
      user = `${head}相談したいことがあります。一緒に考えてください。結論、理由、次の一手の順で答え、必要なら私への質問も返してください。\n`
        + `\n相談内容:\n${ctx.text || ''}\n`
        + `${ctx.task ? `\n関連タスク:\n${JSON.stringify(Core.taskForPrompt(ctx.task, categories), null, 1)}\n` : ''}`
        + `\n参考: 現在の未完了タスク（${open.length}件）\n${JSON.stringify(open.slice(0, 30).map((t) => ({ title: t.title, 区分: catLabelOf(t, categories), 期限: t.due })), null, 0)}\n\n`
        + `新しくやるべきことが出てきた場合のみ、${JSON_RULE}\n{"tasks":[{"title":"","category":"区分","priority":2,"due":null,"estimate":30,"note":""}]}`;
    } else if (mode === 'review') {
      const from = Core.addDays(today, -6);
      const done = tasks.filter((t) => t.completedAt && Core.diffDays(t.completedAt.slice(0, 10), from) >= 0);
      const overdue = open.filter((t) => t.due && Core.diffDays(t.due, today) < 0);
      const notes = Object.entries(ctx.journal || {})
        .filter(([d]) => Core.diffDays(d, from) >= 0)
        .map(([d, j]) => `${d}: ${j.reflection || ''}`).filter((l) => l.length > 12).join('\n');
      user = `${head}今週（${Core.formatDate(from)}〜${Core.formatDate(today)}）の振り返りを手伝ってください。区分ごとの時間の偏り、停滞しているもの、来週の重点を指摘してください。\n`
        + `\n完了（${done.length}件）:\n${JSON.stringify(done.map((t) => ({ title: t.title, 区分: catLabelOf(t, categories) })), null, 0)}\n`
        + `\n期限超過（${overdue.length}件）:\n${JSON.stringify(overdue.map((t) => Core.taskForPrompt(t, categories)), null, 0)}\n`
        + `\n未完了（${open.length}件）:\n${JSON.stringify(open.slice(0, 40).map((t) => ({ id: t.id, title: t.title, 区分: catLabelOf(t, categories), 状態: Core.STATUS[t.status], 期限: t.due })), null, 0)}\n`
        + `${notes ? `\n日々のメモ:\n${notes}\n` : ''}\n`
        + `${JSON_RULE}\n{"summary":"今週のまとめ","good":["良かった点"],"issues":["課題"],"nextWeek":[{"title":"来週やること","category":"区分","priority":1,"due":"YYYY-MM-DD"}]}`;
    }
    return { system: SYSTEM, user };
  };
  Core.promptAsText = (p) => `${p.system}\n\n${p.user}`;

  /* ---------- AI: 回答の解析 ---------- */
  /** 回答から最後の JSON ブロックを取り出す。本文（JSON 以外）も返す */
  Core.extractJSON = (text) => {
    const src = String(text || '');
    // 候補: 後ろのコードブロックから順に、最後に最初の { 〜最後の } を試す
    const candidates = [...src.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
      .map((b) => ({ whole: b[0], body: b[1] })).reverse();
    const first = src.indexOf('{');
    const last = src.lastIndexOf('}');
    if (first !== -1 && last > first) {
      const body = src.slice(first, last + 1);
      candidates.push({ whole: body, body });
    }
    for (const c of candidates) {
      try {
        return { data: JSON.parse(c.body.trim()), prose: src.replace(c.whole, '').trim() };
      } catch (e) { /* 次の候補へ */ }
    }
    return { data: null, prose: src.trim() };
  };

  /**
   * 解析済み JSON を「変更案」の配列に変換する。画面ではチェックボックスで選んで反映する。
   * change: { kind, label, taskId?, payload }
   */
  Core.proposalsFrom = (mode, data, ctx) => {
    if (!data || typeof data !== 'object') return [];
    const { tasks, categories, today } = ctx;
    const byId = (id) => tasks.find((t) => t.id === id);
    const out = [];
    const newTask = (x) => {
      const cat = Core.findCategory(x.category, categories) || Core.guessCategory(x.title || '', categories);
      const due = /^\d{4}-\d{2}-\d{2}$/.test(String(x.due || '')) ? x.due : null;
      return {
        kind: 'add',
        label: `追加: ${x.title}（${Core.categoryLabel(cat)}${due ? ` / ${Core.formatDate(due)}` : ''}）`,
        payload: {
          title: String(x.title || '').trim(), categoryId: cat ? cat.id : null,
          priority: [1, 2, 3].includes(Number(x.priority)) ? Number(x.priority) : 2,
          due, estimate: Number(x.estimate) || null, notes: x.note || '',
        },
      };
    };
    if (mode === 'plan') {
      (data.order || []).forEach((o, i) => {
        const t = byId(o.id);
        if (t) out.push({ kind: 'pin', taskId: t.id, label: `${i + 1}. 今日やる: ${t.title}`, note: o.reason, payload: { order: i } });
      });
      (data.defer || []).forEach((o) => {
        const t = byId(o.id);
        if (t && /^\d{4}-\d{2}-\d{2}$/.test(o.newDue || '')) {
          out.push({ kind: 'due', taskId: t.id, label: `期限変更: ${t.title} → ${Core.formatDate(o.newDue)}`, note: o.reason, payload: { due: o.newDue } });
        }
      });
    } else if (mode === 'breakdown') {
      const t = ctx.task && byId(ctx.task.id);
      if (t) {
        (data.subtasks || []).forEach((s) => out.push({ kind: 'subtask', taskId: t.id, label: `手順: ${s}`, payload: { title: String(s) } }));
        if (Number(data.estimate)) out.push({ kind: 'estimate', taskId: t.id, label: `見積を${data.estimate}分に更新`, payload: { estimate: Number(data.estimate) } });
        if (data.nextAction) out.push({ kind: 'log', taskId: t.id, label: `記録: 次の一手「${data.nextAction}」`, payload: { text: `次の一手: ${data.nextAction}` } });
      }
    } else if (mode === 'extract' || mode === 'consult') {
      (data.tasks || []).filter((x) => x && x.title).forEach((x) => out.push(newTask(x)));
    } else if (mode === 'review') {
      if (data.summary) {
        const text = [data.summary, ...(data.good || []).map((g) => `◯ ${g}`), ...(data.issues || []).map((g) => `△ ${g}`)].join('\n');
        out.push({ kind: 'journal', label: '振り返りを今日のメモに保存', payload: { date: today, text } });
      }
      (data.nextWeek || []).filter((x) => x && x.title).forEach((x) => out.push(newTask(x)));
    }
    return out;
  };

  /* ---------- 日報・集計 ---------- */
  Core.dailyReport = (tasks, today, categories, journal, settings) => {
    const cat = (t) => (categories.find((c) => c.id === t.categoryId) || { name: '未分類' }).name;
    const done = tasks.filter((t) => t.completedAt && t.completedAt.slice(0, 10) === today);
    const doing = tasks.filter((t) => t.status === 'doing');
    const waiting = tasks.filter((t) => t.status === 'waiting');
    const tomorrow = Core.addDays(today, 1);
    const next = Core.planToday(tasks.filter((t) => t.status !== 'done'), tomorrow, settings).focus.slice(0, 5).map((i) => i.task);
    const lines = [`【日報】${Core.formatLongDate(today)}`, '', '■ 本日の実績'];
    lines.push(...(done.length ? done.map((t) => `・[${cat(t)}] ${t.title}`) : ['・（完了なし）']));
    if (doing.length) lines.push('', '■ 進行中', ...doing.map((t) => `・[${cat(t)}] ${t.title}${t.subtasks && t.subtasks.length ? `（${t.subtasks.filter((s) => s.done).length}/${t.subtasks.length}）` : ''}`));
    if (waiting.length) lines.push('', '■ 回答待ち', ...waiting.map((t) => `・${t.title}${t.waitingFor ? `（${t.waitingFor}さん）` : ''}`));
    lines.push('', '■ 明日の予定', ...(next.length ? next.map((t) => `・[${cat(t)}] ${t.title}`) : ['・（未定）']));
    const j = (journal || {})[today];
    if (j && j.reflection) lines.push('', '■ 所感', j.reflection);
    return lines.join('\n');
  };

  /** 直近 n 日の区分別完了数と日別完了数 */
  Core.completionStats = (tasks, today, categories, days) => {
    const n = days || 7;
    const from = Core.addDays(today, -(n - 1));
    const done = tasks.filter((t) => t.completedAt && Core.diffDays(t.completedAt.slice(0, 10), from) >= 0 && Core.diffDays(today, t.completedAt.slice(0, 10)) >= 0);
    const byCategory = categories.map((c) => ({ category: c, count: done.filter((t) => t.categoryId === c.id).length }));
    const uncategorized = done.filter((t) => !categories.some((c) => c.id === t.categoryId)).length;
    const byDay = [];
    for (let i = 0; i < n; i++) {
      const d = Core.addDays(from, i);
      byDay.push({ date: d, count: done.filter((t) => t.completedAt.slice(0, 10) === d).length });
    }
    return { total: done.length, byCategory, uncategorized, byDay };
  };

  root.Core = Core;
})(typeof window !== 'undefined' ? window : globalThis);
