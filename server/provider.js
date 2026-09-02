// Provider 层：真实 LLM（OpenAI 兼容，主模型失败自动切备用）→ 全失败降级确定性 Mock（演示模式）
// v2：chatReal 返回 { text, usage } —— usage 供成本账（真实 token 计量）
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const BASE = process.env.LLM_BASE_URL || '';
const KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'deepseek-v4-flash';
const FALLBACK = process.env.LLM_FALLBACK_MODEL || '';
const mode = BASE && KEY ? 'real' : 'mock';

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/* 视觉质检：本地图片 → base64 → 视觉模型评审（deepseek-v4-flash-vision-exp，配额池独立） */
async function visionCheck(imagePath, question, { maxTokens = 500 } = {}) {
  const VISION_MODEL = process.env.LLM_VISION_MODEL || 'deepseek-v4-flash-vision-exp';
  const b64 = require('fs').readFileSync(imagePath).toString('base64');
  const ext = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const messages = [
    { role: 'user', content: [
      { type: 'image_url', image_url: { url: `data:${ext};base64,${b64}` } },
      { type: 'text', text: question },
    ] },
  ];
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: VISION_MODEL, messages, max_tokens: maxTokens, temperature: 0.2, stream: false }),
        signal: AbortSignal.timeout(90000),
      });
      const raw = await res.text();
      if (!raw.trim()) throw new Error('HTTP ' + res.status + ' 空响应');
      const data = JSON.parse(raw);
      if (data.error) throw new Error(data.error.message || 'provider error');
      const c = (data.choices?.[0]?.message?.content || '').trim();
      if (c) return { ok: true, text: c };
      throw new Error('empty content');
    } catch (e) { lastErr = e; await sleepMs(2000 * (attempt + 1)); }
  }
  return { ok: false, error: String(lastErr && lastErr.message || lastErr).slice(0, 120) };
}

async function chatReal(messages, { maxTokens = 3000, temperature = 0.8 } = {}) {
  const models = [MODEL, FALLBACK].filter(Boolean);
  let lastErr;
  // 每个模型最多 3 次：429/空响应指数退避（限流时空 body，res.json() 会抛 Unexpected end of JSON input）
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false }),
          signal: AbortSignal.timeout(120000),
        });
        const raw = await res.text();
        if (!raw.trim()) throw new Error('HTTP ' + res.status + ' 空响应' + (res.status === 429 ? '（限流）' : ''));
        let data;
        try { data = JSON.parse(raw); } catch (_) { throw new Error('非 JSON 响应: ' + raw.slice(0, 80)); }
        if (data.error) throw new Error(data.error.message || 'provider error');
        const msg = data.choices?.[0]?.message || {};
        const content = (msg.content || '').trim();
        if (content) return { text: content, usage: data.usage || null };
        // 个别推理模型把内容放 reasoning_content，兜底取其结论段
        const rc = (msg.reasoning_content || '').trim();
        if (rc) return { text: rc.split(/\n\n/).slice(-1)[0], usage: data.usage || null };
        throw new Error('empty content');
      } catch (e) {
        lastErr = e;
        const is429 = String(e.message).includes('429') || String(e.message).includes('限流');
        if (is429) {
          // 配额限流：短等一次（防突发限流），仍 429 就立刻换下一个模型（不同模型配额池独立）
          if (attempt === 0) { await sleepMs(3000); continue; }
          break;
        }
        await sleepMs(1500 * (attempt + 1));
      }
    }
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
    'visual-prompt': `# 图像提示词工坊（演示模式）\n\n**产品**：${p} · **场景**：${params.scene || '都市通勤'}\n\n## Midjourney v7\n\`\`\`\nproduct photography of ${p}, ${params.scene || 'urban commute'} scene, soft morning light, minimalist props, shallow depth of field, editorial style, 8k --ar 4:5 --v 7\n\`\`\`\n\n## 即梦（中文直出）\n\`\`\`\n${p}产品摄影，${params.scene || '都市通勤'}场景，清晨柔和光线，极简背景，浅景深，杂志质感\n\`\`\`\n\n## Stable Diffusion\n\`\`\`\n(masterpiece, best quality), product photo, ${p}, clean background, natural light, photorealistic\nNegative: blurry, watermark, text, oversaturated\n\`\`\`\n\n> 提示词可直接粘贴至对应工具生成成图；要直接拿成图请用「AI 直出配图」（image-studio），要成片用「真·视频成片」（video-factory）。`,
    'image-studio': JSON.stringify({ items: [
      { name: '横幅主图', aspect: '16:9', prompt: `hero product photography of ${p}, clean minimal studio background, soft directional light, premium editorial style, 8k` },
      { name: '信息流竖图', aspect: '4:5', prompt: `${p} in an urban lifestyle scene, morning light, shallow depth of field, magazine advertising photography` },
      { name: '方图氛围', aspect: '1:1', prompt: `cozy detail shot of ${p}, warm tones, natural window light, lifestyle product photography` },
    ] }, null, 2),
    'voice-writer': `# 英文旁白词包（演示模式）\n\n**产品**：${p}\n\n## A · 温情叙事\n> Every morning starts the same way. Until you make it better. ${p} — built for your everyday, so every day feels lighter.（重音：everyday / lighter）\n中文：每个清晨如常开始，直到你让它更好。${p}，为日常而生，让每一天更轻盈。\n\n## B · 热血带货\n> Stop settling for less. ${p}: built to last, priced to move. Grab yours today.（重音：Stop / today）\n中文：别再将就。${p}：耐用之选，心动之价，今天带它回家。\n\n## C · 极简高级\n> Less noise. More life. ${p}.（重音：life）\n中文：少一点喧嚣，多一点生活。${p}。`,
    'video-director': JSON.stringify({ scenes: [
      { id: 1, imgPrompt: `morning scene, person reaching for ${p} on wooden desk by window, warm sunlight, cozy cinematic product photography`, vo: `Every morning starts with ${p}.`, zh: `每个清晨，从${p}开始。`, dur: 4 },
      { id: 2, imgPrompt: `${p} hero shot on stone pedestal, studio lighting, dark background, premium product photography, water droplets`, vo: `Built to last. Priced to move.`, zh: '为耐用而生，以诚意定价。', dur: 4 },
      { id: 3, imgPrompt: `person carrying ${p} on mountain trail at golden hour, adventure lifestyle photography, cinematic composition`, vo: `${p}. Made to move with you.`, zh: `${p}，与你同行。`, dur: 5 },
    ] }, null, 2),
    'video-factory': JSON.stringify({ scenes: [
      { id: 1, imgPrompt: `morning coffee steam rising, ${p} on wooden desk by window, warm sunlight, cozy cinematic product photography`, vo: `It is six in the morning. ${p} is ready.`, zh: `早上六点，${p}已就绪。`, dur: 4 },
      { id: 2, imgPrompt: `${p} hero shot on stone pedestal, studio lighting, dark background, premium product photography`, vo: `Built for the journey ahead.`, zh: '为前路而生。', dur: 4 },
      { id: 3, imgPrompt: `person carrying ${p} on mountain trail at golden hour, adventure lifestyle photography`, vo: `${p}. Made to move with you.`, zh: `${p}，与你同行。`, dur: 5 },
    ] }, null, 2),
    'content-calendar': ['date,platform,theme,hook,tags', `Day 1,Instagram,产品亮相,"Meet ${p} — your everyday sidekick.",#${p} #launch`, `Day 2,TikTok,痛点场景,"POV: your bag is a black hole 🕳️",#fyp #edc`, `Day 3,X/Twitter,品牌故事,"Why we built ${p} — a thread 🧵",#buildinpublic`, `Day 4,Instagram,UGC征集,"Show us your carry. Win a gift 🎁",#giveaway`, `Day 5,TikTok,对比测评,"${p} vs the usual — 15s challenge",#review`, `Day 6,LinkedIn,创始人叙事,"The one-person company behind ${p}",#startup`, `Day 7,Product Hunt,正式发布,"${p} is LIVE on PH — support us!",#producthunt`].join('\n'),
    'local-check': `# 合规与文化体检清单（演示模式）\n\n**目标市场**：${m} · **体检日期**：${params.today || ''}\n\n## 广告合规\n- [ ] 避免 absolute claims（best / No.1 / cure）— 多数市场违反广告法\n- [ ] 价格标注含税与否需明示（欧盟/日本）\n- [ ] 促销折扣需标注原价与周期（欧盟 Omnibus 指令）\n\n## 文化禁忌（抽查）\n- 日本：避免"4"相关定价暗示；包装避免白色花意象\n- 中东：避免暴露模特；周五内容避开祷告时段\n- 欧美：圣诞季（Nov-Dec）是关键节点但避开宗教符号滥用\n\n## 节日营销日历\n| 节日 | 市场 | 日期 | 动作建议 |\n|---|---|---|---|\n| Boxing Day | 英联邦 | 12-26 | 清仓促销 |\n| Golden Week | 日本 | 04-29~05-05 | 出行场景内容 |\n\n> 清单由演示模式生成，v2 将接真实法规库检索。`,
  };
  return T[skillKey] || `（演示模式）${skillKey} 已执行，输入：${JSON.stringify(params).slice(0, 120)}`;
}

async function chatMock(skillKey, params) { return mockText(skillKey, params); }

module.exports = { mode, chatReal, chatMock, visionCheck, model: MODEL, provider: () => (mode === 'real' ? 'real' : 'mock') };
