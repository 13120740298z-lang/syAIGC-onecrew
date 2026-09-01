// 技能加载器：Wave2 沉淀的 skills/*.json 是唯一事实源，引擎运行时真实加载（非摆设）
// v2：output_type 分流 —— text/json 走 LLM；images 走真实文生图（无 Key 本地降级）；video 走 LLM 分镜 + TTS + ffmpeg 合成
const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');

function loadSkills() {
  const map = {};
  for (const f of fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.json'))) {
    const skill = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8'));
    map[skill.skill_id] = skill;
  }
  return map;
}
const SKILLS = loadSkills();

/* ---------- 提示词组装：系统提示 + 技能提示模板 + 用户参数 ---------- */
function buildMessages(skill, params) {
  const sys = [
    '你是 OneCrew —— 服务一人公司（OPC）出海的 AIGC 内容官智能体。',
    '你的用户通常是一个人身兼产品、市场、文案数职，预算极少、时间极紧。',
    '输出要求：结构化 Markdown 或 JSON（按技能规定），直接可用、可直接复制发布或导入工具，',
    '不要输出任何与任务无关的寒暄。所有海外平台内容默认英文（用户指定其他语言除外）。',
    '涉及数据时注明为桌面调研估算，不得编造精确统计。',
  ].join('\n');
  let prompt = (skill.prompt_template || '')
    .replace(/\{\{(\w+)\}\}/g, (_, k) => params[k] || `（未提供${k}）`);
  const kv = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `# 任务：${skill.name}\n\n## 输入参数\n${kv || '- （用户直接发起，请围绕其产品描述执行）'}\n\n## 技能指令\n${prompt}\n\n## 输出格式\n${skill.output_format || '结构化 Markdown'}` },
  ];
}

/* ---------- H8 思想的安全闸：本地敏感词拦截（演示级） ---------- */
const BLOCK = ['杀人', '毒品', '枪支买卖', '假证', '代孕'];
function safetyCheck(text) {
  for (const w of BLOCK) if (text.includes(w)) return { ok: false, word: w };
  return { ok: true };
}

/* ---------- 工件落盘目录：图片/视频等二进制产物统一放 exports/ ---------- */
const media = require('./media');
const ffmpegLayer = require('./ffmpeg');
const EXPORTS_DIR = path.join(__dirname, '..', 'exports');

/* ---------- images 型技能：LLM 产出文生图提示词数组 → 真实生成 / 本地降级 ---------- */
async function runImagesSkill(skill, params, onStep, llm) {
  // 1) LLM 规划 4 张图的提示词（真实失败时用 mock 的同构 JSON 兜底）
  const plan = await llm(); // string：JSON 数组 [{slot, prompt, ratio}]
  let prompts;
  try {
    const j = extractJson(plan);
    const arr = typeof j === 'string' ? JSON.parse(j) : j;
    prompts = (Array.isArray(arr) ? arr : []).filter((x) => x && x.prompt);
  } catch (_) { prompts = []; }
  if (!prompts.length) throw new Error('文生图提示词规划为空');
  const product = params.product || '产品';
  onStep && onStep('running', `已规划 ${prompts.length} 张图（${prompts.map((x) => x.slot).join('/')}），开始生成…`);

  // 2) 真实生图；无 Key / 失败 → 本地构图小样（明示演示模式，全流程不中断）
  const outDir = path.join(EXPORTS_DIR, 'media_' + Date.now().toString(36));
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  let realGen = false;
  try {
    const got = await media.generateImages(prompts, outDir, (msg) => onStep && onStep('running', msg));
    files.push(...got);
    realGen = true;
  } catch (e) {
    if (String(e.message).includes('LOCAL_FALLBACK')) {
      onStep && onStep('running', '未配置生图 Key —— 本地合成「构图小样」演示（接入 ARK_API_KEY/SILICONFLOW_API_KEY 即为真图）');
      for (let i = 0; i < prompts.length; i++) {
        const dest = path.join(outDir, `img${i + 1}_${(prompts[i].slot || i + 1)}.png`.replace(/\s+/g, '_'));
        onStep && onStep('running', `本地合成第 ${i + 1}/${prompts.length} 张（${prompts[i].slot}）`);
        await ffmpegLayer.makePlaceholderImage(`${prompts[i].slot}｜${product}`, params.scene || '', dest);
        files.push(dest);
      }
    } else {
      onStep && onStep('running', `生图 API 失败（${String(e.message).slice(0, 60)}），降级本地构图小样`);
      for (let i = 0; i < prompts.length; i++) {
        const dest = path.join(outDir, `img${i + 1}_${(prompts[i].slot || i + 1)}.png`.replace(/\s+/g, '_'));
        await ffmpegLayer.makePlaceholderImage(`${prompts[i].slot}｜${product}`, params.scene || '', dest);
        files.push(dest);
      }
    }
  }

  // 3) 生成参数清单（Markdown，含每张图的提示词与落盘路径，可复核）
  const lines = [
    `# ${skill.artifact_name || skill.name}（${realGen ? 'AI 真实生成' : '本地构图小样 · 演示模式'}）`, '',
    `**产品**：${product}`, '',
  ];
  prompts.forEach((p, i) => {
    lines.push(`## ${i + 1}. ${p.slot || '图' + (i + 1)}（${p.ratio || '1:1'}）`);
    if (files[i]) lines.push(`- 文件：\`${path.relative(path.join(__dirname, '..'), files[i]).replace(/\\/g, '/')}\``);
    lines.push(`- 提示词：\`${String(p.prompt).replace(/`/g, "'")}\``, '');
  });
  if (!realGen) lines.push('> ⚠️ 当前为演示模式（未配置生图 Key 或 API 失败）：图为本地程序化合成的构图小样，布局/文案与真实成图同构。');
  const md = lines.join('\n');

  // 4) 把首图缩略拷到 exports 顶层作为 run 的封面工件
  const coverType = realGen ? 'image' : 'image';
  return {
    text: md,
    media: { kind: 'images', files, realGen, coverType },
    usedMock: false,
  };
}

/* ---------- video 型技能：LLM 分镜脚本 → TTS 旁白 → ffmpeg 合成 MP4 ---------- */
async function runVideoSkill(skill, params, onStep, llm, upstreamImages) {
  const product = params.product || '产品';
  const language = params.language || 'en';
  onStep && onStep('running', '生成分镜旁白脚本…');
  const plan = await llm(); // JSON {title, narration, subtitles, scenes}
  let board;
  try {
    const j = extractJson(plan);
    board = typeof j === 'string' ? JSON.parse(j) : j;
  } catch (_) { board = null; }
  if (!board || !board.narration) throw new Error('分镜脚本缺少旁白文本');

  const tmpDir = path.join(EXPORTS_DIR, 'media_' + Date.now().toString(36));
  fs.mkdirSync(tmpDir, { recursive: true });

  // 1) 取上游图片（visual-studio 的产物）；没有则本地合成 4 张分镜图
  let images = (upstreamImages || []).filter((f) => f && fs.existsSync(f));
  if (!images.length) {
    onStep && onStep('running', '上游无图片 —— 用分镜描述本地合成占位图');
    const slots = (board.scenes || []).map((s) => s.desc) || ['开场', '场景', '细节', '氛围'];
    images = [];
    for (let i = 0; i < Math.max(2, Math.min(4, slots.length || 4)); i++) {
      const dest = path.join(tmpDir, `scene${i + 1}.png`);
      await ffmpegLayer.makePlaceholderImage(String(slots[i] || product).slice(0, 24), product, dest);
      images.push(dest);
    }
  } else {
    onStep && onStep('running', `复用上游产品图 ×${images.length}`);
  }

  // 2) TTS 旁白（免费 Edge → 失败静音继续）；语言映射到对应神经声音（ja/ko/en/zh）
  let narrationFile = null, narrationDur = null, ttsModeUsed = null;
  try {
    onStep && onStep('running', `TTS 旁白合成（${media.ttsMode()}）…`);
    const nf = path.join(tmpDir, 'narration.mp3');
    const r = await media.synthesizeSpeech(board.narration, nf, language);
    narrationFile = r.file;
    narrationDur = media.probeDuration(nf) || r.duration || null;
    ttsModeUsed = media.ttsMode();
  } catch (e) {
    onStep && onStep('running', `TTS 失败（${String(e.message).slice(0, 50)}）—— 输出静音成片`);
  }

  // 3) 字幕时间轴：LLM 给了就用；否则按时长均分
  let subtitles = Array.isArray(board.subtitles) ? board.subtitles.filter((s) => s && s.text) : [];
  if (!subtitles.length) {
    const total = narrationDur || 12;
    const parts = String(board.narration).split(/[。！？.!?]/).map((s) => s.trim()).filter(Boolean);
    const per = total / Math.max(1, parts.length);
    subtitles = parts.map((t, i) => ({ text: t.slice(0, 16), start: +(i * per).toFixed(2), end: +((i + 1) * per).toFixed(2) }));
  }

  // 4) ffmpeg 合成 1080x1920 MP4（内置 BGM 资产 + 旁白 ducking；BGM 缺失自动跳过）
  const outFile = path.join(tmpDir, 'video.mp4');
  const bgmAsset = path.join(__dirname, '..', 'assets', 'bgm_calm_loop.m4a');
  onStep && onStep('running', `ffmpeg 合成 ${images.length} 镜 · ${subtitles.length} 条字幕…`);
  await ffmpegLayer.synthesizeVideo({
    images,
    narration: narrationFile,
    subtitles,
    bgm: fs.existsSync(bgmAsset) ? bgmAsset : null,
    out: outFile,
    durationSec: narrationDur ? Math.max(narrationDur + 0.8, images.length * 3) : null,
    onProgress: (pct, note) => onStep && onStep('running', note ? `${note}` : `合成 ${Math.round(pct)}%`),
  });

  // 5) 分镜脚本 Markdown（可复核工件）
  const LANG_LABEL = { en: 'EN 英语', zh: '中文', ja: '日语', ko: '韩语' };
  const lines = [
    `# ${skill.artifact_name || skill.name} · 分镜脚本`, '',
    `**标题**：${board.title || product} · **旁白语言**：${LANG_LABEL[language] || language} · **配音**：${ttsModeUsed || '静音'}`, '',
    `## 旁白全文`, '', `${board.narration}`, '', `## 分镜`,
  ];
  (board.scenes || []).forEach((s, i) => lines.push(`${i + 1}. 第${(s.image ?? i) + 1}图 —— ${s.desc || ''}`));
  lines.push('', '## 字幕时间轴', '', '| 时间 | 字幕 |', '|---|---|');
  subtitles.forEach((s) => lines.push(`| ${s.start}s – ${s.end}s | ${s.text} |`));
  const md = lines.join('\n');

  return {
    text: md,
    media: { kind: 'video', files: [outFile], realGen: !!narrationFile, coverType: 'video', images, narration: narrationFile, subtitles },
    usedMock: false,
  };
}

/* ---------- 技能执行：按 output_type 分流，真实优先，失败降级 ---------- */
const provider = require('./provider');
async function executeSkill(skillKey, params, onStep, ctx = {}) {
  const skill = SKILLS[skillKey];
  if (!skill) throw new Error('未知技能: ' + skillKey);
  onStep && onStep('running', `调用技能「${skill.name}」`);

  // 媒体型技能：LLM 只负责「规划」（JSON），产物由媒体层生成
  if (skill.output_type === 'images' || skill.output_type === 'video') {
    const llm = async () => {
      const tries = [];
      if (provider.mode === 'real') tries.push(() => provider.chatReal(buildMessages(skill, params), { maxTokens: 4000 }));
      // 真实规划偶发输出对话文字/截断（推理模型已知行为）→ 重试一次；再失败用 mock 同构 JSON 兜底
      tries.push(() => provider.chatReal(buildMessages(skill, params), { maxTokens: 4000, temperature: 0.3 }));
      for (let i = 0; i < tries.length; i++) {
        try {
          const out = await tries[i]();
          const j = extractJson(out);
          const parsed = typeof j === 'string' ? JSON.parse(j) : j;
          const ok = skill.output_type === 'images' ? Array.isArray(parsed) && parsed.some((x) => x && x.prompt) : parsed && parsed.narration;
          if (ok) return typeof j === 'string' ? j : JSON.stringify(parsed);
          onStep && onStep('running', `规划输出不合规（第 ${i + 1} 次），重试…`);
        } catch (e) {
          if (provider.mode !== 'real') break;
          onStep && onStep('running', `真实模型规划失败（${String(e.message).slice(0, 60)}），重试…`);
        }
      }
      onStep && onStep('running', '规划降级为演示模式（确定性脚本）');
      return await provider.chatMock(skillKey, params);
    };
    const r = skill.output_type === 'images'
      ? await runImagesSkill(skill, params, onStep, llm)
      : await runVideoSkill(skill, params, onStep, llm, ctx.upstreamImages);
    const gate = safetyCheck(r.text);
    if (!gate.ok) throw new Error('内容触发安全闸：' + gate.word);
    return r;
  }

  // 文本型技能：LLM 直出
  let text, usedMock = false;
  if (provider.mode === 'real') {
    try {
      text = await provider.chatReal(buildMessages(skill, params), { maxTokens: 8000 });
    } catch (e) {
      onStep && onStep('running', `真实模型失败（${String(e.message).slice(0, 80)}），降级演示模式`);
      text = await provider.chatMock(skillKey, params);
      usedMock = true;
    }
  } else {
    text = await provider.chatMock(skillKey, params);
    usedMock = true;
  }
  const gate = safetyCheck(text);
  if (!gate.ok) throw new Error('内容触发安全闸：' + gate.word);
  // JSON 型技能：提取并清洗为合法 JSON（模型偶尔带说明文字/截断时兜底）
  if (skill.output_type === 'json') {
    const j = extractJson(text);
    if (j) text = typeof j === 'string' ? j : JSON.stringify(j, null, 2);
  }
  return { text, usedMock };
}

function extractJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { JSON.parse(t); return t; } catch (_) {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { JSON.parse(m[0]); return m[0]; } catch (_) {} }
  const m2 = t.match(/\[[\s\S]*\]/);
  if (m2) { try { JSON.parse(m2[0]); return m2[0]; } catch (_) {} }
  return null;
}

module.exports = { SKILLS, SKILL_LIST: Object.values(SKILLS), buildMessages, executeSkill, safetyCheck };
