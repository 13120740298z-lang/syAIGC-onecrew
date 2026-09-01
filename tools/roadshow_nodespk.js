// 对比视频旁白生成：node tools/roadshow_nodespk.js → roadshow/work/nar_XX.mp3 ×10
// 用 Edge 免费引擎（zh-CN-XiaoxiaoNeural），与产品 TTS 同款，+8% 语速
const fs = require('fs');
const path = require('path');
const { EdgeTTS } = require('node-edge-tts');

const SCRIPTS = [
  'OneCrew，一个人的内容小队。',
  'TikTok Shop 官方要求日更至少一条视频。一个人做跨境，光内容每周就要烧掉六到十个小时。',
  '我们实测了八家主流 AI 内容工具：没有一家做到出图又出片的全链路，更没有一家做合规体检。',
  '这就是我们的定位：填补市场空白。',
  'OneCrew，是一个人的内容小队。你说一句产品，八位 AI 队友接力——从市场调研，到合规体检。',
  '真实运行留痕：一百八十三秒，九步全部完成，十三个可发布工件，包括四张 AI 产品图，和一条十五秒竖屏带货成片。',
  '视频有 AI 配音、真实运镜和字幕。全部真实运行记录，可打开复核。',
  '成本透明到分：每次全流程一块二。人工确认，随时可改方向。',
  '合规体检是我们踩出来的差异化。百分之七十八的卖家搞不定广告合规，近四成首年被封号。每一次产出，都过一遍广告法和文化禁忌核对。',
  '一个人，等于一支内容小队。别人还在写文案，我们的用户，已经在发视频。',
];

(async () => {
  const outDir = path.join(__dirname, '..', 'roadshow', 'work');
  fs.mkdirSync(outDir, { recursive: true });
  const meta = [];
  for (let i = 0; i < SCRIPTS.length; i++) {
    const f = path.join(outDir, `nar_${String(i).padStart(2, '0')}.mp3`);
    const tts = new EdgeTTS();
    await tts.ttsPromise(SCRIPTS[i], f, { voice: 'zh-CN-XiaoxiaoNeural', rate: '+8%' });
    meta.push({ i, text: SCRIPTS[i], file: path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/') });
    console.log('ok', i);
  }
  fs.writeFileSync(path.join(outDir, 'narration_scripts.json'), JSON.stringify(meta, null, 2), 'utf8');
})();
