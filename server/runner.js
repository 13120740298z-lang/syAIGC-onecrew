// 状态机执行器（图谱 L10 规格）：步骤推进 / 人工确认点 / 全程留痕 / 取消 / 重跑
const store = require('./store');
const { SKILLS, executeSkill } = require('./skills');
const agentDef = require('../agents/onecrew.agent.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 事件发射器封装：每个执行通道（SSE 响应）一个 emit 函数 */
function makeEmitter(res) {
  return (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) { /* 客户端断开不阻塞 */ }
  };
}

/* ---------- 产物落盘并广播 ---------- */
function persistArtifact(run, emit, skillKey, text) {
  const skill = SKILLS[skillKey];
  const type = skill.output_type === 'json' ? 'json' : skill.output_type === 'csv' ? 'csv' : 'markdown';
  const a = store.saveArtifact(run.session_id, run.run_id, skill.artifact_name, type, text);
  run.artifacts.push({ artifact_id: a.artifact_id, name: a.name, type: a.type, path: a.path });
  emit('artifact', { run_id: run.run_id, artifact_id: a.artifact_id, name: a.name, type: a.type, preview: String(text).slice(0, 600) });
  return a;
}

/* ---------- 单步执行 ---------- */
async function runSkillStep(run, step, emit) {
  const params = { ...run.params };
  if (step.skill === 'visual-prompt') params.scene = params.scene || '都市通勤使用场景';
  if (step.skill === 'local-check' && !params.market) params.market = run.params.market || '北美';
  const started = Date.now();
  step.started_at = started;
  step.status = 'running';
  store.saveRun(run);
  emit('step', { run_id: run.run_id, step_id: step.step_id, name: step.name, status: 'running', detail: '生成中…' });
  const { text, usedMock } = await executeSkill(step.skill, params, (status, detail) => {
    if (status === 'running' && detail) emit('step', { run_id: run.run_id, step_id: step.step_id, name: step.name, status: 'running', detail });
  });
  const artifact = persistArtifact(run, emit, step.skill, text);
  step.status = 'done';
  step.ended_at = Date.now();
  step.detail = `产出工件「${artifact.name}」${usedMock ? '（演示模式）' : ''} · ${step.ended_at - started}ms`;
  step.artifacts = [artifact.artifact_id];
  run.mode = run.mode === 'real' && usedMock ? 'mock-fallback' : run.mode;
  store.saveRun(run);
  emit('step', { run_id: run.run_id, step_id: step.step_id, name: step.name, status: 'done', detail: step.detail });
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
      emit('step', { run_id: run.run_id, step_id: step.step_id, name: step.name, status: 'waiting_confirm', detail: step.detail, question: step.config.question });
      run.status = 'waiting_confirm';
      store.saveRun(run);
      emit('done', { run_id: run.run_id, status: 'waiting_confirm', message: '流程已挂起：等待人工确认' });
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
      emit('step', { run_id: run.run_id, step_id: step.step_id, name: step.name, status: 'failed', detail: step.detail });
      emit('error', { run_id: run.run_id, message: run.error });
      return { failed: true };
    }

    // 每步之间检查取消标志
    const fresh = store.getRun(run.run_id);
    if (fresh && fresh.status === 'canceled') {
      emit('done', { run_id: run.run_id, status: 'canceled', message: '已取消' });
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
  emit('done', { run_id: run.run_id, status: 'done', message: run.result.summary });
  return { done: true };
}

function runBrief(run) {
  return { run_id: run.run_id, agent_id: run.agent_id, status: run.status, mode: run.mode, current_step: run.current_step, steps: run.steps.map((s) => ({ step_id: s.step_id, name: s.name, type: s.type, status: s.status, detail: s.detail })), artifacts: run.artifacts };
}

/* ---------- 入口：从 Agent 定义建 run ---------- */
function createAgentRun(agentId, params, sessionId, emit) {
  const def = agentId === agentDef.agent_id ? agentDef : null;
  if (!def) throw new Error('未知 Agent');
  const provider = require('./provider');
  const run = store.createRun(def.agent_id, params, sessionId, provider.mode);
  run.steps = def.steps.map((s) => ({ step_id: s.step_id, name: s.name, type: s.type, skill: s.skill, config: s.config || {}, status: 'pending', detail: '' }));
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
  store.saveRun(run);
  return run;
}

module.exports = { execute, createAgentRun, createSkillRun, makeEmitter, runBrief };
