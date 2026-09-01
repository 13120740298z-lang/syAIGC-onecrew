// 状态机执行器（图谱 L10 规格）：步骤推进 / 人工确认点 / 全程留痕 / 取消 / 重跑
// v2：上下文接力（每步工件摘要注入下游 params.context）+ 媒体工件（image/video）落盘 + append-only 事件日志
const store = require('./store');
const { SKILLS, executeSkill } = require('./skills');
const agentDef = require('../agents/onecrew.agent.json');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 事件发射器封装：每个执行通道（SSE 响应）一个 emit 函数 */
function makeEmitter(res) {
  return (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) { /* 客户端断开不阻塞 */ }
  };
}

/* ---------- append-only 事件日志：run.events 只追加不修改（评审可逐步复核） ---------- */
function logEvent(run, emit, type, payload) {
  run.events = run.events || [];
  run.events.push({ at: Date.now(), type, ...payload });
  if (run.events.length > 500) run.events = run.events.slice(-500); // 防爆盘，保留尾部
  emit(type, payload);
}

/* ---------- 工件摘要（上下文接力的燃料）：把工件压成下游 LLM 能用的短摘要 ---------- */
function summarizeArtifact(skillKey, text) {
  const t = String(text || '');
  if (skillKey === 'market-scan') {
    // 抽「平台优先级 / 差异化」两段的核心行
    const lines = t.split('\n').filter((l) => /^\s*[-|]/.test(l) && l.length > 8);
    return lines.slice(0, 10).join('；').slice(0, 900);
  }
  if (skillKey === 'brand-voice') {
    try {
      const j = JSON.parse(t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
      return `品牌定位：${j.positioning || ''}；人设：${j.persona || ''}；语气：${(j.tone || []).join('、')}；常用词：${(j.vocabulary?.use || []).join('、')}；slogan 候选：${(j.slogans || []).join(' / ')}`;
    } catch (_) { return t.slice(0, 600); }
  }
  if (skillKey === 'copy-studio') {
    // 抽 hook（TikTok 脚本第一行）与各平台标题行
    const hook = (t.match(/Hook[^>]*?[：:]\s*["“]?([^"”\n]+)/) || [])[1];
    const first = t.split('\n').filter((l) => l.trim().startsWith('>')).map((l) => l.trim().slice(0, 90));
    return [hook ? `Hook：${hook}` : '', ...first.slice(0, 6)].filter(Boolean).join(' | ').slice(0, 900);
  }
  if (skillKey === 'visual-prompt') {
    const code = t.split('```').filter((_, i) => i % 2 === 1).map((s) => s.split('\n').slice(0, 2).join(' '));
    return `已定稿的图像提示词：${code.join(' ‖ ').slice(0, 800)}`;
  }
  if (skillKey === 'visual-studio') return '上游产品图 ×4 已生成并落盘（主图/场景图/细节图/氛围图）';
  if (skillKey === 'video-director') {
    const m = t.match(/## 旁白全文\s*\n+([^\n]+)/);
    return m ? `成片旁白：${m[1].slice(0, 200)}` : '15 秒成片已合成';
  }
  return t.slice(0, 600);
}

/* 上下文接力映射（docs/07 §3）：下游技能 ← 上游摘要 */
const RELAY = {
  'brand-voice': ['market-scan'],
  'copy-studio': ['brand-voice', 'market-scan'],
  'visual-prompt': ['copy-studio', 'brand-voice'],
  'visual-studio': ['visual-prompt', 'copy-studio'],
  'video-director': ['visual-studio', 'copy-studio'],
  'content-calendar': ['copy-studio', 'market-scan', 'video-director', 'visual-studio'],
  'local-check': ['copy-studio', 'video-director', 'visual-studio', 'content-calendar', 'brand-voice'],
};

function buildRelayContext(run, skillKey) {
  const want = RELAY[skillKey] || [];
  const parts = [];
  for (const w of want) {
    const step = run.steps.find((s) => s.skill === w && s.status === 'done');
    if (!step) continue;
    const art = (run.artifacts || []).find((a) => a.step_skill === w);
    if (!art) continue;
    const sum = summarizeArtifact(w, art.text || '');
    if (sum) parts.push(`【${SKILLS[w]?.name || w}】${sum}`);
  }
  return parts.join('\n');
}

/* ---------- 产物落盘并广播（text 与 image/video 二进制分流） ---------- */
function persistArtifact(run, emit, step, result) {
  const skill = SKILLS[step.skill];
  const saved = [];
  if (result.media) {
    // 媒体型技能：每个文件一个 image/video 工件 + 一份 Markdown 清单
    const { kind, files, coverType } = result.media;
    const isVideo = kind === 'video';
    files.forEach((f, i) => {
      const a = store.saveArtifact(run.session_id, run.run_id, isVideo ? `${skill.artifact_name}` : `${skill.artifact_name}·${i + 1}`, coverType || (isVideo ? 'video' : 'image'), f);
      a.step_skill = step.skill; a.text = '';
      run.artifacts.push({ artifact_id: a.artifact_id, name: a.name, type: a.type, path: a.path, step_skill: step.skill });
      saved.push(a);
      logEvent(run, emit, 'artifact', { run_id: run.run_id, artifact_id: a.artifact_id, name: a.name, type: a.type, step_id: step.step_id, preview: isVideo ? '视频已就绪，点击预览' : '图片已就绪，点击预览' });
    });
    const md = store.saveArtifact(run.session_id, run.run_id, `${skill.artifact_name}·清单`, 'markdown', result.text);
    md.step_skill = step.skill; md.text = result.text;
    run.artifacts.push({ artifact_id: md.artifact_id, name: md.name, type: md.type, path: md.path, step_skill: step.skill });
    saved.push(md);
    logEvent(run, emit, 'artifact', { run_id: run.run_id, artifact_id: md.artifact_id, name: md.name, type: 'markdown', step_id: step.step_id, preview: String(result.text).slice(0, 600) });
    return saved[saved.length - 1];
  }
  const skillType = skill.output_type === 'json' ? 'json' : skill.output_type === 'csv' ? 'csv' : 'markdown';
  const a = store.saveArtifact(run.session_id, run.run_id, skill.artifact_name, skillType, result.text);
  a.step_skill = step.skill; a.text = result.text;
  run.artifacts.push({ artifact_id: a.artifact_id, name: a.name, type: a.type, path: a.path, step_skill: step.skill });
  saved.push(a);
  logEvent(run, emit, 'artifact', { run_id: run.run_id, artifact_id: a.artifact_id, name: a.name, type: a.type, step_id: step.step_id, preview: String(result.text).slice(0, 600) });
  return a;
}

/* ---------- 单步执行 ---------- */
async function runSkillStep(run, step, emit) {
  const params = { ...run.params };
  if (step.skill === 'visual-prompt') params.scene = params.scene || '都市通勤使用场景';
  if (step.skill === 'local-check' && !params.market) params.market = run.params.market || '北美';
  // 上下文接力：上游工件摘要注入 params.context
  const relay = buildRelayContext(run, step.skill);
  if (relay) params.context = relay;
  // video-director：把 visual-studio 落盘的图片路径直接传下去（供 ffmpeg 复用）
  let upstreamImages = [];
  if (step.skill === 'video-director') {
    upstreamImages = (run.artifacts || []).filter((a) => a.step_skill === 'visual-studio' && (a.type === 'image')).map((a) => path.join(store.ROOT, a.path));
  }
  const started = Date.now();
  step.started_at = started;
  step.status = 'running';
  store.saveRun(run);
  logEvent(run, emit, 'step', { run_id: run.run_id, step_id: step.step_id, name: step.name, status: 'running', detail: '生成中…' });
  const result = await executeSkill(step.skill, params, (status, detail) => {
    if (status === 'running' && detail) logEvent(run, emit, 'step', { run_id: run.run_id, step_id: step.step_id, name: step.name, status: 'running', detail });
  }, { upstreamImages });
  const artifact = persistArtifact(run, emit, step, result);
  step.status = 'done';
  step.ended_at = Date.now();
  step.detail = `产出工件「${artifact.name}」${result.usedMock ? '（演示模式）' : ''} · ${step.ended_at - started}ms`;
  step.artifacts = run.artifacts.filter((a) => a.step_skill === step.skill).map((a) => a.artifact_id);
  run.mode = run.mode === 'real' && result.usedMock ? 'mock-fallback' : run.mode;
  store.saveRun(run);
  logEvent(run, emit, 'step', { run_id: run.run_id, step_id: step.step_id, name: step.name, status: 'done', detail: step.detail });
}

/* ---------- 核心执行循环：从 stepIndex 起推进（confirm 挂起返回） ---------- */
const executing = new Set(); // 重入锁：同一 run 不允许并发执行
async function execute(run, emit) {
  if (executing.has(run.run_id)) return { already_running: true };
  executing.add(run.run_id);
  try {
    return await executeInner(run, emit);
  } finally {
    executing.delete(run.run_id);
  }
}
async function executeInner(run, emit) {
  run.status = 'running';
  store.saveRun(run);
  emit('run', runBrief(run));
  for (let i = 0; i < run.steps.length; i++) {
    const step = run.steps[i];
    if (step.status === 'done' || step.status === 'canceled') continue;
    run.current_step = step.step_id;
    store.saveRun(run);

    if (step.type === 'confirm') {
      step.status = 'waiting_confirm';
      step.started_at = Date.now();
      step.detail = step.config.question || '等待人工确认';
      store.saveRun(run);
      logEvent(run, emit, 'step', { run_id: run.run_id, step_id: step.step_id, name: step.name, status: 'waiting_confirm', detail: step.detail, question: step.config.question });
      run.status = 'waiting_confirm';
      store.saveRun(run);
      logEvent(run, emit, 'done', { run_id: run.run_id, status: 'waiting_confirm', message: '流程已挂起：等待人工确认' });
      return { waiting: true };
    }

    try {
      await runSkillStep(run, step, emit);
    } catch (e) {
      step.status = 'failed';
      step.ended_at = Date.now();
      step.detail = String(e.message || e).slice(0, 200);
      run.status = 'failed';
      run.error = `步骤「${step.name}」失败：${step.detail}`;
      store.saveRun(run);
      logEvent(run, emit, 'step', { run_id: run.run_id, step_id: step.step_id, name: step.name, status: 'failed', detail: step.detail });
      logEvent(run, emit, 'error', { run_id: run.run_id, message: run.error });
      return { failed: true };
    }

    // 每步之间检查取消标志
    const fresh = store.getRun(run.run_id);
    if (fresh && fresh.status === 'canceled') {
      logEvent(run, emit, 'done', { run_id: run.run_id, status: 'canceled', message: '已取消' });
      return { canceled: true };
    }
    await sleep(250);
  }

  run.status = 'done';
  run.current_step = null;
  run.result = {
    summary: `完成 ${run.steps.filter((s) => s.status === 'done').length} 个步骤，产出 ${run.artifacts.length} 个工件`,
    artifacts: run.artifacts,
  };
  store.saveRun(run);
  emit('run', runBrief(run));
  logEvent(run, emit, 'done', { run_id: run.run_id, status: 'done', message: run.result.summary });
  return { done: true };
}

function runBrief(run) {
  return { run_id: run.run_id, agent_id: run.agent_id, status: run.status, mode: run.mode, current_step: run.current_step, steps: run.steps.map((s) => ({ step_id: s.step_id, name: s.name, type: s.type, status: s.status, detail: s.detail })), artifacts: run.artifacts.map((a) => ({ artifact_id: a.artifact_id, name: a.name, type: a.type })) };
}

/* ---------- 入口：从 Agent 定义建 run ---------- */
function createAgentRun(agentId, params, sessionId, emit) {
  const def = agentId === agentDef.agent_id ? agentDef : null;
  if (!def) throw new Error('未知 Agent');
  const provider = require('./provider');
  const run = store.createRun(def.agent_id, params, sessionId, provider.mode);
  run.steps = def.steps.map((s) => ({ step_id: s.step_id, name: s.name, type: s.type, skill: s.skill, config: s.config || {}, status: 'pending', detail: '' }));
  run.events = [];
  store.saveRun(run);
  return run;
}

/* 单技能即席 run（技能卡直调） */
function createSkillRun(skillId, params, sessionId, emit) {
  const skill = SKILLS[skillId];
  if (!skill) throw new Error('未知技能');
  const provider = require('./provider');
  const run = store.createRun('adhoc:' + skillId, params, sessionId, provider.mode);
  run.steps = [{ step_id: 'x1', name: skill.name, type: 'skill', skill: skillId, config: {}, status: 'pending', detail: '' }];
  run.events = [];
  store.saveRun(run);
  return run;
}

module.exports = { execute, createAgentRun, createSkillRun, makeEmitter, runBrief, summarizeArtifact, RELAY, logEvent };
