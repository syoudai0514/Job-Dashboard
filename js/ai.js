/*
 * ai.js — AI との接続アダプタ
 *   manual: プロンプトをコピー → 社内で許可された AI（GitHub Copilot Chat 等）に貼る → 回答を貼り戻す
 *   api   : OpenAI 互換の Chat Completions エンドポイントへ直接送る（Azure OpenAI 等）
 * GitHub Pages は静的サイトなので、API キーは各自のブラウザ（localStorage）に保存される。
 * 会社で運用する場合は、キーを持たせない社内プロキシ経由にするのが望ましい。
 */
(function (root) {
  'use strict';

  const AI = {};

  AI.isDirect = (settings) => settings.ai && settings.ai.mode === 'api' && !!settings.ai.endpoint;

  AI.send = async (prompt, settings) => {
    const cfg = settings.ai;
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) {
      if (cfg.authHeader === 'api-key') headers['api-key'] = cfg.apiKey;
      else headers.Authorization = `Bearer ${cfg.apiKey}`;
    }
    const body = {
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      temperature: 0.3,
    };
    if (cfg.model) body.model = cfg.model;
    const res = await fetch(cfg.endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AI 接続エラー ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!content) throw new Error('AI の回答が空でした。エンドポイントの形式（OpenAI 互換か）を確認してください。');
    return content;
  };

  root.AI = AI;
})(typeof window !== 'undefined' ? window : globalThis);
