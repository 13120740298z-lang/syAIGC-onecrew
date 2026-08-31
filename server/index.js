// OneCrew 服务端入口：REST + SSE（chat / run / confirm 全事件流）
const express = require('express');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const provider = require('./provider');
const skillsMod = require('./skills');
const runner = require('./runner');
const { routeSmart, extractParams } = require('./router');

const app = express();
app.use(express.json({ limit: '1mb' }));

/* ---------- 健康与元信息 ---------- */
app.get('/api/health', (_, res) => res.json({ ok: true, mode: provider.mode, model: provider.model, agent: 'onecrew v1' }));
app.get('/api/agents', (_, res) => {
  const def = require('../agents/onecrew.agent.json');
  res.json([{ agent_id: def.agent_id, name: def.name, description: def.description, steps: def.steps }]);
});
app.get('/api/skills', (_, res) => res.json(skillsMod.SKILL_LIST.map(({ skill_id, name, icon, description, input_schema }) => ({ skill_id, name, icon, description, input_schema }))));

/* ---------- 会话 ---------- */
app.post('/api/sessions', (req, res) => res.json(store.createSession(req.body && req.body.title)));
app.get('/api/sessions', (_, res) => res.json(store.listSessions()));
app.get('/api/sessions/:id', (req, res) => {
  const s = store.getSession(req.params.id);
  s ? res.json(s) : res.status(404).json({ error: { code: 'NOT_FOUND', message: '会话不存在' } });
});
app.delete('/api/sessions/:id', (req, res) => { store.deleteSession(req.params.id); res.json({ ok: true }); });

/* ---------- 运行记录（留痕复核） ---------- */
app.get('/api/runs', (req, res) => res.json(store.listRuns(req.query.session_id, Number(req.query.limit) || 30)));
app.get('/api/runs/:id', (req, res) => {
  const r = store.getRun(req.params.id);
  r ? res.json(r) : res.status(404).json({ error: { code: 'NOT_FOUND', message: '运行记录不存在' } });
});
app.post('/api/runs/:id/cancel', (req, res) => {
  const r = store.cancelRun(req.params.id);
  r ? res.json({ ok: true, status: r.status }) : res.status(404).json({ error: { code: 'NOT_FOUND', message: '运行不存在' } });
});
app.post('/api/runs/:id/retry', (req, res) => {
  const old = store.getRun(req.params.id);
  if (!old) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '运行不存在' } });
  const run = old.agent_id.startsWith('adhoc:')
    ? runner.createSkillRun(old.agent_id.slice(6), old.params, old.session_id)
    : runner.createAgentRun(old.agent_id, old.params, old.session_id);
  startRunSSE(run, res);
});
app.post('/api/runs/:id/confirm', (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '运行不存在' } });
  const approve = !!(req.body && req.body.approve);
  const emit = runner.makeEmitter(res);
  res.writeHead(200, SSE_HEADERS);
  if (!approve) {
    const wStep = run.steps.find((s) => s.status === 'waiting_confirm');
    store.cancelRun(run.run_id);
    emit('step', { run_id: run.run_id, step_id: wStep && wStep.step_id, status: 'canceled', name: (wStep && wStep.name) || '人工确认', detail: '用户驳回，流程终止' });
    emit('done', { run_id: run.run_id, status: 'canceled', message: '已驳回：流程终止' });
    return res.end();
  }
  if (run.status !== 'waiting_confirm') {
    emit('error', { run_id: run.run_id, message: '该运行不在等待确认状态（当前：' + run.status + '），无法批准' });
    return res.end();
  }
  const step = run.steps.find((s) => s.status === 'waiting_confirm');
  if (step) { step.status = 'done'; step.ended_at = Date.now(); step.detail = '用户已确认，继续执行'; }
  run.status = 'running';
  store.saveRun(run);
  emit('step', { run_id: run.run_id, step_id: step && step.step_id, name: (step && step.name) || '人工确认', status: 'done', detail: '用户已确认，继续执行' });
  runner.execute(run, emit);
});

/* ---------- 工件 ---------- */
app.get('/api/artifacts', (req, res) => {
  let list = require('./store').artifactsIndex ? store.artifactsIndex() : [];
  if (req.query.session_id) list = list.filter((a) => a.session_id === req.query.session_id);
  res.json(list.slice(-100).reverse());
});
app.get('/api/artifacts/:id', (req, res) => {
  const a = store.getArtifact(req.params.id);
  if (!a) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '工件不存在' } });
  try { res.json({ ...a, content: fs.readFileSync(path.join(store.ROOT, a.path), 'utf8') }); }
  catch (_) { res.json({ ...a, content: a.content || '' }); }
});
app.get('/api/artifacts/:id/download', (req, res) => {
  const a = store.getArtifact(req.params.id);
  if (!a || !a.path) return res.status(404).end();
  const f = path.join(store.ROOT, a.path);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.download(f, path.basename(f));
});

/* ---------- SSE 头 ---------- */
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/* 启动 run 并把事件流写进响应（confirm 挂起时正常结束流） */
function startRunSSE(run, res) {
  const emit = runner.makeEmitter(res);
  res.writeHead(200, SSE_HEADERS);
  emit('run', runner.runBrief(run));
  emit('step', { run_id: run.run_id, status: 'running', name: '启动', detail: `参数：${JSON.stringify(run.params).slice(0, 120)}` });
  runner.execute(run, emit).then((r) => { if (r && r.done) res.end(); });
  req_keepalive(res);
}
function req_keepalive(res) {
  const t = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { clearInterval(t); } }, 15000);
  res.on('close', () => clearInterval(t));
}

/* ---------- 技能直调 / Agent 工作流 ---------- */
app.post('/api/agents/:id/run', (req, res) => {
  try {
    const { params, session_id } = req.body || {};
    if (!params || !params.product) return res.status(400).json({ error: { code: 'MISSING_PRODUCT', message: '缺少产品描述' } });
    const run = runner.createAgentRun(req.params.id, params, session_id);
    startRunSSE(run, res);
  } catch (e) { res.status(400).json({ error: { code: 'BAD_REQUEST', message: String(e.message || e) } }); }
});
app.post('/api/skills/:id/run', (req, res) => {
  try {
    const { params, session_id } = req.body || {};
    if (!params || !params.product) return res.status(400).json({ error: { code: 'MISSING_PRODUCT', message: '缺少产品描述' } });
    const run = runner.createSkillRun(req.params.id, params, session_id);
    startRunSSE(run, res);
  } catch (e) { res.status(400).json({ error: { code: 'BAD_REQUEST', message: String(e.message || e) } }); }
});

/* ---------- 对话主入口（豆包式）：路由 → 直调/工作流/自由聊天 ---------- */
app.post('/api/chat', async (req, res) => {
  const { session_id, message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: { code: 'EMPTY', message: '消息不能为空' } });
  const text = String(message).slice(0, 4000);
  let session = session_id ? store.getSession(session_id) : null;
  if (!session) session = store.createSession(text.slice(0, 16));
  session.messages.push({ id: store.rid('m'), role: 'user', content: text, created_at: Date.now() });
  store.saveSession(session);

  const emit = runner.makeEmitter(res);
  res.writeHead(200, SSE_HEADERS);
  req_keepalive(res);

  const intent = await routeSmart(text);
  if (intent.type === 'chat') {
    await freeChat(session, text, emit);
    res.end();
  } else {
    const run = intent.type === 'workflow'
      ? runner.createAgentRun('onecrew', intent.params, session.session_id)
      : runner.createSkillRun(intent.skillId, intent.params, session.session_id);
    const label = intent.type === 'workflow' ? '出海内容包工作流' : `技能「${skillsMod.SKILLS[intent.skillId].name}」`;
    const botMsg = { id: store.rid('m'), role: 'assistant', content: `收到！已启动**${label}**，参数：产品「${intent.params.product}」${intent.params.market ? ' · 市场「' + intent.params.market + '」' : ''}。右侧工作台可查看步骤进度与产物。`, run_id: run.run_id, artifacts: [], created_at: Date.now() };
    session.messages.push(botMsg);
    store.saveSession(session);
    emit('token', { message_id: botMsg.id, delta: botMsg.content });
    emit('run', { ...runner.runBrief(run), message_id: botMsg.id });
    const r = await runner.execute(run, emit);
    if (r && (r.done || r.failed)) res.end();
  }
});

/* 自由聊天：真实模式流式输出 / 演示模式固定引导 */
async function freeChat(session, text, emit) {
  const msgId = store.rid('m');
  emit('start', { message_id: msgId });
  let full = '';
  if (provider.mode === 'real') {
    try {
      const history = session.messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));
      const sys = '你是 OneCrew，一人公司出海内容官智能体。回答简洁、可操作。你可以使用以下技能（用户说"帮我出文案"等即可触发）：' + skillsMod.SKILL_LIST.map((s) => s.name).join('、') + '，以及一键「出海内容包工作流」。';
      full = await streamChat(sys, history, (delta) => emit('token', { message_id: msgId, delta }));
    } catch (e) {
      full = await provider.chatMock('chat', { product: text });
    }
  } else {
    const demo = `（演示模式回复）我已理解你的需求：「${text.slice(0, 60)}」。\n\n我可以直接为你执行：\n1. 🔍 市场快研 2. 🎙️ 品牌声音 3. ✍️ 五平台文案 4. 🎨 提示词工坊 5. 📅 内容日历 6. 🛡️ 合规体检\n或发送「我的产品是XX，想卖XX」一键跑完整出海内容包。\n\n接入真实模型后，这里会是流式生成的个性化回复。`;
    for (const ch of demo) { emit('token', { message_id: msgId, delta: ch }); await new Promise((r) => setTimeout(r, 12)); }
    full = demo;
  }
  const botMsg = { id: msgId, role: 'assistant', content: full, run_id: null, artifacts: [], created_at: Date.now() };
  session.messages.push(botMsg);
  store.saveSession(session);
  emit('done', { message_id: msgId, session_id: session.session_id });
}

/* OpenAI 兼容流式 */
async function streamChat(system, messages, onDelta) {
  const BASE = process.env.LLM_BASE_URL.replace(/\/$/, '');
  const KEY = process.env.LLM_API_KEY;
  const MODEL = process.env.LLM_MODEL || 'deepseek-v4-flash';
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: system }, ...messages], stream: true, max_tokens: 2000, temperature: 0.7 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok || !res.body) throw new Error('stream http ' + res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content || '';
        if (delta) { out += delta; onDelta(delta); }
      } catch (_) { /* 忽略分段不完整 */ }
    }
  }
  if (!out.trim()) throw new Error('stream empty');
  return out;
}

/* ---------- 静态托管前端构建产物 ---------- */
const WEB_DIST = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get(/^(?!\/api).*/, (_, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
}

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`[OneCrew] http://localhost:${PORT} · 模式: ${provider.mode} · 模型: ${provider.mode === 'real' ? provider.model : 'mock(演示)'}`));
