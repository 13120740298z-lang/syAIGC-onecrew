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
app.get('/api/health', (_, res) => {
  const fs2 = require('fs');
  let ffmpeg = false;
  try { fs2.accessSync('C:/Users/18201/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe'); ffmpeg = true; } catch (_) {}
  res.json({ ok: true, mode: provider.mode, model: provider.model, agent: 'onecrew v3 video-studio', ffmpeg });
});
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
/* ---------- 成本仪表盘：从 data/runs 真实记账（路演"低成本"故事的实测数据） ----------
 * 口径：LLM 文本步 ≈0.03 元/步（api.b.ai 实测）· 生图/TTS/ffmpeg 本地引擎 0 元 · 二进制工件按类型实测 */
const COST = { llmPerStep: 0.03, imageRealPerImg: 0, ttsEdge: 0, videoRender: 0 };
app.get('/api/stats', (_, res) => {
  const runs = fs.readdirSync(store.DIRS.runs).filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(store.DIRS.runs, f), 'utf8')); } catch (_) { return null; } })
    .filter(Boolean);
  const byRun = runs.filter((r) => r.status === 'done').map((r) => {
    const steps = (r.steps || []).filter((s) => s.status === 'done' && s.type !== 'confirm');
    const wallMs = steps.reduce((s, x) => s + ((x.ended_at && x.started_at) ? x.ended_at - x.started_at : 0), 0);
    const arts = r.artifacts || [];
    const realImages = arts.filter((a) => a.type === 'image').length;
    const hasVideo = arts.some((a) => a.type === 'video');
    const cost = steps.length * COST.llmPerStep; // 媒体引擎全免费（pollinations/edge-tts/ffmpeg 零 Key）
    return {
      run_id: r.run_id, agent_id: r.agent_id, mode: r.mode, created_at: r.created_at,
      product: r.params && r.params.product, market: r.params && r.params.market,
      steps: steps.length, wall_ms: wallMs, artifacts: arts.length,
      media: { real_images: realImages > 0, video: hasVideo, image_count: realImages },
      cost_cny: +cost.toFixed(3),
    };
  }).sort((a, b) => b.created_at - a.created_at);
  const totals = byRun.reduce((a, r) => ({ ms: a.ms + r.wall_ms, cost: a.cost + r.cost_cny, art: a.art + r.artifacts, steps: a.steps + r.steps, real: a.real || r.media.real_images, video: a.video || r.media.video }), { ms: 0, cost: 0, art: 0, steps: 0, real: false, video: false });
  res.json({
    runs: byRun,
    totals: { done_runs: byRun.length, steps: totals.steps, wall_ms: totals.ms, artifacts: totals.art, cost_cny: +totals.cost.toFixed(2), media_real: totals.real, media_video: totals.video },
    unit_economics: {
      per_pipeline_cny: (8 * COST.llmPerStep).toFixed(2),
      note: '生图/配音/成片走免费引擎（Pollinations + edge-tts + ffmpeg，零 Key），LLM 文本步 ≈0.03 元/步 → 单次全流程 3~4 毛人民币级；对照：UGC 外包 $45-212/条、代运营 ¥5k-30k/月',
    },
  });
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
  // 确认点可编辑：approve 时可携带修订后的 params（如换市场/改产品名），后续步骤按修订值执行
  const revision = (req.body && req.body.params) || null;
  if (revision && typeof revision === 'object') {
    run.params = { ...run.params, ...revision };
    run.events = run.events || [];
    run.events.push({ at: Date.now(), type: 'confirm_revision', detail: '用户在确认点修订参数', params: revision });
    if (run.events.length > 500) run.events = run.events.slice(-500);
    emit('step', { run_id: run.run_id, status: 'running', name: '参数修订', detail: '确认点已更新：' + JSON.stringify(revision).slice(0, 120) });
  }
  run.status = 'running';
  store.saveRun(run);
  emit('step', { run_id: run.run_id, step_id: step && step.step_id, name: (step && step.name) || '人工确认', status: 'done', detail: '用户已确认，继续执行' });
  req_keepalive(res);
  runner.execute(run, emit).then((r) => { if (r && (r.done || r.failed || r.canceled)) res.end(); });
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
  if (a.type === 'video' || a.type === 'image') {
    // 二进制工件：返回元数据与播放/下载地址，不读文件内容
    return res.json({ ...a, content: '', url: `/api/artifacts/${a.artifact_id}/stream`, download: `/api/artifacts/${a.artifact_id}/download` });
  }
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
// 媒体流播放（video 元素需要 Range 支持）
app.get('/api/artifacts/:id/stream', (req, res) => {
  const a = store.getArtifact(req.params.id);
  if (!a || !a.path) return res.status(404).end();
  const f = path.join(store.ROOT, a.path);
  if (!fs.existsSync(f)) return res.status(404).end();
  const stat = fs.statSync(f);
  const mime = a.type === 'video' ? 'video/mp4' : (f.endsWith('.png') ? 'image/png' : 'image/jpeg');
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (start >= stat.size) { res.status(416).set('Content-Range', `bytes */${stat.size}`).end(); return; }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mime,
    });
    fs.createReadStream(f, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Content-Type': mime });
    fs.createReadStream(f).pipe(res);
  }
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

/* 确认点参数抽取：前端确认框的修订文本 → 结构化 params（与对话入口同一套正则） */
app.post('/api/params/extract', (req, res) => {
  const message = String((req.body && req.body.message) || '').slice(0, 2000);
  res.json({ params: extractParams(message) });
});

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
    const demo = `（演示模式回复）我已理解你的需求：「${text.slice(0, 60)}」。\n\n我可以直接为你执行（10 技能 + 真·视频成片引擎）：\n1. 🔍 市场快研 2. 🎙️ 品牌声音 3. ✍️ 五平台文案 4. 🎨 提示词工坊 5. 🖼️ AI 直出配图 6. 📢 英文旁白 7. 🎬 分镜导演 8. 🎥 真·广告成片（MP4）9. 📅 内容日历 10. 🛡️ 合规体检\n或发送「我的产品是XX，想卖XX，帮我出全套出海内容」一键跑完整工作流（含真实 MP4 成片）。`;
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
