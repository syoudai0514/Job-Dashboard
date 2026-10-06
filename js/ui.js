/*
 * ui.js — 画面の描画とイベント処理
 * 画面はすべて innerHTML で描き直し、操作は data-action 属性によるイベント委譲で受ける。
 *   ビュー: today(今日) / tasks(タスク) / follow(フォロー) / ai(AIと考える) / review(振り返り) / settings(設定)
 */
(function (root) {
  'use strict';
  const { Core, Store, AI } = root;
  const $ = (sel, el) => (el || document).querySelector(sel);

  const ui = {
    view: 'today',
    today: Core.todayISO(),
    filters: { area: 'all', cat: 'all', status: 'open', q: '' },
    drawerTaskId: null,
    confirmDelete: false,
    textPanel: null, // { title, text } ドロワーに文章を表示するとき
    ai: { mode: 'plan', taskId: '', text: '', prompt: null, response: '', proposals: null, prose: '', selected: {}, busy: false, error: '' },
  };
  try {
    const saved = sessionStorage.getItem('job-dashboard:view');
    if (saved) ui.view = saved;
  } catch (e) { /* 保存できない環境では既定のまま */ }

  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = () => Store.state;
  const cats = () => S().categories;
  const catOf = (t) => Store.category(t.categoryId);

  /* ---------- 共通部品 ---------- */
  function catChip(categoryId) {
    const c = Store.category(categoryId);
    if (!c) return '<span class="chip area-none">未分類</span>';
    return `<span class="chip area-${c.area}" title="${h(Core.AREAS[c.area])}">${h(c.name)}</span>`;
  }
  function dueChip(t) {
    if (!t.due) return '';
    const d = Core.dueInfo(t.due, ui.today);
    return `<span class="chip due-${d.state}">${h(d.label)}</span>`;
  }
  function statusChip(t, clickable) {
    const label = Core.STATUS[t.status];
    if (t.status === 'todo' && !clickable) return '';
    const tag = clickable ? 'button' : 'span';
    const extra = clickable ? ` type="button" data-action="cycle-status" data-id="${t.id}" title="クリックで状態を切り替え"` : '';
    const who = t.status === 'waiting' && t.waitingFor ? `・${h(t.waitingFor)}` : '';
    return `<${tag} class="chip st-${t.status}"${extra}>${h(label)}${who}</${tag}>`;
  }

  function taskRow(t, opts) {
    const o = opts || {};
    const subs = t.subtasks || [];
    const subDone = subs.filter((s) => s.done).length;
    const pinned = t.todayPin === ui.today;
    const cls = ['task', `prio-${t.priority}`, t.status === 'done' ? 'is-done' : ''].join(' ');
    return `<li class="${cls}" data-id="${t.id}">
      <div class="task-lead">
        ${o.rank ? `<span class="rank">${o.rank}</span>` : ''}
        <button class="check" type="button" data-action="${t.status === 'done' ? 'undone' : 'complete'}" data-id="${t.id}" aria-label="${t.status === 'done' ? '未完了に戻す' : '完了にする'}"></button>
      </div>
      <button class="task-body" type="button" data-action="open" data-id="${t.id}">
        <span class="task-title">${h(t.title)}</span>
        <span class="task-meta">
          ${t.priority === 1 ? '<span class="chip prio-1">重要</span>' : ''}
          ${o.hideCat ? '' : catChip(t.categoryId)}
          ${dueChip(t)}
          ${o.statusButton ? '' : statusChip(t, false)}
          ${t.recurringId ? '<span class="chip">定例</span>' : ''}
          ${subs.length ? `<span class="est">${subDone}/${subs.length}</span>` : ''}
          ${t.estimate ? `<span class="est">${t.estimate}分</span>` : ''}
          ${(o.reasons || []).filter((r) => /動きなし/.test(r)).map((r) => `<span class="chip reason">${h(r)}</span>`).join('')}
        </span>
      </button>
      <div class="task-side">
        ${o.statusButton ? statusChip(t, true) : ''}
        ${t.status !== 'done' ? `<button class="pin-btn" type="button" data-action="toggle-pin" data-id="${t.id}" aria-pressed="${pinned}" title="今日やるリストに入れる">今日</button>` : ''}
      </div>
    </li>`;
  }

  function followCard(f, compact) {
    const t = f.taskId ? Store.task(f.taskId) : null;
    const LV = { critical: '要対応', warn: '注意', info: '提案' };
    const ACTION = {
      pin: '今日やる', 'due+1': '期限を明日に', 'due+friday': '期限を金曜に', done: '完了にした',
      remind: 'リマインド文を作る', touch: '確認した（待ち継続）', resume: '進行中に戻す',
      breakdown: 'AIと分解する', open: '詳細を開く', 'ai-plan': 'AIと優先順位を相談',
      'add-in-category': 'タスクを追加', 'ai-consult': 'AIと考える',
    };
    const actions = (compact ? f.actions.slice(0, 2) : f.actions)
      .map((a, i) => `<button class="btn btn-sm ${i === 0 ? 'btn-primary' : ''}" type="button" data-action="follow" data-follow="${h(f.id)}" data-kind="${a}" data-id="${t ? t.id : ''}" data-cat="${h(f.categoryId || '')}">${ACTION[a]}</button>`)
      .join('');
    return `<div class="follow lv-${f.level}${compact ? ' compact' : ''}">
      <div class="follow-title"><span class="lv-label">${LV[f.level]}</span>${h(f.title)}</div>
      <div class="follow-detail">${h(f.detail)}</div>
      <div class="follow-actions">${actions}
        <button class="btn btn-sm btn-ghost" type="button" data-action="snooze" data-follow="${h(f.id)}">明日まで隠す</button>
      </div>
    </div>`;
  }

  /* ---------- ナビ ---------- */
  const VIEWS = [
    ['today', '今日'], ['tasks', 'タスク'], ['follow', 'フォロー'], ['ai', 'AIと考える'], ['review', '振り返り'], ['settings', '設定'],
  ];
  function renderNav(follows) {
    const open = S().tasks.filter((t) => t.status !== 'done').length;
    const urgent = follows.filter((f) => f.level !== 'info').length;
    $('#nav').innerHTML = VIEWS.map(([id, label]) => {
      let badge = '';
      if (id === 'follow' && follows.length) badge = `<span class="badge${urgent ? '' : ' soft'}">${urgent || follows.length}</span>`;
      if (id === 'tasks') badge = `<span class="badge soft">${open}</span>`;
      return `<button class="nav-btn" type="button" data-action="nav" data-view="${id}" ${ui.view === id ? 'aria-current="page"' : ''}><span>${label}</span>${badge}</button>`;
    }).join('');
    $('#nav-foot').textContent = Store.storageOK
      ? 'データはこのブラウザに保存されます。定期的に設定から書き出してください。'
      : 'この環境では保存できません。閉じると内容が消えます。';
    $('#today-label').textContent = Core.formatLongDate(ui.today);
  }

  function renderBanner() {
    const el = $('#banner');
    if (S().sample) {
      el.innerHTML = `<div class="banner"><span>サンプルデータを表示しています。操作を試したら、消去して自分のタスクで始めてください。</span>
        <button class="btn btn-sm" type="button" data-action="clear-sample">サンプルを消去して始める</button></div>`;
    } else if (!Store.storageOK) {
      el.innerHTML = '<div class="banner warn">この環境ではブラウザに保存できません。ページを閉じると内容が消えるため、設定から書き出してください。</div>';
    } else el.innerHTML = '';
  }

  /* ---------- 今日 ---------- */
  function viewToday(follows) {
    const st = S();
    const plan = Core.planToday(st.tasks, ui.today, st.settings);
    const pct = Math.min(100, Math.round((plan.minutes / plan.capacity) * 100));
    const over = plan.minutes > plan.capacity;
    const doneToday = st.tasks.filter((t) => t.completedAt && t.completedAt.slice(0, 10) === ui.today);
    const journal = st.journal[ui.today] || {};
    const hour = new Date().getHours();
    const greet = hour < 11 ? '今日の計画を立てましょう。上から順に片付ければ大丈夫です。' : hour < 17 ? '午後は残りの優先タスクに集中しましょう。' : '今日の振り返りをして、明日の準備をしましょう。';
    return `
      <div class="view-head">
        <div><h1>今日の優先</h1><p>${greet}</p></div>
        <div class="capacity${over ? ' over' : ''}">
          <div class="capacity-text"><span>予定 <b class="num">${plan.minutes}</b>分 / 容量 <span class="num">${plan.capacity}</span>分</span><span>${over ? `<b class="num">${plan.minutes - plan.capacity}</b>分オーバー` : `残り <span class="num">${plan.capacity - plan.minutes}</span>分`}</span></div>
          <div class="capacity-bar"><span style="width:${pct}%"></span></div>
        </div>
      </div>
      <div class="grid-2">
        <div class="stack">
          <section class="panel focus-panel">
            <div class="section-head"><h2>今日やる <span class="num muted">${plan.focus.length}</span></h2>
              <button class="btn btn-sm" type="button" data-action="goto-ai" data-mode="plan">AIに順番を相談</button></div>
            ${plan.focus.length ? `<ol class="tasks">${plan.focus.map((i, n) => taskRow(i.task, { rank: n + 1, reasons: i.reasons })).join('')}</ol>`
              : '<p class="empty">今日やるタスクはまだありません。上の入力欄から追加するか、下の候補の「今日」を押して選んでください。</p>'}
          </section>
          <section class="panel">
            <div class="section-head"><h2>余力があれば</h2><span class="muted">スコア順</span></div>
            ${plan.more.length ? `<ul class="tasks">${plan.more.map((i) => taskRow(i.task, { reasons: i.reasons })).join('')}</ul>` : '<p class="empty">候補はありません。</p>'}
          </section>
          ${doneToday.length ? `<section class="panel"><div class="section-head"><h2>今日完了 <span class="num muted">${doneToday.length}</span></h2></div>
            <ul class="tasks">${doneToday.map((t) => taskRow(t)).join('')}</ul></section>` : ''}
        </div>
        <div class="stack">
          <section>
            <div class="section-head"><h2>フォロー</h2><button class="btn btn-sm btn-ghost" type="button" data-action="nav" data-view="follow">すべて見る（${follows.length}）</button></div>
            <div class="follow-list">${follows.length ? follows.slice(0, 3).map((f) => followCard(f, true)).join('') : '<p class="empty">気になる点はありません。いい調子です。</p>'}</div>
          </section>
          <section class="panel">
            <div class="section-head"><h2>回答待ち <span class="num muted">${plan.waiting.length}</span></h2></div>
            ${plan.waiting.length ? `<ul class="tasks">${plan.waiting.map((t) => taskRow(t)).join('')}</ul>` : '<p class="empty">待ちのタスクはありません。</p>'}
          </section>
          <section class="panel">
            <label class="field"><span>今日のメモ（段取り・気になること）</span>
              <textarea class="textarea" id="journal-plan" data-journal="plan" placeholder="例: 午前はガイドライン案、14時から定例">${h(journal.plan || '')}</textarea></label>
          </section>
        </div>
      </div>`;
  }

  /* ---------- タスク一覧 ---------- */
  function viewTasks() {
    const st = S();
    const f = ui.filters;
    const q = f.q.trim().toLowerCase();
    const match = (t) => {
      if (f.status === 'open' && t.status === 'done') return false;
      if (f.status !== 'open' && f.status !== 'all' && t.status !== f.status) return false;
      if (f.cat !== 'all' && t.categoryId !== f.cat) return false;
      if (q && !(`${t.title} ${t.notes} ${t.waitingFor}`.toLowerCase().includes(q))) return false;
      return true;
    };
    const sorter = (a, b) => (a.status === 'done') - (b.status === 'done')
      || Core.scoreTask(b, ui.today, st.settings).score - Core.scoreTask(a, ui.today, st.settings).score;
    const areas = f.area === 'all' ? Object.keys(Core.AREAS) : [f.area];
    const blocks = areas.map((area) => {
      const panels = st.categories.filter((c) => c.area === area && (f.cat === 'all' || f.cat === c.id)).map((c) => {
        const list = st.tasks.filter((t) => t.categoryId === c.id && match(t)).sort(sorter);
        return `<section class="panel cat-panel">
          <div class="section-head"><h3>${h(c.name)} <span class="num muted">${list.length}</span></h3>
            <button class="btn btn-sm btn-ghost" type="button" data-action="add-in-category" data-cat="${c.id}">＋ 追加</button></div>
          ${list.length ? `<ul class="tasks">${list.map((t) => taskRow(t, { hideCat: true, statusButton: true })).join('')}</ul>` : '<p class="empty">該当なし</p>'}
        </section>`;
      }).join('');
      return `<div class="area-block"><div class="area-title ${area}">${Core.AREAS[area]}</div><div class="cat-grid">${panels}</div></div>`;
    }).join('');
    const uncategorized = st.tasks.filter((t) => !Store.category(t.categoryId) && match(t));
    const catOpts = st.categories.filter((c) => f.area === 'all' || c.area === f.area)
      .map((c) => `<option value="${c.id}" ${f.cat === c.id ? 'selected' : ''}>${h(Core.categoryLabel(c))}</option>`).join('');
    const seg = (key, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-action="filter" data-key="${key}" data-value="${v}" aria-pressed="${f[key] === v}">${l}</button>`).join('')}</div>`;
    return `
      <div class="view-head"><div><h1>タスク</h1><p>区分ごとに一覧します。状態のラベルを押すと 未着手 → 進行中 → 待ち と切り替わります。</p></div></div>
      <div class="filters">
        ${seg('area', [['all', 'すべて'], ['work', '業務'], ['own', '自社作業']])}
        <label class="visually-hidden" for="filter-cat">区分</label>
        <select class="select" id="filter-cat" data-filter="cat" style="width:auto"><option value="all">区分: すべて</option>${catOpts}</select>
        ${seg('status', [['open', '未完了'], ['doing', '進行中'], ['waiting', '待ち'], ['done', '完了'], ['all', '全部']])}
        <label class="visually-hidden" for="filter-q">検索</label>
        <input class="input" id="filter-q" type="search" data-filter="q" placeholder="キーワードで絞り込み" value="${h(f.q)}">
      </div>
      <div class="stack">
        ${uncategorized.length ? `<section class="panel cat-panel"><div class="section-head"><h3>未分類 <span class="num muted">${uncategorized.length}</span></h3></div>
          <ul class="tasks">${uncategorized.map((t) => taskRow(t, { statusButton: true })).join('')}</ul></section>` : ''}
        ${blocks}
      </div>`;
  }

  /* ---------- フォロー ---------- */
  function viewFollow(follows) {
    const groups = [['critical', '要対応'], ['warn', '注意'], ['info', '提案']];
    return `
      <div class="view-head"><div><h1>フォロー</h1><p>期限超過・待ち・停滞・偏りを毎日チェックして声をかけます。対応したものは自動で消えます。</p></div></div>
      ${follows.length ? groups.map(([lv, label]) => {
        const items = follows.filter((f) => f.level === lv);
        return items.length ? `<section class="stack" style="gap:10px;margin-bottom:24px"><h2>${label} <span class="num muted">${items.length}</span></h2>
          <div class="follow-list">${items.map((f) => followCard(f)).join('')}</div></section>` : '';
      }).join('') : '<div class="panel"><p class="empty">フォローが必要なものはありません。</p></div>'}`;
  }

  /* ---------- AIと考える ---------- */
  function viewAI() {
    const st = S();
    const a = ui.ai;
    const direct = AI.isDirect(st.settings);
    const open = st.tasks.filter((t) => t.status !== 'done');
    const taskSelect = (label, required) => `<label class="field"><span>${label}</span>
      <select class="select" id="ai-task" data-ai="taskId">${required ? '' : '<option value="">（なし）</option>'}
      ${open.map((t) => `<option value="${t.id}" ${a.taskId === t.id ? 'selected' : ''}>${h(t.title)}</option>`).join('')}</select></label>`;
    const textArea = (label, ph, rows) => `<label class="field"><span>${label}</span>
      <textarea class="textarea" id="ai-text" data-ai="text" rows="${rows || 3}" placeholder="${h(ph)}">${h(a.text)}</textarea></label>`;
    let inputs = '';
    if (a.mode === 'plan') inputs = textArea('補足（任意）', '例: 14〜16時は会議。月次見込は午前中に出したい');
    if (a.mode === 'breakdown') inputs = taskSelect('分解するタスク', true) + textArea('補足（任意）', '例: 情シスのレビューが必要。来週の部会で説明したい');
    if (a.mode === 'extract') inputs = textArea('議事録・チャット・メモを貼り付け', '例: 定例の議事録、上司からのチャット、手書きメモの書き起こし', 8);
    if (a.mode === 'consult') inputs = textArea('相談したいこと', '例: Copilotの全社展開、まずどの部署から始めるのがいいか迷っている', 5) + taskSelect('関連するタスク（任意）', false);
    if (a.mode === 'review') {
      const s = Core.completionStats(st.tasks, ui.today, st.categories, 7);
      inputs = `<p class="note">直近7日の完了 <b class="num">${s.total}</b>件、未完了 <b class="num">${open.length}</b>件、日々のメモをまとめて渡します。</p>`;
    }
    const step3 = a.prompt ? `
      <div class="step"><span class="step-no">3</span><div class="step-body">
        <h3>${direct ? 'AIの回答' : 'AIの回答を貼り付けて読み込む'}</h3>
        <textarea class="textarea mono" id="ai-response" data-ai="response" rows="6" placeholder="AIの回答をそのまま全部貼り付けてください（最後の JSON ブロックを読み取ります）">${h(a.response)}</textarea>
        <div class="row"><button class="btn btn-primary" type="button" data-action="ai-parse">回答を読み込む</button></div>
        ${a.error ? `<p class="note warn">${h(a.error)}</p>` : ''}
        ${a.proposals ? `
          ${a.prose ? `<div class="field"><span>AIのコメント</span><div class="prose">${h(a.prose)}</div></div>` : ''}
          ${a.proposals.length ? `<div class="field"><span>反映できる変更（チェックしたものだけ反映します）</span>
            <ul class="proposals">${a.proposals.map((p, i) => `<li><label><input type="checkbox" data-action="ai-toggle" data-index="${i}" ${a.selected[i] !== false ? 'checked' : ''}>
              <span>${h(p.label)}${p.note ? `<small>${h(p.note)}</small>` : ''}</span></label></li>`).join('')}</ul></div>
            <div class="row"><button class="btn btn-primary" type="button" data-action="ai-apply">選んだ変更を反映</button></div>`
            : '<p class="note">反映できる変更は見つかりませんでした。コメントを参考にしてください。</p>'}` : ''}
      </div></div>` : '';
    return `
      <div class="view-head"><div><h1>AIと考える</h1><p>今のタスク状況を添えて AI に相談し、返ってきた提案をワンクリックでタスクに反映します。</p></div></div>
      <div class="mode-tabs" role="group" aria-label="相談の種類">${Object.entries(Core.AI_MODES).map(([k, m]) => `<button class="mode-tab" type="button" data-action="ai-mode" data-mode="${k}" aria-pressed="${a.mode === k}">${m.label}</button>`).join('')}</div>
      <p class="muted" style="margin:10px 0 18px">${h(Core.AI_MODES[a.mode].desc)}</p>
      <div class="panel steps">
        <div class="step"><span class="step-no">1</span><div class="step-body">
          <h3>相談内容</h3>${inputs}
          <div class="row"><button class="btn btn-primary" type="button" data-action="ai-build">${direct ? 'AIに送信' : 'プロンプトを作成'}</button>
          ${a.busy ? '<span class="muted">AIが考えています…</span>' : ''}</div>
        </div></div>
        ${a.prompt && !direct ? `<div class="step"><span class="step-no">2</span><div class="step-body">
          <h3>プロンプトをコピーして AI に貼り付け</h3>
          <p class="muted">GitHub Copilot Chat など、社内で利用が許可された AI に貼り付けてください。タスク名やメモが含まれるため、社外サービスには貼らないでください。</p>
          <textarea class="textarea mono" id="ai-prompt" rows="8" readonly>${h(Core.promptAsText(a.prompt))}</textarea>
          <div class="row"><button class="btn" type="button" data-action="copy" data-target="#ai-prompt">プロンプトをコピー</button></div>
        </div></div>` : ''}
        ${step3}
      </div>
      ${direct ? '' : '<p class="muted" style="margin-top:12px;font-size:.8rem">設定で OpenAI 互換の API を登録すると、コピー＆ペーストなしで直接送信できます。</p>'}`;
  }

  /* ---------- 振り返り ---------- */
  function dayChart(byDay) {
    const W = 560; const H = 150; const padL = 24; const padB = 22; const padT = 10;
    const max = Math.max(4, ...byDay.map((d) => d.count));
    const step = Math.ceil(max / 4);
    const top = step * 4;
    const cw = (W - padL) / byDay.length;
    const y = (v) => padT + (H - padT - padB) * (1 - v / top);
    let g = '';
    for (let v = 0; v <= top; v += step) g += `<line class="grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
    const cols = byDay.map((d, i) => {
      const x = padL + i * cw + cw * 0.2;
      const hgt = y(0) - y(d.count);
      const dt = Core.parseISO(d.date);
      const label = i % 2 === byDay.length % 2 || i === byDay.length - 1 ? `<text x="${x + cw * 0.3}" y="${H - 6}" text-anchor="middle">${dt.getMonth() + 1}/${dt.getDate()}</text>` : '';
      return `<rect class="col${d.date === ui.today ? ' today' : ''}" x="${x}" y="${y(d.count)}" width="${cw * 0.6}" height="${Math.max(hgt, 0)}" rx="2"><title>${Core.formatDate(d.date)}: ${d.count}件</title></rect>${label}`;
    }).join('');
    return `<svg class="daychart" viewBox="0 0 ${W} ${H}" role="img" aria-label="日別の完了件数（直近14日）">${g}${cols}</svg>`;
  }

  function viewReview() {
    const st = S();
    const week = Core.completionStats(st.tasks, ui.today, st.categories, 7);
    const two = Core.completionStats(st.tasks, ui.today, st.categories, 14);
    const open = st.tasks.filter((t) => t.status !== 'done');
    const overdue = open.filter((t) => t.due && Core.diffDays(t.due, ui.today) < 0).length;
    const doneToday = two.byDay[two.byDay.length - 1].count;
    const max = Math.max(1, ...week.byCategory.map((b) => b.count));
    const journal = st.journal[ui.today] || {};
    const recent = st.tasks.filter((t) => t.status === 'done').sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '')).slice(0, 10);
    return `
      <div class="view-head"><div><h1>振り返り</h1><p>時間の使い方の偏りを確認し、日報の下書きを作ります。</p></div>
        <button class="btn" type="button" data-action="goto-ai" data-mode="review">AIと週次振り返り</button></div>
      <div class="grid-cards" style="margin-bottom:20px">
        <div class="stat"><span class="label">今日の完了</span><span class="value">${doneToday}<small>件</small></span></div>
        <div class="stat"><span class="label">直近7日の完了</span><span class="value">${week.total}<small>件</small></span></div>
        <div class="stat"><span class="label">未完了</span><span class="value">${open.length}<small>件</small></span></div>
        <div class="stat${overdue ? ' alert' : ''}"><span class="label">期限超過</span><span class="value">${overdue}<small>件</small></span></div>
      </div>
      <div class="grid-2">
        <div class="stack">
          <section class="panel"><div class="section-head"><h2>区分別の完了（直近7日）</h2></div>
            <div class="bars">${week.byCategory.map((b) => `<div class="bar-row"><span class="name" title="${h(Core.categoryLabel(b.category))}">${h(Core.AREAS[b.category.area].slice(0, 2))}・${h(b.category.name)}</span>
              <span class="bar-track"><span class="bar-fill area-${b.category.area}" style="width:${(b.count / max) * 100}%;display:block"></span></span><span class="n">${b.count}</span></div>`).join('')}</div>
          </section>
          <section class="panel"><div class="section-head"><h2>日別の完了（直近14日）</h2></div>${dayChart(two.byDay)}</section>
          <section class="panel"><div class="section-head"><h2>最近の完了</h2></div>
            ${recent.length ? `<ul class="tasks">${recent.map((t) => taskRow(t)).join('')}</ul>` : '<p class="empty">まだ完了したタスクはありません。</p>'}</section>
        </div>
        <div class="stack">
          <section class="panel">
            <label class="field"><span>今日の振り返り（日報の所感に入ります）</span>
              <textarea class="textarea" id="journal-reflection" data-journal="reflection" rows="4" placeholder="例: ガイドライン案は8割。法務確認待ちで止まらないよう先に論点を送った">${h(journal.reflection || '')}</textarea></label>
          </section>
          <section class="panel">
            <div class="section-head"><h2>日報の下書き</h2><button class="btn btn-sm" type="button" data-action="copy" data-target="#daily-report">コピー</button></div>
            <textarea class="textarea mono" id="daily-report" rows="14" readonly>${h(Core.dailyReport(st.tasks, ui.today, st.categories, st.journal, st.settings))}</textarea>
          </section>
        </div>
      </div>`;
  }

  /* ---------- 設定 ---------- */
  function viewSettings() {
    const st = S();
    const s = st.settings;
    const ai = s.ai;
    const catOptions = (sel) => st.categories.map((c) => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${h(Core.categoryLabel(c))}</option>`).join('');
    return `
      <div class="view-head"><div><h1>設定</h1><p>区分・定例作業・AI 接続・データの書き出しを管理します。</p></div></div>
      <div class="stack">
        <section class="panel stack" style="gap:12px"><h2>計画のルール</h2>
          <div class="settings-grid">
            <label class="field"><span>1日の作業容量（分）</span><input class="input num" type="number" min="60" step="30" id="set-capacity" data-setting="capacityMin" value="${s.capacityMin}"></label>
            <label class="field"><span>停滞とみなす日数</span><input class="input num" type="number" min="1" id="set-stale" data-setting="staleDays" value="${s.staleDays}"></label>
            <label class="field"><span>待ちをフォローする日数</span><input class="input num" type="number" min="1" id="set-waiting" data-setting="waitingDays" value="${s.waitingDays}"></label>
          </div>
          <p class="muted" style="font-size:.8rem">容量は会議を除いた、実際に手を動かせる時間の目安です。</p>
        </section>

        <section class="panel stack" style="gap:12px"><div class="row between"><h2>区分</h2><button class="btn btn-sm" type="button" data-action="cat-add">＋ 区分を追加</button></div>
          <p class="muted" style="font-size:.8rem">キーワードはクイック入力と AI 取り込み時の自動分類に使います（読点・カンマ区切り）。</p>
          <div class="table-wrap"><table class="table"><thead><tr><th style="width:120px">大区分</th><th style="width:160px">名前</th><th>キーワード</th><th style="width:48px"></th></tr></thead><tbody>
          ${st.categories.map((c) => `<tr>
            <td><select class="select" data-cat-id="${c.id}" data-field="area" aria-label="大区分">${Object.entries(Core.AREAS).map(([k, v]) => `<option value="${k}" ${c.area === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
            <td><input class="input" data-cat-id="${c.id}" data-field="name" value="${h(c.name)}" aria-label="区分名"></td>
            <td><input class="input" data-cat-id="${c.id}" data-field="keywords" value="${h((c.keywords || []).join('、'))}" aria-label="キーワード"></td>
            <td><button class="btn btn-sm btn-ghost btn-danger" type="button" data-action="cat-del" data-cat="${c.id}" aria-label="削除">削除</button></td></tr>`).join('')}
          </tbody></table></div>
        </section>

        <section class="panel stack" style="gap:12px"><div class="row between"><h2>定例作業</h2><button class="btn btn-sm" type="button" data-action="routine-add">＋ 定例を追加</button></div>
          <p class="muted" style="font-size:.8rem">該当する日に、その日のタスクとして自動で追加されます。</p>
          <div class="table-wrap"><table class="table" style="min-width:720px"><thead><tr><th>タスク名</th><th style="width:170px">区分</th><th style="width:110px">頻度</th><th style="width:96px">曜日・日</th><th style="width:70px">見積分</th><th style="width:48px"></th></tr></thead><tbody>
          ${st.routines.length ? st.routines.map((r) => `<tr>
            <td><input class="input" data-routine-id="${r.id}" data-field="title" value="${h(r.title)}" aria-label="タスク名"></td>
            <td><select class="select" data-routine-id="${r.id}" data-field="categoryId" aria-label="区分">${catOptions(r.categoryId)}</select></td>
            <td><select class="select" data-routine-id="${r.id}" data-field="freq" aria-label="頻度">
              ${[['weekday', '平日毎日'], ['weekly', '毎週'], ['monthly', '毎月']].map(([k, v]) => `<option value="${k}" ${r.freq === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
            <td>${r.freq === 'weekly'
              ? `<select class="select" data-routine-id="${r.id}" data-field="day" aria-label="曜日">${Core.WEEK.map((w, i) => `<option value="${i}" ${Number(r.day) === i ? 'selected' : ''}>${w}曜</option>`).join('')}</select>`
              : r.freq === 'monthly'
                ? `<select class="select" data-routine-id="${r.id}" data-field="day" aria-label="日">${Array.from({ length: 31 }, (_, i) => i + 1).map((d) => `<option value="${d}" ${Number(r.day) === d ? 'selected' : ''}>${d === 31 ? '月末' : `${d}日`}</option>`).join('')}</select>`
                : '<span class="muted">—</span>'}</td>
            <td><input class="input num" type="number" min="5" step="5" data-routine-id="${r.id}" data-field="estimate" value="${r.estimate || ''}" aria-label="見積分"></td>
            <td><button class="btn btn-sm btn-ghost btn-danger" type="button" data-action="routine-del" data-routine="${r.id}">削除</button></td></tr>`).join('')
            : '<tr><td colspan="6" class="muted">定例はまだありません。</td></tr>'}
          </tbody></table></div>
        </section>

        <section class="panel stack" style="gap:12px"><h2>AI 接続</h2>
          <div class="seg" role="group" aria-label="接続方法">
            <button type="button" data-action="ai-conn" data-value="manual" aria-pressed="${ai.mode !== 'api'}">コピー＆ペースト（推奨）</button>
            <button type="button" data-action="ai-conn" data-value="api" aria-pressed="${ai.mode === 'api'}">API に直接送信</button>
          </div>
          ${ai.mode === 'api' ? `
            <p class="note warn">API キーはこのブラウザの localStorage に平文で保存されます。会社で運用する場合は、キーを持たない社内プロキシのURLを指定するなど、情報システム部門のルールに従ってください。</p>
            <div class="settings-grid">
              <label class="field" style="grid-column:1/-1"><span>エンドポイント（OpenAI 互換の chat/completions）</span><input class="input" id="set-ai-endpoint" data-ai-setting="endpoint" value="${h(ai.endpoint)}" placeholder="https://example.openai.azure.com/openai/deployments/xxx/chat/completions?api-version=2024-06-01"></label>
              <label class="field"><span>モデル名（必要な場合）</span><input class="input" id="set-ai-model" data-ai-setting="model" value="${h(ai.model)}"></label>
              <label class="field"><span>認証ヘッダー</span><select class="select" id="set-ai-auth" data-ai-setting="authHeader">
                <option value="bearer" ${ai.authHeader === 'bearer' ? 'selected' : ''}>Authorization: Bearer</option>
                <option value="api-key" ${ai.authHeader === 'api-key' ? 'selected' : ''}>api-key（Azure）</option></select></label>
              <label class="field"><span>API キー</span><input class="input" type="password" id="set-ai-key" data-ai-setting="apiKey" value="${h(ai.apiKey)}" autocomplete="off"></label>
            </div>` : '<p class="muted" style="font-size:.88rem">「AIと考える」で作ったプロンプトを GitHub Copilot Chat などに貼り、回答を貼り戻して取り込みます。キーの管理が不要で、社内ルールに合わせやすい方法です。</p>'}
        </section>

        <section class="panel stack" style="gap:12px"><h2>データ</h2>
          <p class="muted" style="font-size:.88rem">データはこのブラウザにだけ保存されています。PC の入れ替えやキャッシュ削除に備えて、定期的に書き出してください。</p>
          <div class="row">
            <button class="btn" type="button" data-action="export-file">JSON ファイルに書き出す</button>
            <button class="btn" type="button" data-action="export-copy">JSON をコピー</button>
            <label class="btn" for="import-file">ファイルから読み込む</label>
            <input type="file" id="import-file" accept="application/json,.json" hidden>
          </div>
          <label class="field"><span>JSON を貼り付けて読み込む（今のデータは置き換わります）</span>
            <textarea class="textarea mono" id="import-text" rows="3" placeholder='{"tasks":[...]}'></textarea></label>
          <div class="row"><button class="btn" type="button" data-action="import-text">貼り付けた JSON を読み込む</button>
            <button class="btn btn-ghost" type="button" data-action="load-sample">サンプルデータを読み込む</button>
            <button class="btn btn-ghost btn-danger" type="button" data-action="clear-sample">すべてのタスクを消去</button></div>
        </section>
      </div>`;
  }

  /* ---------- ドロワー（タスク詳細） ---------- */
  function renderDrawer() {
    const el = $('#drawer');
    const scrim = $('#scrim');
    if (ui.textPanel) {
      el.innerHTML = `<div class="drawer-head"><h2>${h(ui.textPanel.title)}</h2><button class="btn btn-ghost" type="button" data-action="close">閉じる</button></div>
        <textarea class="textarea" id="text-panel" rows="10">${h(ui.textPanel.text)}</textarea>
        <div class="row"><button class="btn btn-primary" type="button" data-action="copy" data-target="#text-panel">コピー</button></div>`;
      el.hidden = false; scrim.hidden = false;
      return;
    }
    const t = ui.drawerTaskId && Store.task(ui.drawerTaskId);
    if (!t) { el.hidden = true; scrim.hidden = true; el.innerHTML = ''; return; }
    const pinned = t.todayPin === ui.today;
    const segBtns = (field, map) => Object.entries(map).map(([k, v]) => `<button type="button" data-action="set-field" data-field="${field}" data-value="${k}" aria-pressed="${String(t[field]) === k}">${v}</button>`).join('');
    const catOptions = Object.entries(Core.AREAS).map(([area, label]) => `<optgroup label="${label}">${cats().filter((c) => c.area === area).map((c) => `<option value="${c.id}" ${t.categoryId === c.id ? 'selected' : ''}>${h(c.name)}</option>`).join('')}</optgroup>`).join('');
    const fri = nextFriday();
    el.innerHTML = `
      <div class="drawer-head"><span class="label">タスク${t.recurringId ? '・定例' : ''}</span><button class="btn btn-ghost" type="button" data-action="close">閉じる</button></div>
      <label class="visually-hidden" for="d-title">タスク名</label>
      <textarea class="textarea title-input" id="d-title" rows="2" data-field="title">${h(t.title)}</textarea>
      <div class="drawer-grid">
        <label class="field"><span>区分</span><select class="select" id="d-cat" data-field="categoryId"><option value="">未分類</option>${catOptions}</select></label>
        <div class="field"><span>今日の計画</span><button class="pin-btn" style="padding:8px 12px;font-size:.85rem" type="button" data-action="toggle-pin" data-id="${t.id}" aria-pressed="${pinned}">${pinned ? '今日やる（解除）' : '今日やるに入れる'}</button></div>
        <div class="field wide"><span>状態</span><div class="seg" role="group">${segBtns('status', Core.STATUS)}</div></div>
        <div class="field"><span>重要度</span><div class="seg" role="group">${segBtns('priority', Core.PRIORITY)}</div></div>
        <label class="field"><span>見積（分）</span><input class="input num" id="d-est" type="number" min="5" step="5" data-field="estimate" value="${t.estimate || ''}"></label>
        <div class="field wide"><span>期限</span><div class="row">
          <input class="input num" id="d-due" type="date" data-field="due" value="${t.due || ''}" style="width:auto">
          <button class="btn btn-sm" type="button" data-action="set-due" data-value="${ui.today}">今日</button>
          <button class="btn btn-sm" type="button" data-action="set-due" data-value="${Core.addDays(ui.today, 1)}">明日</button>
          <button class="btn btn-sm" type="button" data-action="set-due" data-value="${fri}">金曜</button>
          <button class="btn btn-sm" type="button" data-action="set-due" data-value="${Core.addDays(ui.today, 7)}">1週間後</button>
          ${t.due ? '<button class="btn btn-sm btn-ghost" type="button" data-action="set-due" data-value="">なし</button>' : ''}</div></div>
        <label class="field wide"><span>待ち相手・関係者</span><input class="input" id="d-wait" data-field="waitingFor" value="${h(t.waitingFor)}" placeholder="例: 佐藤"></label>
      </div>
      <div class="field"><span>手順・サブタスク</span>
        <ul class="sub-list">${(t.subtasks || []).map((s) => `<li class="${s.done ? 'done' : ''}"><input type="checkbox" data-action="sub-toggle" data-sub="${s.id}" ${s.done ? 'checked' : ''} aria-label="完了"><span>${h(s.title)}</span><button class="x" type="button" data-action="sub-del" data-sub="${s.id}" aria-label="削除">×</button></li>`).join('')}</ul>
        <form class="row" data-form="sub-add"><input class="input" id="d-sub" placeholder="手順を追加して Enter" style="flex:1"><button class="btn btn-sm" type="submit">追加</button></form>
      </div>
      <label class="field"><span>メモ</span><textarea class="textarea" id="d-notes" data-field="notes" rows="3" placeholder="背景・リンク・決まったこと">${h(t.notes)}</textarea></label>
      <div class="field"><span>経過</span>
        <form class="row" data-form="log-add"><input class="input" id="d-log" placeholder="進捗や確認したことを記録して Enter" style="flex:1"><button class="btn btn-sm" type="submit">記録</button></form>
        <ul class="log-list">${[...(t.log || [])].reverse().slice(0, 12).map((l) => `<li><time>${h(fmtStamp(l.at))}</time><span>${h(l.text)}</span></li>`).join('')}
          <li><time>${h(fmtStamp(t.createdAt))}</time><span class="muted">作成</span></li></ul>
      </div>
      ${ui.confirmDelete ? `<div class="confirm"><span>このタスクを削除しますか？</span><button class="btn btn-sm btn-danger" type="button" data-action="delete-yes">削除する</button><button class="btn btn-sm btn-ghost" type="button" data-action="delete-no">やめる</button></div>` : ''}
      <div class="drawer-foot">
        <div class="row"><button class="btn btn-sm" type="button" data-action="goto-ai" data-mode="breakdown" data-id="${t.id}">AIと分解</button>
          <button class="btn btn-sm" type="button" data-action="goto-ai" data-mode="consult" data-id="${t.id}">AIに相談</button>
          ${t.status === 'waiting' ? `<button class="btn btn-sm" type="button" data-action="follow" data-kind="remind" data-id="${t.id}">リマインド文</button>` : ''}
          <button class="btn btn-sm btn-ghost btn-danger" type="button" data-action="delete-ask">削除</button></div>
        ${t.status === 'done' ? `<button class="btn" type="button" data-action="undone" data-id="${t.id}">未完了に戻す</button>`
          : `<button class="btn btn-primary" type="button" data-action="complete" data-id="${t.id}">完了にする</button>`}
      </div>`;
    el.hidden = false; scrim.hidden = false;
  }
  const fmtStamp = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  function nextFriday() {
    const wd = Core.weekday(ui.today);
    const add = (5 - wd + 7) % 7 || 7;
    return Core.addDays(ui.today, wd === 5 ? 7 : add);
  }

  function openDrawer(id) { ui.drawerTaskId = id; ui.textPanel = null; ui.confirmDelete = false; renderDrawer(); setTimeout(() => { const f = $('#drawer .btn-ghost'); if (f) f.focus(); }, 0); }
  function closeDrawer() { ui.drawerTaskId = null; ui.textPanel = null; ui.confirmDelete = false; renderDrawer(); }
  function showText(title, text) { ui.textPanel = { title, text }; ui.drawerTaskId = null; renderDrawer(); }

  /* ---------- トースト ---------- */
  let toastTimer;
  function toast(msg, action) {
    const el = $('#toast');
    el.innerHTML = `<span>${h(msg)}</span>${action ? `<button type="button" id="toast-action">${h(action.label)}</button>` : ''}`;
    el.hidden = false;
    if (action) $('#toast-action').onclick = () => { action.fn(); el.hidden = true; };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 2800);
  }

  async function copyText(text, el) {
    try {
      await navigator.clipboard.writeText(text);
      toast('コピーしました');
    } catch (e) {
      if (el && el.select) { el.focus(); el.select(); toast('選択しました。Ctrl+C（⌘C）でコピーしてください'); }
      else showText('コピーしてください', text);
    }
  }

  /* ---------- 描画 ---------- */
  function render() {
    const st = S();
    const follows = Core.followUps(st.tasks, ui.today, st.settings, st.categories);
    renderNav(follows);
    renderBanner();
    const view = $('#view');
    const scroll = window.scrollY;
    const html = {
      today: () => viewToday(follows), tasks: viewTasks, follow: () => viewFollow(follows),
      ai: viewAI, review: viewReview, settings: viewSettings,
    }[ui.view] || (() => viewToday(follows));
    view.innerHTML = html();
    window.scrollTo(0, scroll);
  }

  function setView(v) {
    ui.view = v;
    try { sessionStorage.setItem('job-dashboard:view', v); } catch (e) { /* 無視 */ }
    render();
    window.scrollTo(0, 0);
  }

  /* ---------- 操作 ---------- */
  function completeTask(id) {
    const t = Store.task(id);
    if (!t) return;
    const prev = t.status;
    Store.updateTask(id, { status: 'done', todayPin: t.todayPin }, '完了');
    if (ui.drawerTaskId === id) closeDrawer();
    toast(`「${t.title}」を完了しました`, { label: '元に戻す', fn: () => Store.updateTask(id, { status: prev }, '完了を取り消し') });
  }

  function aiContext() {
    const st = S();
    return { today: ui.today, tasks: st.tasks, categories: st.categories, settings: st.settings, journal: st.journal, text: ui.ai.text, task: ui.ai.taskId ? Store.task(ui.ai.taskId) : null };
  }

  function gotoAI(mode, taskId, text) {
    ui.ai = { ...ui.ai, mode, taskId: taskId || (mode === 'breakdown' ? ui.ai.taskId : ''), text: text ?? '', prompt: null, response: '', proposals: null, prose: '', selected: {}, error: '' };
    if (mode === 'breakdown' && !ui.ai.taskId) {
      const first = S().tasks.find((t) => t.status !== 'done');
      ui.ai.taskId = first ? first.id : '';
    }
    closeDrawer();
    setView('ai');
  }

  async function aiBuild() {
    const a = ui.ai;
    if (a.mode === 'breakdown' && !a.taskId) { toast('分解するタスクを選んでください'); return; }
    if ((a.mode === 'extract' || a.mode === 'consult') && !a.text.trim()) { toast('内容を入力してください'); return; }
    a.prompt = Core.buildPrompt(a.mode, aiContext());
    a.response = ''; a.proposals = null; a.prose = ''; a.error = ''; a.selected = {};
    if (AI.isDirect(S().settings)) {
      a.busy = true; render();
      try {
        a.response = await AI.send(a.prompt, S().settings);
        aiParse();
      } catch (e) {
        a.error = e.message;
      } finally { a.busy = false; render(); }
      return;
    }
    render();
    const p = $('#ai-prompt');
    if (p) p.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function aiParse() {
    const a = ui.ai;
    const res = $('#ai-response');
    if (res) a.response = res.value;
    if (!a.response.trim()) { a.error = 'AI の回答を貼り付けてください。'; render(); return; }
    const { data, prose } = Core.extractJSON(a.response);
    a.prose = prose;
    a.error = data ? '' : 'JSON が見つかりませんでした。コメントだけ表示しています。AI に「最後にJSONで出力して」と追加で頼むと取り込めます。';
    a.proposals = Core.proposalsFrom(a.mode, data, { ...aiContext(), task: a.taskId ? Store.task(a.taskId) : null });
    a.selected = {};
    render();
  }

  function aiApply() {
    const a = ui.ai;
    let n = 0;
    (a.proposals || []).forEach((p, i) => {
      if (a.selected[i] === false) return;
      n++;
      if (p.kind === 'pin') Store.updateTask(p.taskId, { todayPin: ui.today, todayOrder: p.payload.order }, p.note ? `AI提案: 今日やる（${p.note}）` : null);
      if (p.kind === 'due') Store.updateTask(p.taskId, { due: p.payload.due }, `AI提案で期限を${Core.formatDate(p.payload.due)}に変更${p.note ? `（${p.note}）` : ''}`);
      if (p.kind === 'subtask') Store.addSubtask(p.taskId, p.payload.title);
      if (p.kind === 'estimate') Store.updateTask(p.taskId, { estimate: p.payload.estimate });
      if (p.kind === 'log') Store.updateTask(p.taskId, {}, p.payload.text);
      if (p.kind === 'add') Store.addTask(p.payload, 'AIの提案から追加');
      if (p.kind === 'journal') {
        const cur = (S().journal[p.payload.date] || {}).reflection || '';
        Store.setJournal(p.payload.date, 'reflection', cur ? `${cur}\n\n${p.payload.text}` : p.payload.text);
      }
    });
    toast(`${n}件の変更を反映しました`);
    ui.ai.proposals = null; ui.ai.prompt = null; ui.ai.response = ''; ui.ai.prose = '';
    if (a.mode === 'plan') setView('today'); else render();
  }

  function handleFollow(kind, id, followId, catId) {
    const t = id ? Store.task(id) : null;
    if (kind === 'pin' && t) { Store.updateTask(id, { todayPin: ui.today }); toast('今日やるに入れました'); }
    if (kind === 'due+1' && t) Store.updateTask(id, { due: Core.addDays(ui.today, 1) }, '期限を明日に変更');
    if (kind === 'due+friday' && t) Store.updateTask(id, { due: nextFriday() }, `期限を${Core.formatDate(nextFriday())}に設定`);
    if (kind === 'done' && t) completeTask(id);
    if (kind === 'remind' && t) {
      Store.updateTask(id, {}, 'リマインド文を作成');
      showText('リマインド文', Core.reminderText(t));
    }
    if (kind === 'touch' && t) { Store.updateTask(id, {}, '状況を確認（待ち継続）'); toast('確認済みとして記録しました'); }
    if (kind === 'resume' && t) Store.updateTask(id, { status: 'doing' }, '進行中に戻す');
    if (kind === 'breakdown' && t) gotoAI('breakdown', id);
    if (kind === 'open' && t) openDrawer(id);
    if (kind === 'ai-plan') gotoAI('plan');
    if (kind === 'add-in-category') prefillQuick(catId);
    if (kind === 'ai-consult') {
      const c = Store.category(catId);
      gotoAI('consult', '', `「${Core.categoryLabel(c)}」でここ2週間タスクが出ていません。今の時期にやっておくべきこと、見落としていそうなことは何でしょうか。`);
    }
  }

  function prefillQuick(catId) {
    const c = Store.category(catId);
    const input = $('#quick-input');
    input.value = c ? `#${c.name} ` : '';
    if (c) ui.quickCat = c.id;
    input.focus();
    updateQuickPreview();
  }

  /* ---------- クイック入力 ---------- */
  function parseQuick() {
    const input = $('#quick-input');
    const parsed = Core.parseQuickAdd(input.value, ui.today, cats());
    // 同名の区分（定例作業）が複数あるので、ボタンから指定した区分を優先する
    if (ui.quickCat && input.value.includes(`#${(Store.category(ui.quickCat) || {}).name}`)) parsed.categoryId = ui.quickCat;
    return parsed;
  }
  function updateQuickPreview() {
    const input = $('#quick-input');
    const el = $('#quick-preview');
    if (!input.value.trim()) { el.innerHTML = ''; return; }
    const p = parseQuick();
    el.innerHTML = [
      catChip(p.categoryId),
      p.due ? `<span class="chip due-${Core.dueInfo(p.due, ui.today).state}">期限 ${h(Core.formatDate(p.due))}</span>` : '<span class="chip">期限なし</span>',
      `<span class="chip ${p.priority === 1 ? 'prio-1' : ''}">重要度 ${Core.PRIORITY[p.priority]}</span>`,
      p.estimate ? `<span class="chip">${p.estimate}分</span>` : '',
      p.people.length ? `<span class="chip">関係者 ${h(p.people.join('・'))}</span>` : '',
    ].join('');
  }
  function submitQuick(e) {
    e.preventDefault();
    const input = $('#quick-input');
    if (!input.value.trim()) return;
    const p = parseQuick();
    const pin = $('#quick-today').checked;
    const t = Store.addTask({
      title: p.title, categoryId: p.categoryId, priority: p.priority, due: p.due, estimate: p.estimate,
      waitingFor: p.people.join('・'), todayPin: pin ? ui.today : null,
    });
    input.value = ''; ui.quickCat = null;
    $('#quick-today').checked = false;
    updateQuickPreview();
    toast(`「${t.title}」を追加しました`, { label: '詳細を開く', fn: () => openDrawer(t.id) });
  }

  /* ---------- イベント ---------- */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action } = btn.dataset;
    const id = btn.dataset.id || (btn.closest('[data-id]') || {}).dataset?.id;
    const tid = ui.drawerTaskId;
    switch (action) {
      case 'nav': closeDrawer(); setView(btn.dataset.view); break;
      case 'open': openDrawer(id); break;
      case 'close': closeDrawer(); break;
      case 'complete': completeTask(id); break;
      case 'undone': Store.updateTask(id, { status: 'todo' }, '未完了に戻す'); if (tid) renderDrawer(); break;
      case 'toggle-pin': {
        const t = Store.task(id);
        Store.updateTask(id, { todayPin: t.todayPin === ui.today ? null : ui.today, todayOrder: null });
        if (tid) renderDrawer();
        break;
      }
      case 'cycle-status': {
        const t = Store.task(id);
        const next = { todo: 'doing', doing: 'waiting', waiting: 'todo', done: 'todo' }[t.status];
        Store.updateTask(id, { status: next }, `状態を「${Core.STATUS[next]}」に変更`);
        break;
      }
      case 'set-field': {
        const { field, value } = btn.dataset;
        const val = field === 'priority' ? Number(value) : value;
        Store.updateTask(tid, { [field]: val }, field === 'status' ? `状態を「${Core.STATUS[val]}」に変更` : null);
        renderDrawer();
        break;
      }
      case 'set-due': Store.updateTask(tid, { due: btn.dataset.value || null }); renderDrawer(); break;
      case 'sub-toggle': Store.toggleSubtask(tid, btn.dataset.sub); renderDrawer(); break;
      case 'sub-del': Store.removeSubtask(tid, btn.dataset.sub); renderDrawer(); break;
      case 'delete-ask': ui.confirmDelete = true; renderDrawer(); break;
      case 'delete-no': ui.confirmDelete = false; renderDrawer(); break;
      case 'delete-yes': {
        const r = Store.deleteTask(tid);
        closeDrawer();
        if (r) toast(`「${r.task.title}」を削除しました`, { label: '元に戻す', fn: () => Store.restoreTask(r.task, r.index) });
        break;
      }
      case 'follow': handleFollow(btn.dataset.kind, btn.dataset.id, btn.dataset.follow, btn.dataset.cat); break;
      case 'snooze': Store.snooze(btn.dataset.follow, Core.addDays(ui.today, 1)); toast('明日まで表示しません'); break;
      case 'add-in-category': prefillQuick(btn.dataset.cat); break;
      case 'filter': ui.filters[btn.dataset.key] = btn.dataset.value; if (btn.dataset.key === 'area') ui.filters.cat = 'all'; render(); break;
      case 'goto-ai': gotoAI(btn.dataset.mode, btn.dataset.id); break;
      case 'ai-mode': gotoAI(btn.dataset.mode, ui.ai.taskId); break;
      case 'ai-build': aiBuild(); break;
      case 'ai-parse': aiParse(); break;
      case 'ai-toggle': ui.ai.selected[btn.dataset.index] = btn.checked; break;
      case 'ai-apply': aiApply(); break;
      case 'ai-conn': Store.updateSettings({ ai: { ...S().settings.ai, mode: btn.dataset.value } }); break;
      case 'copy': { const el = $(btn.dataset.target); if (el) copyText(el.value, el); break; }
      case 'clear-sample': Store.clearSample(); toast('タスクを消去しました。上の入力欄から追加して始めましょう'); break;
      case 'load-sample': Store.loadSample(); toast('サンプルデータを読み込みました'); break;
      case 'cat-add': {
        const c = { id: Store.uid('c'), area: 'work', name: '新しい区分', keywords: [] };
        Store.setCategories([...cats(), c]);
        break;
      }
      case 'cat-del': {
        const used = S().tasks.some((t) => t.categoryId === btn.dataset.cat && t.status !== 'done');
        if (used && btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = '本当に？'; toast('未完了タスクがある区分です。もう一度押すと削除し、タスクは未分類になります'); break; }
        Store.setCategories(cats().filter((c) => c.id !== btn.dataset.cat));
        break;
      }
      case 'routine-add':
        Store.setRoutines([...S().routines, { id: Store.uid('r'), title: '新しい定例作業', categoryId: 'work-routine', freq: 'weekly', day: 1, priority: 2, estimate: 30, lastGenerated: null }]);
        break;
      case 'routine-del': Store.setRoutines(S().routines.filter((r) => r.id !== btn.dataset.routine)); break;
      case 'export-file': {
        const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `job-dashboard-${ui.today}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        break;
      }
      case 'export-copy': copyText(Store.exportJSON()); break;
      case 'import-text': {
        try { Store.importJSON($('#import-text').value); toast('読み込みました'); } catch (err) { toast(`読み込めませんでした: ${err.message}`); }
        break;
      }
      default: break;
    }
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    const tid = ui.drawerTaskId;
    if (el.closest('#drawer') && el.dataset.field && tid) {
      let v = el.value;
      if (el.dataset.field === 'estimate') v = v ? Number(v) : null;
      if (el.dataset.field === 'due' || el.dataset.field === 'categoryId') v = v || null;
      if (el.dataset.field === 'title') v = v.trim() || Store.task(tid).title;
      Store.updateTask(tid, { [el.dataset.field]: v });
      return;
    }
    if (el.dataset.journal) { Store.setJournal(ui.today, el.dataset.journal, el.value); return; }
    if (el.dataset.filter) { ui.filters[el.dataset.filter] = el.value; render(); return; }
    if (el.dataset.ai) { ui.ai[el.dataset.ai] = el.value; return; }
    if (el.dataset.setting) { Store.updateSettings({ [el.dataset.setting]: Math.max(1, Number(el.value) || 1) }); return; }
    if (el.dataset.aiSetting) { Store.updateSettings({ ai: { ...S().settings.ai, [el.dataset.aiSetting]: el.value.trim() } }); return; }
    if (el.dataset.catId) {
      const v = el.dataset.field === 'keywords' ? el.value.split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean) : el.value;
      Store.setCategories(cats().map((c) => (c.id === el.dataset.catId ? { ...c, [el.dataset.field]: v } : c)));
      return;
    }
    if (el.dataset.routineId) {
      let v = el.value;
      if (['day', 'estimate'].includes(el.dataset.field)) v = Number(v);
      Store.setRoutines(S().routines.map((r) => {
        if (r.id !== el.dataset.routineId) return r;
        const next = { ...r, [el.dataset.field]: v, lastGenerated: null };
        if (el.dataset.field === 'freq') next.day = v === 'monthly' ? 25 : 1;
        return next;
      }));
      return;
    }
    if (el.id === 'import-file' && el.files[0]) {
      el.files[0].text().then((txt) => {
        try { Store.importJSON(txt); toast('読み込みました'); } catch (err) { toast(`読み込めませんでした: ${err.message}`); }
      });
    }
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.id === 'quick-input') updateQuickPreview();
    if (el.dataset.ai) ui.ai[el.dataset.ai] = el.value;
    if (el.id === 'filter-q') {
      ui.filters.q = el.value;
      clearTimeout(ui.qTimer);
      ui.qTimer = setTimeout(() => {
        render();
        const q = $('#filter-q');
        if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      }, 250);
    }
  });

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.id === 'quick-form') return submitQuick(e);
    e.preventDefault();
    const tid = ui.drawerTaskId;
    if (form.dataset.form === 'sub-add') { Store.addSubtask(tid, $('#d-sub').value); renderDrawer(); $('#d-sub').focus(); }
    if (form.dataset.form === 'log-add') {
      const v = $('#d-log').value.trim();
      if (v) { Store.updateTask(tid, {}, v); renderDrawer(); $('#d-log').focus(); }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (ui.drawerTaskId || ui.textPanel)) closeDrawer();
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (!typing && (e.key === '/' || e.key === 'n')) { e.preventDefault(); $('#quick-input').focus(); }
  });
  $('#scrim').addEventListener('click', closeDrawer);

  /* ---------- 起動 ---------- */
  function boot() {
    ui.today = Core.todayISO();
    Store.ensureRoutines(ui.today);
    render();
  }
  Store.onChange(() => render());
  // 日付が変わったら（翌朝タブを開いたままでも）定例生成と再計算
  setInterval(() => { if (Core.todayISO() !== ui.today) boot(); }, 60000);
  boot();

  root.UI = { render, ui };
})(window);
