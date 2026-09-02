// 意图路由器：关键词命中 → 技能/工作流；未命中 → LLM 小分类（仅真实模式）→ 兜底自由聊天
const { SKILLS } = require('./skills');

const MARKETS = '日本|美国|北美|欧美|欧洲|德国|英国|法国|韩国|东南亚|澳洲|加拿大|中东|拉美|墨西哥|巴西|全球';

function extractParams(message) {
  const params = {};
  let m = message.match(/产品(?:是|叫|叫做)?\s*[：:"]?\s*([^，。,.！!？?；;]{2,60}?)(?=[，。,；;]|想卖|卖到|卖去|卖进|出海|推广|上架|目标|适合|$)/);
  if (!m) m = message.match(/(?:我是卖|做|生产|开发了?)\s*([^，。,]{2,60}?)(?=[，。,]|的|想卖|卖到|出海|$)/);
  if (m) params.product = m[1].trim();
  const mk = message.match(new RegExp(`(${MARKETS})`));
  if (mk) { params.market = mk[1]; params.language = mk[1] === '日本' ? 'ja' : mk[1] === '韩国' ? 'ko' : 'en'; }
  if (!params.product) params.product = message.slice(0, 80);
  return params;
}

function route(message) {
  if (/(完整|一键|全流程|全套|内容包|工作流|六个|都来|从头|整套|出海包)/.test(message)) return { type: 'workflow', params: extractParams(message) };
  for (const s of Object.values(SKILLS)) {
    if ((s.triggers || []).some((t) => message.includes(t))) return { type: 'skill', skillId: s.skill_id, params: extractParams(message) };
  }
  if (/(我的产品|想卖|卖到|卖去|卖进|出海|跨境|推广|上架|海外市场|目标用户)/.test(message)) return { type: 'workflow', params: extractParams(message) };
  return { type: 'chat' };
}

/* LLM 兜底分类（真实模式）：从候选中选一个 */
async function routeSmart(message) {
  const base = route(message);
  if (base.type !== 'chat') return base;
  const provider = require('./provider');
  if (provider.mode !== 'real') return base;
  try {
    const skillMenu = Object.values(SKILLS).map((s) => `${s.skill_id}(${s.name})`).join(', ');
    const out = await provider.chatReal([
      { role: 'system', content: '你是意图路由器。只能输出以下之一：workflow、' + Object.keys(SKILLS).join('、') + '、chat。不要输出其他任何内容。' },
      { role: 'user', content: `可用技能：${skillMenu}\nworkflow=完整出海内容包（串联全部技能）。\n用户消息：「${message.slice(0, 200)}」\n输出最匹配的意图。` },
    ], { maxTokens: 20, temperature: 0 });
    const t = (out.text || '').trim().toLowerCase();
    if (t === 'workflow') return { type: 'workflow', params: extractParams(message) };
    if (SKILLS[t]) return { type: 'skill', skillId: t, params: extractParams(message) };
  } catch (_) { /* 分类失败就走聊天 */ }
  return base;
}

module.exports = { route, routeSmart, extractParams };
