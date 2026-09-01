// Provider 层：真实 LLM（OpenAI 兼容，主模型失败自动切备用）→ 全失败降级确定性 Mock（演示模式）
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const BASE = process.env.LLM_BASE_URL || '';
const KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'deepseek-v4-flash';
const FALLBACK = process.env.LLM_FALLBACK_MODEL || '';
const mode = BASE && KEY ? 'real' : 'mock';

async function chatReal(messages, { maxTokens = 3000, temperature = 0.8 } = {}) {
  const models = [MODEL, FALLBACK].filter(Boolean);
  let lastErr;
  for (const model of models) {
    try {
      const res = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false }),
        signal: AbortSignal.timeout(120000),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || 'provider error');
      const msg = data.choices?.[0]?.message || {};
      const content = (msg.content || '').trim();
      if (content) return content;
      // 个别推理模型把内容放 reasoning_content，兜底取其结论段
      const rc = (msg.reasoning_content || '').trim();
      if (rc) return rc.split(/\n\n/).slice(-1)[0];
      throw new Error('empty content');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all models failed');
}

/* ---------- MockProvider：确定性产出（无 key / 断网时全流程仍可演示可复核） ---------- */
function mockText(skillKey, params) {
  const p = params.product || '你的产品';
  const m = params.market || '北美';
  const lang = params.language || 'en';
  const en = { '北美': 'North America', '欧洲': 'Europe', '东南亚': 'Southeast Asia', '日本': 'Japan' }[m] || m;
  const T = {
    'market-scan': `# 市场快研报告（演示模式）\n\n**产品**：${p} · **目标市场**：${m}\n\n## 1. 市场规模与趋势\n- ${en} 对该品类需求稳定增长，线上渗透率持续提升（演示数据）。\n- 高潜细分：注重性价比的年轻家庭、都市通勤人群。\n\n## 2. 平台优先级\n| 平台 | 定位 | 优先级 |\n|---|---|---|\n| Instagram | 视觉种草 | ★★★★★ |\n| TikTok | 爆发引流 | ★★★★★ |\n| Amazon/DTC | 转化承接 | ★★★★ |\n| X/Twitter | 口碑传播 | ★★★ |\n\n## 3. 竞品与差异化\n- 竞品集中在中高价位，卖点趋同（大容量/保温时长）。\n- 差异化角度：场景化叙事（通勤/健身/露营）+ 一眼可辨的视觉锤。\n\n## 4. 定价建议\n- 建议锚定 $19.9–$29.9 区间，首发配合评论激励。\n\n> 本报告由演示模式生成，接入真实模型后内容将更具体。`,
    'brand-voice': JSON.stringify({ brand: p, positioning: `为${m}用户设计的可靠之选`, persona: '专业而亲切的朋友', tone: ['简洁', '有画面感', '克制不夸张'], vocabulary: { use: ['effortless', 'everyday carry', 'built to last'], avoid: ['cheapest', 'magic', 'revolutionary'] }, slogans: ['Carry less. Enjoy more.', 'Your day, simplified.', 'Made to move with you.'], demo: true }, null, 2),
    'copy-studio': `# 五平台文案包（演示模式）\n\n**产品**：${p} · **市场**：${m} · **语言**：${lang.toUpperCase()}\n\n## X / Twitter（≤280 字符）\n> Meet ${p} — built for your everyday carry. Simple, reliable, and made to move with you. 🚀\n\n## Instagram（Caption）\n> Your day just got lighter. ✨\n> ${p} — designed for real life in ${en}.\n> #${p.replace(/\s+/g, '')} #EverydayCarry #MadeToMove\n\n## TikTok 脚本（15 秒）\n1. Hook(0-3s): "POV: your bag is a black hole."\n2. Show(3-8s): 产品特写 + 三个使用场景快切\n3. CTA(8-15s): "Grab yours — link in bio."\n\n## LinkedIn（品牌故事）\n> We started with a simple question: why does everyday gear over-complicate life? ${p} is our answer — thoughtful design for people who move.\n\n## Product Hunt（首评模板）\n> Hey PH! We built ${p} for people who value simplicity. Ask us anything in the comments — team is here all day!`,
    'visual-prompt': `# 图像提示词工坊（演示模式）\n\n**产品**：${p} · **场景**：${params.scene || '都市通勤'}\n\n## Midjourney v7\n\`\`\`\nproduct photography of ${p}, ${params.scene || 'urban commute'} scene, soft morning light, minimalist props, shallow depth of field, editorial style, 8k --ar 4:5 --v 7\n\`\`\`\n\n## 即梦（中文直出）\n\`\`\`\n${p}产品摄影，${params.scene || '都市通勤'}场景，清晨柔和光线，极简背景，浅景深，杂志质感\n\`\`\`\n\n## Stable Diffusion\n\`\`\`\n(masterpiece, best quality), product photo, ${p}, clean background, natural light, photorealistic\nNegative: blurry, watermark, text, oversaturated\n\`\`\`\n\n> 提示词可直接粘贴至对应工具生成成图（本项目仅产提示词，不产成片）。`,
    'content-calendar': ['date,platform,theme,hook,tags', `Day 1,Instagram,产品亮相,"Meet ${p} — your everyday sidekick.",#${p} #launch`, `Day 2,TikTok,痛点场景,"POV: your bag is a black hole 🕳️",#fyp #edc`, `Day 3,X/Twitter,品牌故事,"Why we built ${p} — a thread 🧵",#buildinpublic`, `Day 4,Instagram,UGC征集,"Show us your carry. Win a gift 🎁",#giveaway`, `Day 5,TikTok,对比测评,"${p} vs the usual — 15s challenge",#review`, `Day 6,LinkedIn,创始人叙事,"The one-person company behind ${p}",#startup`, `Day 7,Product Hunt,正式发布,"${p} is LIVE on PH — support us!",#producthunt`].join('\n'),
    'local-check': `# 合规与文化体检清单（演示模式）\n\n**目标市场**：${m}\n\n## 广告合规\n- [ ] 避免 absolute claims（best / No.1 / cure）— 多数市场违反广告法\n- [ ] 价格标注含税与否需明示（欧盟/日本）\n- [ ] 促销折扣需标注原价与周期（欧盟 Omnibus 指令）\n\n## 文化禁忌（抽查）\n- 日本：避免"4"相关定价暗示；包装避免白色花意象\n- 中东：避免暴露模特；周五内容避开祷告时段\n- 欧美：圣诞季（Nov-Dec）是关键节点但避开宗教符号滥用\n\n## 节日营销日历\n| 节日 | 市场 | 日期 | 动作建议 |\n|---|---|---|---|\n| Boxing Day | 英联邦 | 12-26 | 清仓促销 |\n| Golden Week | 日本 | 04-29~05-05 | 出行场景内容 |\n\n> 清单由演示模式生成，v2 将接真实法规库检索。`,
  };
  T['visual-studio'] = JSON.stringify([
    { slot: '主图', prompt: `professional e-commerce product photography of ${p}, centered composition on a clean gradient studio background, soft key light with subtle rim light, ultra high detail, commercial advertising style`, ratio: '1:1' },
    { slot: '场景图', prompt: `${p} naturally placed in ${params.scene || 'urban commute'} lifestyle scene, morning sunlight, shallow depth of field, candid editorial photography`, ratio: '4:5' },
    { slot: '细节图', prompt: `extreme macro close-up of ${p} surface material and craftsmanship, dramatic side lighting, dark moody background, texture emphasis`, ratio: '1:1' },
    { slot: '氛围图', prompt: `cinematic wide shot of ${p} in an aspirational ${params.scene || 'outdoor camping'} atmosphere, golden hour glow, moody color grading, premium brand feeling`, ratio: '4:5' },
  ], null, 2);
  T['video-director'] = JSON.stringify({
    title: `${p} · 15秒带货成片`,
    narration: `还在为${params.scene || '日常使用'}发愁吗？${p}，一次到位。现在点击下方链接，把它带回家。`,
    subtitles: [
      { text: '还在犹豫吗？', start: 0, end: 3 },
      { text: `${p}，一次到位`, start: 3, end: 7 },
      { text: '细节与品质看得见', start: 7, end: 11 },
      { text: '点击下方链接，立即带走', start: 11, end: 14.5 },
    ],
    scenes: [
      { image: 0, desc: '主图开场，镜头缓慢推近' },
      { image: 1, desc: '场景图横移，展现真实使用' },
      { image: 2, desc: '细节图微缩放，质感特写' },
      { image: 3, desc: '氛围图拉远收尾，落版 CTA' },
    ],
  }, null, 2);
  return T[skillKey] || `（演示模式）${skillKey} 已执行，输入：${JSON.stringify(params).slice(0, 120)}`;
}

async function chatMock(skillKey, params) { return mockText(skillKey, params); }

/* OpenAI 兼容流式输出（index.js 自由聊天用；非流式走 chatReal） */
async function streamChat(system, messages, onDelta, { maxTokens = 2000, temperature = 0.7 } = {}) {
  const res = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: system }, ...messages], stream: true, max_tokens: maxTokens, temperature }),
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

module.exports = { mode, chatReal, chatMock, streamChat, model: MODEL, provider: () => (mode === 'real' ? 'real' : 'mock') };
