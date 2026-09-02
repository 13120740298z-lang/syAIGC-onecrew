// 状态机执行器（图谱 L10 规格）：步骤推进 / 人工确认点 / 全程留痕 / 取消 / 重跑
// v3：上下文真实接力（run.context 跨步累积，修交叉评测 C1）+ 媒体引擎直驱（生图/配音/成片真实产物）
const store = require('./store');
const path = require('path');
const { SKILLS, executeSkill, extractJson } = require('./skills');
const agentDef = require('../agents/onecrew.agent.json');
const media = require('./media');

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

/* ---------- 上下文接力：每步产物累积进 run.context，后续步骤强制消费（修交叉评测 C1） ---------- */
function relayContext(run, skillKey, text) {
  run.context = run.context || {};
  run.context[skillKey] = { name: SKILLS[skillKey].artifact_name, content: String(text).slice(0, 2600) };
  run.last_artifact = { skill: skillKey, name: SKILLS[skillKey].artifact_name };
}

/* 二进制工件登记用：把绝对路径转成 ROOT 相对 POSIX 路径 */
const relPath = (abs) => path.relative(store.ROOT, abs).split(path.sep).join('/');

/* ---------- 媒体引擎步骤：LLM 产脚本 → 引擎产真实文件（MP4 / 图片） ---------- */
async function runMediaStep(run, step, emit, text) {
  const skill = SKILLS[step.skill];
  const mediaDir = path.join(store.DIRS.runs, run.run_id, 'media');
  // 长任务中途取消检查（媒体步骤耗时数分钟，不能只靠步间检查）
  const guard = (detail) => {
    const fresh = store.getRun(run.run_id);
    if (fresh && fresh.status === 'canceled') throw new Error('用户取消');
    if (detail) emit('step', { run_id: run.run_id, step_id: step.step_id, name: step.name, status: 'running', detail });
  };

  if (skill.engine === 'media-video') {
    const j = extractJson(text);
    const parsed = typeof j === 'string' ? JSON.parse(j) : j;
    let scenes = parsed && parsed.scenes;
    // 上游导演分镜兜底：自产解析为空/失败时消费 video-director 工件（接力而非重做）
    if ((!Array.isArray(scenes) || !scenes.length) && run.context && run.context['video-director']) {
      try {
        const dj = extractJson(run.context['video-director'].content);
        const dp = typeof dj === 'string' ? JSON.parse(dj) : dj;
        scenes = dp && dp.scenes;
      } catch (_) { /* 兜底失败走原报错 */ }
    }
    if (!Array.isArray(scenes)) throw new Error('分镜脚本解析失败（无 scenes 数组）');
    // 场景消毒：剔除缺画面指令的分镜；vo/zh 互补回退（防 LLM 漏字段导致空字幕/空配音）
    scenes = scenes
      .filter((s) => s && String(s.imgPrompt || '').trim())
      .slice(0, 5)
      .map((s) => {
        const vo = String(s.vo || '').trim();
        const zh = String(s.zh || '').trim();
        return { ...s, vo: vo || zh, zh: zh || vo, dur: Number(s.dur) || 4 };
      });
    if (!scenes.length) throw new Error('分镜脚本解析失败（无有效场景）');
    const storyboardText = JSON.stringify({ scenes }, null, 2);
    relayContext(run, step.skill, storyboardText);
    persistArtifact(run, emit, step.skill, storyboardText);
    const hook = scenes[0] || {};
    const result = await media.makeVideoAd(scenes, mediaDir, {
      aspects: ['16:9', '9:16'], language: run.params.language || 'en',
      brand: run.params.product, hook, cta: 'Shop now',
    }, guard);
    for (const r of result.renders) {
      const a = store.saveArtifact(run.session_id, run.run_id, `广告成片 ${r.aspect}`, 'video', null, {
        path: relPath(r.file),
        meta: { aspect: r.aspect, duration: r.duration, images: r.images, ttsChars: r.ttsChars },
      });
      run.artifacts.push({ artifact_id: a.artifact_id, name: a.name, type: a.type, path: a.path, meta: a.meta });
      emit('artifact', { run_id: run.run_id, artifact_id: a.artifact_id, name: a.name, type: a.type, meta: a.meta });
    }
    const cover = result.renders.find((r) => r.coverFile);
    if (cover) {
      const a = store.saveArtifact(run.session_id, run.run_id, '视频封面图', 'image', null, {
        path: relPath(cover.coverFile), meta: { source: 'frame-extract' },
      });
      run.artifacts.push({ artifact_id: a.artifact_id, name: a.name, type: a.type, path: a.path });
      emit('artifact', { run_id: run.run_id, artifact_id: a.artifact_id, name: a.name, type: a.type });
    }
    return result.renders.map((r) => `${r.aspect} ${Math.round(r.duration)}s`).join(' + ');
  }

  if (skill.engine === 'media-image') {
    const j = extractJson(text);
    const parsed = typeof j === 'string' ? JSON.parse(j) : j;
    const items = parsed && parsed.items;
    if (!Array.isArray(items) || !items.length) throw new Error('配图脚本解析失败（无 items 数组）');
    relayContext(run, step.skill, JSON.stringify({ items }, null, 2));
    const made = await media.makeImages(items, mediaDir, guard);
    for (const img of made) {
      const a = store.saveArtifact(run.session_id, run.run_id, img.name, 'image', null, {
        path: relPath(img.file), meta: { aspect: img.aspect },
      });
      run.artifacts.push({ artifact_id: a.artifact_id, name: a.name, type: a.type, path: a.path, meta: a.meta });
      emit('artifact', { run_id: run.run_id, artifact_id: a.artifact_id, name: a.name, type: a.type, meta: a.meta });
    }
    return `${made.length} 张真实成图`;
  }
  return null;
}

/* ---------- 单步执行 ---------- */
async function runSkillStep(run, step, emit) {
  const params = { ...run.params };
  if (step.skill === 'visual-prompt') params.scene = params.scene || '都市通勤使用场景';
  if (step.skill === 'local-check') {
    params.market = params.market || run.params.market || '北美';
    params.today = new Date().toISOString().slice(0, 10); // 修：合规清单注入当前日期（交叉评测发现的 2024 日期 bug）
  }
  const started = Date.now();
  step.started_at = started;
  step.status = 'running';
  store.saveRun(run);
  emit('step', { run_id: run.run_id, step_id: step.step_id, name: step.name, status: 'running', detail: '生成中…' });
  const { text, usedMock } = await executeSkill(step.skill, params, (status, detail) => {
    if (status === 'running' && detail) emit('step', { run_id: run.run_id, step_id: step.step_id, name: step.name, status: 'running', detail });
  }, run.context || {});
  relayContext(run, step.skill, text);
  // 媒体技能：由媒体步骤统一登记脚本 JSON 与真实文件（避免同一内容重复登记）
  let mediaInfo = null, artifact = null;
  if (SKILLS[step.skill].engine) mediaInfo = await runMediaStep(run, step, emit, text);
  else artifact = persistArtifact(run, emit, step.skill, text);

  step.status = 'done';
  step.ended_at = Date.now();
  const artName = artifact ? artifact.name : SKILLS[step.skill].artifact_name;
  step.detail = `产出工件「${artName}」${mediaInfo ? ' + ' + mediaInfo : ''}${usedMock ? '（演示模式）' : ''} · ${step.ended_at - started}ms`;
  step.artifacts = run.artifacts.slice(-4).map((a) => a.artifact_id);
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
  return { run_id: run.run_id, agent_id: run.agent_id, session_id: run.session_id, status: run.status, mode: run.mode, current_step: run.current_step, steps: run.steps.map((s) => ({ step_id: s.step_id, name: s.name, type: s.type, status: s.status, detail: s.detail })), artifacts: run.artifacts };
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
