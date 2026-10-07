/*
 * ui.js — 画面の描画とイベント処理
 * 画面はすべて innerHTML で描き直し、操作は data-action 属性によるイベント委譲で受ける。
 *   ビュー: today(今日) / tasks(タスク) / follow(フォロー) / ai(AIと考える) / review(振り返り) / settings(設定)
 */
(function (root) {
  'use strict';
  const { Core, Store, AI, WBS, Team } = root;
  const $ = (sel, el) => (el || document).querySelector(sel);

  const ui = {
    view: 'today',
    today: Core.todayISO(),
    filters: { area: 'all', cat: 'all', status: 'open', q: '' },
    drawerTaskId: null,
    deadline: null, // 今日ビューで開いている期限の山（overdue / today / tomorrow / week / nextWeek）
    wbsCollapsed: new Set(),
    wbsHideDone: false,
    ctx: null, // 描画ごとに計算する { sched, bn, follows }
    inboxSel: {}, // チームWBSの新着で選んだもの { 'sourceId|id': true }
    teamOpen: {}, // チーム全体の状況で開いている取込元
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
        <span class="task-title">${t.wbsId && !o.hideId ? `<span class="wbs-id">${h(t.wbsId)}</span>` : ''}${h(t.title)}</span>
        <span class="task-meta">
          ${t.priority === 1 ? '<span class="chip prio-1">重要</span>' : ''}
          ${o.hideCat ? '' : catChip(t.categoryId)}
          ${dueChip(t)}
          ${o.statusButton ? '' : statusChip(t, false)}
          ${t.recurringId ? '<span class="chip">定例</span>' : ''}
          ${t.interrupt ? '<span class="chip chip-fire">突発</span>' : ''}
          ${t.progress > 0 && t.status !== 'done' ? `<span class="est">${t.progress}%</span>` : ''}
          ${subs.length ? `<span class="est">${subDone}/${subs.length}</span>` : ''}
          ${t.estimate ? `<span class="est">${t.estimate}分</span>` : ''}
          ${(o.reasons || []).filter((r) => /動きなし|着手|後続|先行/.test(r)).map((r) => `<span class="chip reason">${h(r)}</span>`).join('')}
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
      'show-today': '今日期限を見る', 'show-week': '今週期限を見る', 'ai-risk': 'AIと打ち手を考える',
      'show-team': 'チームWBSを見る', 'ai-impact': 'AIと影響を確認',
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
    ['today', '今日'], ['team', 'チームWBS'], ['wbs', '個人WBS'], ['matrix', 'マトリクス'], ['tasks', 'タスク'], ['follow', 'フォロー'],
    ['ai', 'AIと考える'], ['review', '振り返り'], ['settings', '設定'],
  ];
  function renderNav(follows) {
    const open = S().tasks.filter((t) => t.status !== 'done').length;
    const urgent = follows.filter((f) => f.level !== 'info').length;
    $('#nav').innerHTML = VIEWS.map(([id, label]) => {
      let badge = '';
      if (id === 'follow' && follows.length) badge = `<span class="badge${urgent ? '' : ' soft'}">${urgent || follows.length}</span>`;
      if (id === 'tasks') badge = `<span class="badge soft">${open}</span>`;
      if (id === 'team') {
        const n = S().sources.reduce((a, src) => a + Core.sourceInbox(src.rows || [], S().tasks, src, S().settings.myName).length, 0);
        if (n) badge = `<span class="badge" title="新着タスク">${n}</span>`;
      }
      if (id === 'wbs' && WBS) {
        const dot = { connected: 'ok', syncing: 'ok', locked: 'warn', 'needs-permission': 'warn', error: 'crit' }[WBS.status];
        if (dot) badge = `<span class="sync-dot ${dot}" title="Excel 同期: ${h(WBS_LABEL[WBS.status] || '')}"></span>`;
      }
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
      ${deadlineStrip()}
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
          ${bottleneckMini()}
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
    if (a.mode === 'impact') {
      const nIn = S().sources.reduce((x, src) => x + Core.sourceInbox(src.rows || [], S().tasks, src, S().settings.myName).length, 0);
      const nUp = Core.upstreamIssues(S().tasks, S().sources, ui.today, ui.ctx.sched).length;
      inputs = `<p class="note">チームWBS ${S().sources.length}件の、直近7日の変更・新着 <b class="num">${nIn}</b>件・上流の遅延 <b class="num">${nUp}</b>件・取り込み済みタスクを渡します。</p>`
        + textArea('補足（任意）', '例: 来週は研修で2日不在。D-104 の鈴木さんには昨日催促済み');
    }
    if (a.mode === 'risk') inputs = `<p class="note">ボトルネック候補 <b class="num">${ui.ctx.bn.items.length}</b>件と担当別の負荷を渡します。</p>` + textArea('補足（任意）', '例: W-302 は外部ベンダー待ちの可能性あり。来週は研修で2日不在');
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

  /* ---------- 期限の山 / ボトルネック（今日ビューの部品） ---------- */
  function deadlineStrip() {
    const b = Core.deadlineBuckets(S().tasks, ui.today);
    const order = ['overdue', 'today', 'tomorrow', 'week', 'nextWeek'];
    const btns = order.map((k) => `<button class="dl dl-${k}" type="button" data-action="deadline" data-bucket="${k}" aria-pressed="${ui.deadline === k}" ${b[k].length ? '' : 'data-empty="1"'}>
        <span class="dl-label">${Core.DEADLINE_LABELS[k]}${k === 'week' ? `<small>〜${h(Core.formatDate(Core.endOfWeek(ui.today)))}</small>` : ''}</span><span class="dl-n num">${b[k].length}</span></button>`).join('');
    const open = ui.deadline && b[ui.deadline];
    return `<div class="deadlines" role="group" aria-label="期限の山">${btns}</div>
      ${open ? `<section class="panel dl-panel"><div class="section-head"><h2>${Core.DEADLINE_LABELS[ui.deadline]}期限 <span class="num muted">${open.length}</span></h2>
        <button class="btn btn-sm btn-ghost" type="button" data-action="deadline" data-bucket="${ui.deadline}">閉じる</button></div>
        ${open.length ? `<ul class="tasks">${open.map((t) => taskRow(t)).join('')}</ul>` : '<p class="empty">該当するタスクはありません。</p>'}</section>` : ''}`;
  }

  function bottleneckMini() {
    const items = ui.ctx.bn.items.slice(0, 3);
    if (!items.length) return '';
    return `<section class="panel">
      <div class="section-head"><h2>ボトルネック注意</h2><button class="btn btn-sm btn-ghost" type="button" data-action="nav" data-view="matrix">詳しく</button></div>
      <ul class="bn-mini">${items.map((b) => `<li><button type="button" data-action="open" data-id="${b.task.id}"><span class="bn-title">${h(b.task.title)}</span><span class="bn-why">${h(b.reasons[0] || '')}</span></button></li>`).join('')}</ul>
    </section>`;
  }

  /* ---------- WBS ---------- */
  const WBS_LABEL = {
    disconnected: '未接続', 'needs-permission': '再接続が必要', syncing: '同期中', connected: '同期中（自動）',
    locked: '書き込み待ち', error: 'エラー', manual: '手動同期',
  };
  function trendBadge(trend) {
    const tr = Core.TREND[trend];
    return `<span class="trend trend-${trend}" title="${tr.label}"><span aria-hidden="true">${tr.arrow}</span><span class="visually-hidden">${tr.label}</span></span>`;
  }
  function progressBar(pct, expected) {
    return `<span class="pbar"><span class="pbar-fill" style="width:${pct}%"></span>${expected !== null && expected !== undefined ? `<span class="pbar-exp" style="left:${Math.min(100, expected)}%" title="今日時点の予定 ${expected}%"></span>` : ''}</span><span class="pct num">${pct}%</span>`;
  }

  function syncPanel() {
    const meta = S().wbs || {};
    const st = WBS ? WBS.status : 'manual';
    const log = meta.log;
    const fmt = (iso) => { if (!iso) return '—'; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    const pill = { connected: 'ok', syncing: 'ok', locked: 'warn', 'needs-permission': 'warn', error: 'crit' }[st] || 'idle';
    let buttons = '';
    if (st === 'disconnected') buttons = '<button class="btn btn-primary" type="button" data-action="wbs-connect">Excel の WBS に接続</button><button class="btn" type="button" data-action="wbs-create">今のタスクから WBS を作成</button>';
    else if (st === 'needs-permission') buttons = '<button class="btn btn-primary" type="button" data-action="wbs-reconnect">再接続する</button><button class="btn btn-ghost" type="button" data-action="wbs-disconnect">接続を解除</button>';
    else if (st === 'manual') buttons = `<label class="btn btn-primary" for="wbs-file">Excel を読み込む</label><input type="file" id="wbs-file" accept=".xlsx" hidden>
        ${WBS && WBS.manualBuffer ? '<button class="btn" type="button" data-action="wbs-export">Excel に書き出す</button>' : ''}
        <button class="btn btn-ghost" type="button" data-action="wbs-create">今のタスクから WBS を作成</button>`;
    else buttons = '<button class="btn" type="button" data-action="wbs-sync">今すぐ同期</button><button class="btn btn-ghost" type="button" data-action="wbs-disconnect">接続を解除</button>';
    const n = (arr) => (arr ? arr.length : 0);
    const list = (title, arr) => (n(arr) ? `<div><b>${title}（${n(arr)}）</b><ul>${arr.slice(0, 12).map((x) => `<li>${h(x)}</li>`).join('')}${n(arr) > 12 ? `<li>ほか${n(arr) - 12}件</li>` : ''}</ul></div>` : '');
    return `<section class="panel sync-panel">
      <div class="sync-row">
        <div class="sync-info">
          <span class="sync-pill ${pill}">${WBS_LABEL[st]}</span>
          <span class="sync-file">${h((WBS && WBS.fileName) || meta.fileName || 'ファイル未選択')}</span>
          <span class="muted">最終同期 ${fmt(meta.lastSync)}</span>
        </div>
        <div class="row">${buttons}</div>
      </div>
      ${WBS && WBS.message ? `<p class="note ${st === 'error' || st === 'locked' ? 'warn' : ''}">${h(WBS.message)}</p>` : ''}
      ${st === 'disconnected' ? '<p class="muted sync-help">Excel の WBS ファイルを選ぶと、Excel で保存した変更を数秒で取り込み、ダッシュボードでの変更（状態・進捗など）を Excel に書き戻します。Excel で開いている間は書き込めないため、閉じたときにまとめて書き込みます。</p>' : ''}
      ${st === 'manual' && !(WBS && WBS.message) ? '<p class="muted sync-help">このブラウザはファイルへの自動書き込みに対応していません（Edge / Chrome なら自動同期できます）。Excel を読み込んで取り込み、ダッシュボードの変更は「Excel に書き出す」で保存してください。</p>' : ''}
      ${WBS && WBS.missing.length ? `<div class="note warn row between"><span>Excel から消えたタスクが ${WBS.missing.length} 件あります。</span><span class="row">
          <button class="btn btn-sm btn-danger" type="button" data-action="wbs-missing" data-value="delete">ダッシュボードからも削除</button>
          <button class="btn btn-sm" type="button" data-action="wbs-missing" data-value="keep">Excel に戻す</button></span></div>` : ''}
      ${log ? `<details class="sync-log"><summary>前回の同期（${fmt(log.at)}・${h(log.reason || '')}）: 取り込み ${n(log.created) + n(log.toTask)}件 / Excel へ ${n(log.toExcel) + n(log.appended)}件${n(log.conflicts) ? ` / 競合 ${n(log.conflicts)}件` : ''}</summary>
        <div class="sync-log-body">${list('Excel から追加', log.created)}${list('Excel の変更を反映', log.toTask)}${list('Excel に書き込み', log.toExcel)}${list('Excel に行を追加', log.appended)}${list('競合（両方で変更）', log.conflicts)}${list('書き込めなかったセル', log.skipped)}${list('ID の重複', log.duplicates)}${list('Excel に見当たらない', log.missing)}
        ${!n(log.created) && !n(log.toTask) && !n(log.toExcel) && !n(log.appended) ? '<p class="muted">変更はありませんでした。</p>' : ''}</div></details>` : ''}
    </section>`;
  }

  function viewWBS() {
    const st = S();
    const sched = ui.ctx.sched;
    const bnIds = new Set(ui.ctx.bn.items.filter((b) => b.sched.downstream || b.sched.float < 0).map((b) => b.task.id));
    // WBS に載るタスクだけ（定例・「WBS に載せない」は除く）
    const tasks = st.tasks.filter((t) => !t.recurringId && !t.wbsSkip);
    const tree = Core.wbsTree(tasks, st.categories, Core.AREAS);
    // タイムライン: 今日の1週間前から6週間
    const from = Core.addDays(ui.today, -7);
    const days = 49;
    const x = (iso) => Math.max(0, Math.min(100, (Core.diffDays(iso, from) / days) * 100));
    const todayX = x(ui.today);
    const ticks = [];
    for (let i = 0; i <= days; i++) {
      const d = Core.addDays(from, i);
      if (Core.weekday(d) === 1) ticks.push(`<span class="tl-tick" style="left:${x(d)}%">${h(Core.formatDate(d).replace(/\(.\)/, ''))}</span>`);
    }
    const bar = (a, b, cls, prog) => {
      if (!a && !b) return '';
      const s0 = a || b; const e0 = b || a;
      if (Core.diffDays(e0, from) < 0 || Core.diffDays(s0, Core.addDays(from, days)) > 0) return '';
      const left = x(s0); const right = x(Core.addDays(e0, 1));
      return `<span class="tl-bar ${cls}" style="left:${left}%;width:${Math.max(1.2, right - left)}%">${prog ? `<span class="tl-prog" style="width:${prog}%"></span>` : ''}</span>`;
    };
    const timeline = (inner) => `<div class="tl"><span class="tl-today" style="left:${todayX}%"></span>${inner}</div>`;

    const rows = [];
    const visible = (t) => !(ui.wbsHideDone && t.status === 'done');
    const groupRow = (level, node) => {
      const list = node.tasks.filter(visible);
      if (!list.length && ui.wbsHideDone) return false;
      const r = Core.rollup(node.tasks, ui.today, sched);
      const collapsed = ui.wbsCollapsed.has(node.key);
      const bnCount = node.tasks.filter((t) => bnIds.has(t.id)).length;
      rows.push(`<div class="wrow lv${level}">
        <div class="wcell wname"><button class="caret" type="button" data-action="wbs-toggle" data-key="${h(node.key)}" aria-expanded="${!collapsed}">${collapsed ? '▸' : '▾'}</button>
          <span class="wtitle">${h(node.name)}</span>${bnCount ? `<span class="chip chip-bn" title="ボトルネック候補">要注意 ${bnCount}</span>` : ''}${r.overdue ? `<span class="chip due-overdue">超過 ${r.overdue}</span>` : ''}</div>
        <div class="wcell wtrend">${r.total ? trendBadge(r.trend) : ''}</div>
        <div class="wcell wprog">${r.total ? progressBar(r.actual, r.expected) : ''}</div>
        <div class="wcell wcount num">${r.done}/${r.total}</div>
        <div class="wcell wdue">${r.nextDue ? h(Core.formatDate(r.nextDue)) : '—'}</div>
        <div class="wcell wtl">${timeline(bar(r.start, r.end, `grp trend-${r.trend}`, 0))}</div>
      </div>`);
      return !collapsed;
    };
    for (const l1 of tree) {
      if (!groupRow(1, l1)) continue;
      for (const l2 of l1.children) {
        if (!l2.tasks.length) continue;
        if (!groupRow(2, l2)) continue;
        for (const l3 of l2.children) {
          const showGroup = !(l3.name === '（小分類なし）' && l2.children.length === 1);
          if (showGroup && !groupRow(3, l3)) continue;
          for (const t of l3.tasks.filter(visible)) {
            const sc = sched.get(t.id);
            const overdue = t.status !== 'done' && t.due && Core.diffDays(t.due, ui.today) < 0;
            const cls = t.status === 'done' ? 'done' : overdue || (sc && sc.float < 0) ? 'late' : sc && sc.float <= 1 ? 'tight' : 'ok';
            const startD = t.start || (sc && sc.latestStart && t.due && sc.latestStart < t.due ? sc.latestStart : null);
            rows.push(`<div class="wrow lv4 ${t.status === 'done' ? 'is-done' : ''}">
              <div class="wcell wname"><span class="wbs-id">${h(t.wbsId || '—')}</span>
                <button class="wtask" type="button" data-action="open" data-id="${t.id}">${h(t.title)}</button>
                ${bnIds.has(t.id) ? '<span class="chip chip-bn">ボトルネック</span>' : ''}${sc && sc.blockedBy.length ? '<span class="chip reason">先行待ち</span>' : ''}${t.interrupt ? '<span class="chip chip-fire">突発</span>' : ''}${t.owner ? `<span class="chip">${h(t.owner)}</span>` : ''}</div>
              <div class="wcell wtrend">${statusChip(t, true)}</div>
              <div class="wcell wprog">${progressBar(t.status === 'done' ? 100 : t.progress || 0, null)}</div>
              <div class="wcell wcount num">${t.estimate ? `${Math.round((t.estimate / 60) * 10) / 10}h` : ''}</div>
              <div class="wcell wdue">${t.due ? `<span class="chip due-${t.status === 'done' ? 'later' : Core.dueInfo(t.due, ui.today).state}">${h(Core.formatDate(t.due))}</span>` : '—'}</div>
              <div class="wcell wtl">${timeline(bar(startD, t.due, cls, t.status === 'done' ? 0 : t.progress))}</div>
            </div>`);
          }
        }
      }
    }
    return `
      <div class="view-head"><div><h1>WBS</h1><p>大分類 → 中分類 → 小分類 → タスクの階層で、進捗と状況を矢印で表示します。</p></div></div>
      ${syncPanel()}
      <div class="wbs-tools">
        <div class="legend">${['up', 'flat', 'down', 'done'].map((k) => `<span>${trendBadge(k)} ${Core.TREND[k].label}</span>`).join('')}
          <span class="legend-note">矢印は「今日時点の予定進捗（縦線）」との差・期限超過・間に合わない見込みから判定</span></div>
        <div class="row">
          <label class="quick-pin"><input type="checkbox" id="wbs-hide-done" ${ui.wbsHideDone ? 'checked' : ''}> 完了を隠す</label>
          <button class="btn btn-sm btn-ghost" type="button" data-action="wbs-expand" data-value="all">すべて開く</button>
          <button class="btn btn-sm btn-ghost" type="button" data-action="wbs-expand" data-value="l2">中分類まで</button>
        </div>
      </div>
      <div class="wbs-wrap">
        <div class="wbs-table">
          <div class="wrow whead">
            <div class="wcell wname">分類・タスク</div><div class="wcell wtrend">状況</div><div class="wcell wprog">進捗</div>
            <div class="wcell wcount">完了/件・工数</div><div class="wcell wdue">直近の期限</div>
            <div class="wcell wtl"><div class="tl tl-head"><span class="tl-today" style="left:${todayX}%"></span>${ticks.join('')}</div></div>
          </div>
          ${rows.join('') || '<p class="empty" style="padding:16px">タスクがありません。</p>'}
        </div>
      </div>`;
  }

  /* ---------- チームWBS ---------- */
  const SRC_LABEL = { connected: '自動で読み取り中', syncing: '読み取り中', locked: '書き戻し待ち', 'needs-permission': '再接続が必要', error: 'エラー', offline: '未接続' };
  function viewTeam() {
    const st = S();
    const me = st.settings.myName;
    const fmt = (iso) => { if (!iso) return '—'; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    const issues = Core.upstreamIssues(st.tasks, st.sources, ui.today, ui.ctx.sched);
    const cards = st.sources.map((src) => {
      const s0 = Team ? Team.status(src.id) : { status: 'offline', message: '' };
      const pill = { connected: 'ok', syncing: 'ok', locked: 'warn', 'needs-permission': 'warn', error: 'crit' }[s0.status] || 'idle';
      const rows = src.rows || [];
      const mine = rows.filter((r) => Core.isMine(r, src, me));
      const linked = st.tasks.filter((t) => t.src && t.src.sourceId === src.id).length;
      const late = Core.teamOverview(rows, ui.today, st.settings).late.length;
      const pr = Team ? Team.problems(src.id) : { removed: [], reassigned: [] };
      const nProb = pr.removed.length + pr.reassigned.length;
      const connected = Team && Team.isConnected(src.id);
      return `<section class="panel src-card">
        <div class="row between"><h3>${h(src.name)}</h3><span class="sync-pill ${pill}">${SRC_LABEL[s0.status] || '未接続'}</span></div>
        <div class="src-meta"><span>${h(src.fileName || '')}</span><span>最終読み取り ${fmt(src.lastRead)}</span></div>
        <div class="src-stats">
          <div><span class="label">全体</span><b class="num">${rows.length}</b></div>
          <div><span class="label">自分の担当</span><b class="num">${mine.length}</b></div>
          <div><span class="label">取り込み済み</span><b class="num">${linked}</b></div>
          <div class="${late ? 'alert' : ''}"><span class="label">遅延</span><b class="num">${late}</b></div>
        </div>
        <div class="src-settings">
          <label class="field"><span>表示名</span><input class="input" id="src-name-${src.id}" data-src="${src.id}" data-src-field="name" value="${h(src.name)}"></label>
          <label class="field"><span>あなたの権限</span><select class="select" id="src-mode-${src.id}" data-src="${src.id}" data-src-field="mode">
            <option value="read" ${src.mode !== 'write' ? 'selected' : ''}>読み取りのみ（個人WBSだけ更新）</option>
            <option value="write" ${src.mode === 'write' ? 'selected' : ''}>書き戻しあり（進捗・追加を共通WBSへ）</option></select></label>
          <label class="field"><span>取り込む範囲</span><select class="select" id="src-scope-${src.id}" data-src="${src.id}" data-src-field="scope">
            <option value="mine" ${src.scope !== 'all' ? 'selected' : ''}>自分が担当のタスク</option>
            <option value="all" ${src.scope === 'all' ? 'selected' : ''}>すべてのタスク</option></select></label>
          <label class="quick-pin"><input type="checkbox" id="src-unassigned-${src.id}" data-src="${src.id}" data-src-field="includeUnassigned" ${src.includeUnassigned ? 'checked' : ''}> 担当が空欄のタスクも候補にする</label>
        </div>
        ${s0.message ? `<p class="note ${['error', 'locked', 'needs-permission'].includes(s0.status) ? 'warn' : ''}">${h(s0.message)}</p>` : ''}
        ${nProb ? `<div class="note warn"><div>チームWBSから消えた・担当が外れたタスクが ${nProb} 件あります。</div><div class="row" style="margin-top:6px">
          <button class="btn btn-sm" type="button" data-action="team-problems" data-src="${src.id}" data-value="unlink">個人タスクとして残す</button>
          <button class="btn btn-sm btn-danger" type="button" data-action="team-problems" data-src="${src.id}" data-value="delete">ダッシュボードから削除</button></div></div>` : ''}
        <div class="row">
          ${connected ? `<button class="btn btn-sm" type="button" data-action="team-sync" data-src="${src.id}">今すぐ読む</button>`
            : Team && Team.canAutoSync ? `<button class="btn btn-sm btn-primary" type="button" data-action="team-reconnect" data-src="${src.id}">ファイルに接続</button>`
              : `<label class="btn btn-sm btn-primary" for="team-file-${src.id}">ファイルを読み込む</label><input type="file" id="team-file-${src.id}" data-team-file="${src.id}" accept=".xlsx" hidden>`}
          <button class="btn btn-sm btn-ghost btn-danger" type="button" data-action="team-remove" data-src="${src.id}">登録を解除</button>
        </div>
      </section>`;
    }).join('');

    const inboxBlocks = st.sources.map((src) => {
      const inbox = Core.sourceInbox(src.rows || [], st.tasks, src, me);
      if (!inbox.length) return '';
      return `<div class="inbox-src"><h3>${h(src.name)} <span class="num muted">${inbox.length}</span></h3>
        <ul class="inbox">${inbox.map((r) => {
          const key = `${src.id}|${r.wbsId}`;
          return `<li><label><input type="checkbox" data-action="inbox-sel" data-key="${h(key)}" ${ui.inboxSel[key] !== false ? 'checked' : ''}>
            <span class="inbox-body"><span class="mcard-title">${r.wbsId.startsWith('#') ? '' : `<span class="wbs-id">${h(r.wbsId)}</span>`}${h(r.title)}</span>
            <span class="task-meta"><span class="chip">${h([r.l1, r.l2, r.l3].filter(Boolean).join(' / '))}</span>
              ${r.due ? `<span class="chip due-${Core.dueInfo(r.due, ui.today).state}">${h(Core.formatDate(r.due))}</span>` : ''}
              ${r.owner ? `<span class="chip">${h(r.owner)}</span>` : '<span class="chip area-none">担当未定</span>'}
              ${r.priority === '1' ? '<span class="chip prio-1">重要</span>' : ''}
              ${r.estimateH ? `<span class="est">${h(r.estimateH)}h</span>` : ''}${r.deps ? `<span class="est">先行 ${h(r.deps)}</span>` : ''}</span></span></label></li>`;
        }).join('')}</ul>
        <div class="row"><button class="btn btn-primary btn-sm" type="button" data-action="inbox-take" data-src="${src.id}">選んだタスクを取り込む</button>
          <button class="btn btn-sm btn-ghost" type="button" data-action="inbox-dismiss" data-src="${src.id}">選んだタスクを無視</button></div></div>`;
    }).join('');

    const feed = st.feed.slice(0, 25);
    const unread = st.feed.filter((f) => !f.read).length;
    const srcName = (id) => (Store.source(id) || {}).name || '';
    const overview = st.sources.map((src) => {
      const o = Core.teamOverview(src.rows || [], ui.today, st.settings);
      if (!o.total) return '';
      const open = ui.teamOpen[src.id];
      return `<section class="panel">
        <div class="section-head"><h2>${h(src.name)}</h2><span class="muted">完了 ${o.done}/${o.total}</span></div>
        <div class="team-tree">${o.tree.map((g) => `<div class="tt-row lv1"><span>${trendBadge(g.rollup.trend)}</span><span class="tt-name">${h(g.name)}</span><span class="tt-prog">${progressBar(g.rollup.actual, g.rollup.expected)}</span><span class="tt-late">${g.rollup.overdue ? `<span class="chip due-overdue">超過 ${g.rollup.overdue}</span>` : ''}</span></div>
          ${g.children.map((c) => `<div class="tt-row lv2"><span>${trendBadge(c.rollup.trend)}</span><span class="tt-name">${h(c.name)}</span><span class="tt-prog">${progressBar(c.rollup.actual, c.rollup.expected)}</span><span class="tt-late">${c.rollup.overdue ? `<span class="chip due-overdue">超過 ${c.rollup.overdue}</span>` : ''}</span></div>`).join('')}`).join('')}</div>
        ${o.late.length ? `<h3 style="margin-top:14px">遅れているタスク <span class="num muted">${o.late.length}</span></h3>
          <div class="table-wrap"><table class="table late-table"><thead><tr><th>ID</th><th>タスク</th><th>担当</th><th>期限</th><th>状況</th></tr></thead><tbody>
          ${o.late.slice(0, open ? 50 : 6).map((l) => `<tr><td class="wbs-id">${h(l.task.wbsId)}</td><td>${h(l.task.title)}</td><td>${h(l.task.owner || '未定')}</td>
            <td>${l.task.due ? h(Core.formatDate(l.task.due)) : '—'}</td><td>${l.overdue ? `<span class="chip due-overdue">${Core.diffDays(ui.today, l.task.due)}日超過</span>` : `<span class="chip due-soon">${-l.float}日遅れ見込み</span>`} <span class="est">${l.task.progress}%</span></td></tr>`).join('')}
          </tbody></table></div>${o.late.length > 6 ? `<button class="btn btn-sm btn-ghost" type="button" data-action="team-open" data-src="${src.id}">${open ? '閉じる' : `すべて表示（${o.late.length}）`}</button>` : ''}` : '<p class="empty">遅れているタスクはありません。</p>'}
        <h3 style="margin-top:14px">担当別</h3>
        <div class="owner-grid">${o.owners.map((w) => `<div class="owner ${w.late ? 'has-late' : ''}"><b>${h(w.owner)}</b><span class="num">未完了 ${w.open}</span>${w.late ? `<span class="num late">遅延 ${w.late}</span>` : ''}</div>`).join('')}</div>
      </section>`;
    }).join('');

    return `
      <div class="view-head"><div><h1>チームWBS</h1><p>上位者が管理する共通WBSを常に読み取り、自分のタスクを個人WBSに取り込みます。期限などの変更は自動で反映し、遅延と新着をお知らせします。</p></div>
        <button class="btn" type="button" data-action="goto-ai" data-mode="impact">AIと影響を確認</button></div>
      ${!me ? `<div class="note warn" style="margin-bottom:16px">「自分の担当」を判定するために、設定の「自分の名前（担当欄）」にチームWBSの担当欄と同じ名前を入れてください。</div>` : ''}
      <div class="src-grid">${cards}
        <section class="panel src-add">
          <h3>チームWBSを追加</h3>
          <p class="muted">チームやプロジェクトの共通WBS（Excel）を登録します。複数登録できます。登録しても共通WBSは変更しません（書き戻しありにした場合を除く）。</p>
          ${Team && Team.canAutoSync ? '<button class="btn btn-primary" type="button" data-action="team-add">ファイルを選んで追加</button>'
            : '<label class="btn btn-primary" for="team-file-new">ファイルを読み込んで追加</label><input type="file" id="team-file-new" data-team-file="" accept=".xlsx" hidden><p class="muted" style="font-size:.8rem">このブラウザでは自動で読み直せません（Edge / Chrome なら自動）。</p>'}
        </section>
      </div>

      <div class="grid-2" style="margin-top:20px">
        <div class="stack">
          <section class="panel">
            <div class="section-head"><h2>新着タスク</h2><span class="muted">取り込むと個人WBSにも追加されます</span></div>
            ${inboxBlocks || '<p class="empty">新しく割り当てられたタスクはありません。</p>'}
          </section>
          ${overview}
        </div>
        <div class="stack">
          <section class="panel">
            <div class="section-head"><h2>上流の遅延・注意 <span class="num muted">${issues.length}</span></h2></div>
            ${issues.length ? `<ul class="bn-mini">${issues.map((u) => `<li><button type="button" data-action="open" data-id="${u.task.id}"><span class="bn-title">${h(u.task.title)}</span><span class="bn-why ${u.level === 'critical' ? 'crit' : ''}">${h(u.text)}</span></button></li>`).join('')}</ul>`
              : '<p class="empty">取り込んだタスクの先行に遅れはありません。</p>'}
          </section>
          <section class="panel">
            <div class="section-head"><h2>変更の通知 ${unread ? `<span class="badge-inline">${unread}</span>` : ''}</h2>${unread ? '<button class="btn btn-sm btn-ghost" type="button" data-action="feed-read">すべて既読</button>' : ''}</div>
            ${feed.length ? `<ul class="feed">${feed.map((f) => `<li class="${f.read ? '' : 'unread'} fk-${f.kind}"><time>${h(fmt(f.at))}</time><span><span class="feed-src">${h(srcName(f.sourceId))}</span>${f.taskId && Store.task(f.taskId) ? `<button class="link" type="button" data-action="open" data-id="${f.taskId}">${h(f.text)}</button>` : h(f.text)}</span></li>`).join('')}</ul>`
              : '<p class="empty">まだ通知はありません。</p>'}
          </section>
        </div>
      </div>`;
  }

  /* ---------- 優先度マトリクス ---------- */
  function matrixCard(item) {
    const t = item.task;
    const sc = item.sched;
    const pips = [1, 2, 3].map((i) => `<i class="${i <= (t.difficulty || 2) ? 'on' : ''}"></i>`).join('');
    return `<li class="mcard${item.early ? ' early' : ''}">
      <button class="mcard-body" type="button" data-action="open" data-id="${t.id}">
        <span class="mcard-title">${t.wbsId ? `<span class="wbs-id">${h(t.wbsId)}</span>` : ''}${h(t.title)}</span>
        <span class="task-meta">
          ${item.early ? '<span class="chip chip-early">早めに着手</span>' : ''}
          ${item.reasons.map((r) => `<span class="chip ${/超過|遅れ/.test(r) ? 'due-overdue' : /突発/.test(r) ? 'chip-fire' : 'due-soon'}">${h(r)}</span>`).join('')}
          ${t.due && !item.reasons.some((r) => /期限|超過/.test(r)) ? `<span class="chip">${h(Core.formatDate(t.due))}</span>` : ''}
          <span class="pips" title="難易度 ${Core.DIFFICULTY[t.difficulty || 2]}">難${pips}</span>
          ${sc && Number.isFinite(sc.float) && sc.float >= 0 ? `<span class="est">余裕${sc.float}日</span>` : ''}
          ${sc && sc.downstream ? `<span class="est">後続${sc.downstream}</span>` : ''}
        </span>
      </button>
      <button class="pin-btn" type="button" data-action="toggle-pin" data-id="${t.id}" aria-pressed="${t.todayPin === ui.today}">今日</button>
    </li>`;
  }

  function viewMatrix() {
    const st = S();
    const axis = st.settings.matrixAxis || 'both';
    const m = Core.matrix(st.tasks, ui.today, st.settings, axis, ui.ctx.sched);
    const quad = (k) => {
      const q = Core.QUADRANTS[k];
      return `<section class="quad quad-${k}">
        <header><span class="quad-name">${q.name}</span><span class="quad-tag">${q.tag}</span><b class="quad-action">${q.action}</b><span class="num muted">${m[k].length}</span></header>
        <p class="quad-desc">${q.desc}</p>
        ${m[k].length ? `<ul class="mlist">${m[k].map(matrixCard).join('')}</ul>` : '<p class="empty">なし</p>'}
      </section>`;
    };
    const bn = ui.ctx.bn;
    const maxScore = Math.max(1, ...bn.items.map((b) => b.score));
    return `
      <div class="view-head"><div><h1>優先度マトリクス</h1><p>縦軸が緊急度、横軸が重要度・難易度です。緊急度は期限ではなく、残りの所要日数から逆算した「着手期限」で判定します。</p></div>
        <div class="row"><span class="label">横軸</span><div class="seg" role="group" aria-label="横軸">
          <button type="button" data-action="matrix-axis" data-value="both" aria-pressed="${axis === 'both'}">重要度＋難易度</button>
          <button type="button" data-action="matrix-axis" data-value="importance" aria-pressed="${axis === 'importance'}">重要度のみ</button></div></div></div>
      <div class="matrix">
        <div class="axis-y"><span>緊急</span></div>${quad('q3')}${quad('q1')}
        <div class="axis-y"><span>緊急でない</span></div>${quad('q4')}${quad('q2')}
        <div></div><div class="axis-x">← 重要度・難易度 低</div><div class="axis-x right">重要度・難易度 高 →</div>
      </div>

      <div class="grid-2" style="margin-top:24px">
        <section class="panel">
          <div class="section-head"><h2>ボトルネック候補 <span class="num muted">${bn.items.length}</span></h2>
            <button class="btn btn-sm" type="button" data-action="goto-ai" data-mode="risk">AIと打ち手を考える</button></div>
          ${bn.items.length ? `<ol class="bn-list">${bn.items.slice(0, 10).map((b) => `<li>
              <div class="bn-head"><button class="wtask" type="button" data-action="open" data-id="${b.task.id}">${b.task.wbsId ? `<span class="wbs-id">${h(b.task.wbsId)}</span>` : ''}${h(b.task.title)}</button>
                <span class="bn-score"><span style="width:${(b.score / maxScore) * 100}%"></span></span></div>
              <ul class="bn-reasons">${b.reasons.map((r) => `<li>${h(r)}</li>`).join('')}</ul></li>`).join('')}</ol>`
            : '<p class="empty">目立ったボトルネックはありません。</p>'}
        </section>
        <div class="stack">
          <section class="panel">
            <div class="section-head"><h2>担当別の負荷</h2><span class="muted">直近5稼働日・容量 ${bn.capacity}h</span></div>
            ${bn.load.length ? `<div class="bars">${bn.load.map((l) => `<div class="bar-row"><span class="name">${h(l.owner)}</span>
              <span class="bar-track"><span class="bar-fill ${l.pct > 100 ? 'over' : 'area-work'}" style="width:${Math.min(100, l.pct)}%;display:block"></span></span><span class="n">${l.pct}%</span></div>`).join('')}</div>`
              : '<p class="empty">直近5日に予定された作業はありません。</p>'}
            <p class="muted" style="font-size:.78rem;margin-top:8px">担当が空欄のタスクは「${h(st.settings.myName || '自分')}」として数えます。</p>
          </section>
          <details class="panel method">
            <summary><h2 style="display:inline">この表の考え方</h2></summary>
            <div class="method-body">
              <p><b>時間管理のマトリクス（アイゼンハワー・マトリクス）</b> — 『7つの習慣』で知られる、緊急度と重要度で仕事を4つの領域に分ける方法です。成果につながるのは第2領域（緊急ではないが重要）に先手で時間を使うことで、そうすると第1領域の火消しが減ります。</p>
              <p><b>緊急度は「着手期限」で見る</b> — 着手期限 = 期限 − 残りの所要日数。所要日数 = 見積 ×（1 − 進捗）× 難易度係数（低1.0 / 中1.2 / 高1.5）÷ 1日にそのタスクへ割ける時間（${st.settings.focusHours || 3}時間）。先行・後続がある場合は、後続の着手期限から逆算します（クリティカルパス法）。余裕が${st.settings.urgentFloat ?? 1}日以下になると緊急側に移ります。</p>
              <p><b>早めに着手</b> — 第2領域のうち、難易度が高い・所要3日以上で余裕が${st.settings.earlyStartFloat ?? 10}日以内のもの。「一番重いカエルを朝一番に食べる（Eat the frog）」の考え方で、最初の一歩だけでも今週中に。</p>
              <p><b>ボトルネック</b> — 制約理論（TOC）では、全体の速さは一番細いところで決まると考えます。後続を止めているタスク、余裕がマイナスのタスク、担当が過負荷のタスクを上に出しています。</p>
            </div>
          </details>
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
            <label class="field"><span>1タスクに1日で割ける時間（h）</span><input class="input num" type="number" min="1" max="8" id="set-focus" data-setting="focusHours" value="${s.focusHours}"></label>
            <label class="field"><span>緊急とみなす余裕日数</span><input class="input num" type="number" min="0" id="set-urgent" data-setting="urgentFloat" value="${s.urgentFloat}"></label>
            <label class="field"><span>早期着手を勧める余裕日数</span><input class="input num" type="number" min="1" id="set-early" data-setting="earlyStartFloat" value="${s.earlyStartFloat}"></label>
            <label class="field"><span>自分の名前（担当欄）</span><input class="input" id="set-myname" data-setting-text="myName" value="${h(s.myName)}" placeholder="空欄なら「自分」"></label>
          </div>
          <p class="muted" style="font-size:.8rem">容量は会議を除いた、実際に手を動かせる時間の目安です。所要日数 = 見積 ×（1 − 進捗）× 難易度係数 ÷「1タスクに1日で割ける時間」で計算し、期限から逆算して着手期限を出します。</p>
        </section>

        <section class="panel stack" style="gap:12px"><h2>WBS（Excel）同期</h2>
          <div class="settings-grid">
            <label class="quick-pin"><input type="checkbox" id="set-wbs-append" data-wbs-setting="appendNew" ${s.wbs.appendNew ? 'checked' : ''}> ダッシュボードで追加したタスクも WBS に行を追加する</label>
            <label class="field"><span>Excel の変更を確認する間隔（秒）</span><input class="input num" type="number" min="2" id="set-wbs-poll" data-wbs-setting="pollSec" value="${s.wbs.pollSec}"></label>
          </div>
          <p class="muted" style="font-size:.8rem">定例作業と、詳細で「WBS に載せない」にしたタスクは同期しません。接続・解除は WBS 画面で行います。</p>
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
  function teamInfo(t) {
    const st = S();
    if (t.recurringId) return '';
    if (t.src) {
      const src = Store.source(t.src.sourceId);
      const rec = src && (src.rows || []).find((r) => String(r.wbsId) === String(t.src.id));
      const diffDue = rec && rec.due && t.due && rec.due !== t.due;
      return `<div class="team-box"><div><b>取込元</b> ${h(src ? src.name : '（削除された取込元）')} <span class="wbs-id">${h(t.src.id)}</span>
          <span class="chip ${src && src.mode === 'write' ? 'st-doing' : ''}">${src && src.mode === 'write' ? '書き戻しあり' : '読み取りのみ'}</span></div>
        ${rec ? `<div class="muted">チームWBS: 担当 ${h(rec.owner || '未定')}・期限 ${rec.due ? h(Core.formatDate(rec.due)) : '未定'}・${h(Core.STATUS[rec.status] || '')} ${h(rec.progress || 0)}%</div>` : ''}
        ${diffDue ? `<div class="${t.due > rec.due ? 'neg' : ''}">個人の期限 ${h(Core.formatDate(t.due))}（チームWBSは ${h(Core.formatDate(rec.due))}）</div>` : ''}
        <div class="muted">期限・タスク名などはチームWBSで変わると自動で更新されます。${src && src.mode === 'write' ? '状態・進捗・完了日はチームWBSにも書き戻します。' : '状態・進捗は個人WBSだけに記録されます。'}</div>
        <div class="row"><button class="btn btn-sm btn-ghost" type="button" data-action="team-unlink" data-id="${t.id}">紐づけを外す</button></div></div>`;
    }
    if (!st.sources.length) return '';
    const writable = st.sources.filter((x) => x.mode === 'write' && Team && Team.isConnected(x.id));
    const opts = st.sources.map((x) => `<option value="${x.id}">${h(x.name)}${x.mode === 'write' ? '' : '（読み取りのみ）'}</option>`).join('');
    return `<div class="team-box"><div><b>共通WBSに載せる</b> <span class="muted">このタスクは個人だけのタスクです。</span></div>
      <div class="row"><label class="visually-hidden" for="d-src">取込元</label><select class="select" id="d-src" style="width:auto">${opts}</select>
        ${writable.length ? `<button class="btn btn-sm" type="button" data-action="team-promote" data-id="${t.id}">共通WBSに追加</button>` : ''}
        <button class="btn btn-sm btn-ghost" type="button" data-action="team-request" data-id="${t.id}">追加依頼文を作る</button></div>
      <div class="muted">書き戻し権限がある取込元には直接追加できます。権限がない場合は依頼文をリーダーに送ってください。</div></div>`;
  }

  function scheduleInfo(t) {
    if (t.status === 'done') return '';
    const sc = Core.schedule(S().tasks, ui.today, S().settings).get(t.id);
    if (!sc) return '';
    const items = [`所要 <b class="num">${sc.duration}</b>日`];
    if (sc.latestStart) items.push(`着手期限 <b>${h(Core.formatDate(sc.latestStart))}</b>`);
    if (Number.isFinite(sc.float)) items.push(`余裕 <b class="num ${sc.float < 0 ? 'neg' : ''}">${sc.float}</b>日`);
    if (sc.downstream) items.push(`後続 <b class="num">${sc.downstream}</b>件`);
    const blocked = sc.blockedBy.length ? `<div>先行が未完了: ${sc.blockedBy.map((p) => `<button class="link" type="button" data-action="open" data-id="${p.id}">${h(p.wbsId || '')} ${h(p.title)}</button>`).join('、')}</div>` : '';
    const succ = sc.succs.filter((c) => c.status !== 'done');
    const next = succ.length ? `<div>このタスクを待っている: ${succ.map((c) => `<button class="link" type="button" data-action="open" data-id="${c.id}">${h(c.wbsId || '')} ${h(c.title)}</button>`).join('、')}</div>` : '';
    return `<div class="sched-box ${sc.float < 0 ? 'late' : sc.float <= 2 ? 'tight' : ''}"><div class="row">${items.join('<span class="muted">・</span>')}</div>${blocked}${next}</div>`;
  }

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
    const segBtns = (field, map) => (Array.isArray(map) ? map : Object.entries(map)).map(([k, v]) => `<button type="button" data-action="set-field" data-field="${field}" data-value="${k}" aria-pressed="${String(t[field]) === k}">${v}</button>`).join('');
    const catOptions = Object.entries(Core.AREAS).map(([area, label]) => `<optgroup label="${label}">${cats().filter((c) => c.area === area).map((c) => `<option value="${c.id}" ${t.categoryId === c.id ? 'selected' : ''}>${h(c.name)}</option>`).join('')}</optgroup>`).join('');
    const fri = nextFriday();
    el.innerHTML = `
      <div class="drawer-head"><span class="label">${t.wbsId ? `<span class="wbs-id">${h(t.wbsId)}</span>` : ''}${t.recurringId ? '定例タスク' : t.wbsSkip ? 'WBS 対象外' : 'WBS のタスク'}</span><button class="btn btn-ghost" type="button" data-action="close">閉じる</button></div>
      <label class="visually-hidden" for="d-title">タスク名</label>
      <textarea class="textarea title-input" id="d-title" rows="2" data-field="title">${h(t.title)}</textarea>
      <div class="drawer-grid">
        <label class="field"><span>区分</span><select class="select" id="d-cat" data-field="categoryId"><option value="">未分類</option>${catOptions}</select></label>
        <div class="field"><span>今日の計画</span><button class="pin-btn" style="padding:8px 12px;font-size:.85rem" type="button" data-action="toggle-pin" data-id="${t.id}" aria-pressed="${pinned}">${pinned ? '今日やる（解除）' : '今日やるに入れる'}</button></div>
        <div class="field wide"><span>状態</span><div class="seg" role="group">${segBtns('status', Core.STATUS)}</div></div>
        <label class="field wide"><span>小分類</span><input class="input" id="d-l3" data-field="l3" value="${h(t.l3)}" list="d-l3-list" placeholder="例: ガイドライン整備">
          <datalist id="d-l3-list">${[...new Set(S().tasks.filter((x) => x.categoryId === t.categoryId && x.l3).map((x) => x.l3))].map((v) => `<option value="${h(v)}">`).join('')}</datalist></label>
        <div class="field"><span>重要度</span><div class="seg" role="group">${segBtns('priority', Core.PRIORITY)}</div></div>
        <div class="field"><span>難易度</span><div class="seg" role="group">${segBtns('difficulty', [['3', '高'], ['2', '中'], ['1', '低']])}</div></div>
        <label class="field"><span>見積（分）</span><input class="input num" id="d-est" type="number" min="5" step="5" data-field="estimate" value="${t.estimate || ''}"></label>
        <label class="field"><span>進捗 <b class="num" id="d-prog-val">${t.status === 'done' ? 100 : t.progress || 0}%</b></span><input type="range" id="d-prog" min="0" max="100" step="10" data-field="progress" value="${t.status === 'done' ? 100 : t.progress || 0}"></label>
        <label class="field"><span>開始予定</span><input class="input num" id="d-start" type="date" data-field="start" value="${t.start || ''}"></label>
        <label class="field"><span>担当</span><input class="input" id="d-owner" data-field="owner" value="${h(t.owner)}" placeholder="空欄なら自分"></label>
        <div class="field wide"><span>期限</span><div class="row">
          <input class="input num" id="d-due" type="date" data-field="due" value="${t.due || ''}" style="width:auto">
          <button class="btn btn-sm" type="button" data-action="set-due" data-value="${ui.today}">今日</button>
          <button class="btn btn-sm" type="button" data-action="set-due" data-value="${Core.addDays(ui.today, 1)}">明日</button>
          <button class="btn btn-sm" type="button" data-action="set-due" data-value="${fri}">金曜</button>
          <button class="btn btn-sm" type="button" data-action="set-due" data-value="${Core.addDays(ui.today, 7)}">1週間後</button>
          ${t.due ? '<button class="btn btn-sm btn-ghost" type="button" data-action="set-due" data-value="">なし</button>' : ''}</div></div>
        <label class="field wide"><span>待ち相手・関係者</span><input class="input" id="d-wait" data-field="waitingFor" value="${h(t.waitingFor)}" placeholder="例: 佐藤"></label>
        <label class="field wide"><span>先行タスク（先に終わっている必要があるタスクの ID）</span><input class="input" id="d-deps" data-field="deps" value="${h((t.deps || []).join(', '))}" placeholder="例: W-101, W-102" list="d-deps-list">
          <datalist id="d-deps-list">${S().tasks.filter((x) => x.wbsId && x.id !== t.id && x.status !== 'done').map((x) => `<option value="${h(x.wbsId)}">${h(x.title)}</option>`).join('')}</datalist></label>
        <div class="wide row">
          <label class="quick-pin"><input type="checkbox" id="d-interrupt" data-field="interrupt" ${t.interrupt ? 'checked' : ''}> 突発作業</label>
          ${t.recurringId ? '' : `<label class="quick-pin"><input type="checkbox" id="d-skip" data-field="wbsSkip" ${t.wbsSkip ? 'checked' : ''}> WBS に載せない</label>`}
        </div>
      </div>
      ${scheduleInfo(t)}
      ${teamInfo(t)}
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
    const follows = Core.followUps(st.tasks, ui.today, st.settings, st.categories, { sources: st.sources, feed: st.feed });
    const sched = Core.schedule(st.tasks, ui.today, st.settings);
    ui.ctx = { follows, sched, bn: Core.bottlenecks(st.tasks, ui.today, st.settings, sched) };
    renderNav(follows);
    renderBanner();
    const view = $('#view');
    const scroll = window.scrollY;
    const html = {
      today: () => viewToday(follows), tasks: viewTasks, follow: () => viewFollow(follows),
      ai: viewAI, review: viewReview, settings: viewSettings, wbs: viewWBS, matrix: viewMatrix, team: viewTeam,
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
    return { today: ui.today, tasks: st.tasks, categories: st.categories, settings: st.settings, journal: st.journal, sources: st.sources, feed: st.feed, text: ui.ai.text, task: ui.ai.taskId ? Store.task(ui.ai.taskId) : null };
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
      if (p.kind === 'report') ui.pendingReport = p.payload.text;
      if (p.kind === 'journal') {
        const cur = (S().journal[p.payload.date] || {}).reflection || '';
        Store.setJournal(p.payload.date, 'reflection', cur ? `${cur}\n\n${p.payload.text}` : p.payload.text);
      }
    });
    toast(`${n}件の変更を反映しました`);
    ui.ai.proposals = null; ui.ai.prompt = null; ui.ai.response = ''; ui.ai.prose = '';
    if (a.mode === 'plan') setView('today'); else render();
    if (ui.pendingReport) { showText('報告・相談文', ui.pendingReport); ui.pendingReport = null; }
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
    if (kind === 'ai-risk') gotoAI('risk');
    if (kind === 'ai-impact') gotoAI('impact');
    if (kind === 'show-team') setView('team');
    if (kind === 'show-today' || kind === 'show-week') { ui.deadline = kind === 'show-today' ? 'today' : 'week'; setView('today'); }
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
      p.difficulty !== 2 ? `<span class="chip">難易度 ${Core.DIFFICULTY[p.difficulty]}</span>` : '',
      p.interrupt ? '<span class="chip chip-fire">突発</span>' : '',
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
      difficulty: p.difficulty, interrupt: p.interrupt, wbsSkip: !S().settings.wbs.appendNew,
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
      case 'deadline': ui.deadline = ui.deadline === btn.dataset.bucket ? null : btn.dataset.bucket; render(); break;
      case 'matrix-axis': Store.updateSettings({ matrixAxis: btn.dataset.value }); break;
      case 'wbs-connect': WBS.connect(); break;
      case 'team-add': Team.add(); break;
      case 'team-sync': Team.syncNow(btn.dataset.src); break;
      case 'team-reconnect': Team.reconnect(btn.dataset.src); break;
      case 'team-remove': {
        if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'もう一度押すと解除'; break; }
        Team.remove(btn.dataset.src); toast('登録を解除しました（取り込んだタスクは個人タスクとして残ります）');
        break;
      }
      case 'team-problems': Team.resolveProblems(btn.dataset.src, btn.dataset.value); break;
      case 'team-open': ui.teamOpen[btn.dataset.src] = !ui.teamOpen[btn.dataset.src]; render(); break;
      case 'inbox-sel': ui.inboxSel[btn.dataset.key] = btn.checked; break;
      case 'inbox-take': case 'inbox-dismiss': {
        const src = Store.source(btn.dataset.src);
        const ids = Core.sourceInbox(src.rows || [], S().tasks, src, S().settings.myName).map((r) => r.wbsId).filter((x) => ui.inboxSel[`${src.id}|${x}`] !== false);
        if (!ids.length) { toast('タスクを選んでください'); break; }
        if (action === 'inbox-take') { const n = Team.takeIn(src.id, ids); toast(`${n}件を取り込みました。個人WBSにも追加されます`); }
        else { Team.dismiss(src.id, ids); toast(`${ids.length}件を無視しました`); }
        break;
      }
      case 'feed-read': Store.markFeedRead(); break;
      case 'team-unlink': Team.unlink(btn.dataset.id); renderDrawer(); break;
      case 'team-promote': {
        const srcId = $('#d-src').value;
        Team.promote(btn.dataset.id, srcId).then((id) => { if (id) { toast(`共通WBSに ${id} として追加しました`); renderDrawer(); } else toast('追加できませんでした。チームWBS画面の状態を確認してください'); });
        break;
      }
      case 'team-request': {
        const t = Store.task(btn.dataset.id);
        const src = Store.source($('#d-src').value);
        showText('共通WBSへの追加依頼', Core.addRequestText(t, src, cats(), Core.AREAS, S().settings.myName));
        break;
      }
      case 'wbs-reconnect': WBS.reconnect(); break;
      case 'wbs-sync': WBS.syncNow(); break;
      case 'wbs-disconnect': WBS.disconnect(); break;
      case 'wbs-create': WBS.createNew(); break;
      case 'wbs-export': WBS.exportFile(); break;
      case 'wbs-missing': WBS.resolveMissing(btn.dataset.value); break;
      case 'wbs-toggle': {
        const k = btn.dataset.key;
        if (ui.wbsCollapsed.has(k)) ui.wbsCollapsed.delete(k); else ui.wbsCollapsed.add(k);
        render();
        break;
      }
      case 'wbs-expand': {
        ui.wbsCollapsed = new Set();
        if (btn.dataset.value === 'l2') {
          Core.wbsTree(S().tasks, cats(), Core.AREAS).forEach((l1) => l1.children.forEach((l2) => ui.wbsCollapsed.add(l2.key)));
        }
        render();
        break;
      }
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
        const val = field === 'priority' || field === 'difficulty' ? Number(value) : value;
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
      const f = el.dataset.field;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (f === 'estimate') v = v ? Number(v) : null;
      if (f === 'progress') v = Number(v) || 0;
      if (['due', 'start', 'categoryId'].includes(f)) v = v || null;
      if (f === 'title') v = v.trim() || Store.task(tid).title;
      if (f === 'deps') v = v.split(/[,、，\s]+/).map((x) => x.trim()).filter(Boolean);
      if (['l3', 'owner', 'waitingFor'].includes(f)) v = v.trim();
      Store.updateTask(tid, { [f]: v }, f === 'progress' ? `進捗を${v}%に更新` : null);
      if (['progress', 'deps', 'start', 'interrupt', 'wbsSkip', 'due', 'estimate'].includes(f)) renderDrawer();
      return;
    }
    if (el.id === 'wbs-hide-done') { ui.wbsHideDone = el.checked; render(); return; }
    if (el.id === 'wbs-file' && el.files[0]) { WBS.importFile(el.files[0]); return; }
    if (el.dataset.teamFile !== undefined && el.files[0]) { Team.addFile(el.files[0], el.dataset.teamFile || null); return; }
    if (el.dataset.src && el.dataset.srcField) {
      const f = el.dataset.srcField;
      const v = el.type === 'checkbox' ? el.checked : el.value.trim();
      if (f === 'mode') Team.setMode(el.dataset.src, v);
      else Store.updateSource(el.dataset.src, { [f]: v });
      return;
    }
    if (el.dataset.settingText !== undefined) { Store.updateSettings({ [el.dataset.settingText]: el.value.trim() }); return; }
    if (el.dataset.wbsSetting) {
      const k = el.dataset.wbsSetting;
      Store.updateSettings({ wbs: { ...S().settings.wbs, [k]: el.type === 'checkbox' ? el.checked : Math.max(2, Number(el.value) || 5) } });
      return;
    }
    if (el.dataset.journal) { Store.setJournal(ui.today, el.dataset.journal, el.value); return; }
    if (el.dataset.filter) { ui.filters[el.dataset.filter] = el.value; render(); return; }
    if (el.dataset.ai) { ui.ai[el.dataset.ai] = el.value; return; }
    if (el.dataset.setting) { Store.updateSettings({ [el.dataset.setting]: Math.max(0, Number(el.value) || 0) }); return; }
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
    if (el.id === 'd-prog') { const out = $('#d-prog-val'); if (out) out.textContent = `${el.value}%`; }
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
  // 同期など画面の外から来た変更は、入力中なら入力が終わるまで描画を待つ
  function softRender() {
    const a = document.activeElement;
    if (a && a !== document.body && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && (a.closest('#view') || a.closest('#drawer'))) { ui.renderPending = true; return; }
    render();
    if (ui.drawerTaskId) renderDrawer();
  }
  document.addEventListener('focusout', () => {
    if (ui.renderPending) setTimeout(() => { if (ui.renderPending) { ui.renderPending = false; softRender(); } }, 50);
  });
  Store.onChange((st, meta) => ((meta && /^(wbs|team)/.test(meta.source || '')) ? softRender() : render()));
  if (WBS) { WBS.onChange(softRender); WBS.boot(); }
  if (Team) {
    Team.onChange(softRender);
    Team.boot();
  }
  // 日付が変わったら（翌朝タブを開いたままでも）定例生成と再計算
  setInterval(() => { if (Core.todayISO() !== ui.today) boot(); }, 60000);
  boot();

  root.UI = { render, ui, toast };
})(window);
