// 技能加载器：Wave2 沉淀的 skills/*.json 是唯一事实源，引擎运行时真实加载（非摆设）
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

/* ---------- 技能执行：真实优先，失败降级 Mock ---------- */
const provider = require('./provider');
async function executeSkill(skillKey, params, onStep) {
  const skill = SKILLS[skillKey];
  if (!skill) throw new Error('未知技能: ' + skillKey);
  onStep && onStep('running', `调用技能「${skill.name}」`);
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
  return null;
}

module.exports = { SKILLS, SKILL_LIST: Object.values(SKILLS), buildMessages, executeSkill, safetyCheck };
