// 媒体生成层：文生图（火山 Seedream / 硅基流动）+ TTS（Edge 免费 → SiliconFlow/MiniMax 兜底）
// 全部可选配置：无任何 Key 时由 skills.js 走本地降级（构图小样 / 动态分镜），全流程不中断。
const fs = require('fs');
const path = require('path');

const ARK_BASE = process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const ARK_KEY = process.env.ARK_API_KEY || '';
const ARK_IMAGE_MODEL = process.env.ARK_IMAGE_MODEL || 'doubao-seedream-4-0-250828';
const SF_KEY = process.env.SILICONFLOW_API_KEY || '';
const SF_BASE = process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1';
const MM_KEY = process.env.MINIMAX_API_KEY || '';

function mediaMode() {
  if (ARK_KEY) return 'seedream';
  if (SF_KEY) return 'siliconflow';
  return 'local';
}
function ttsMode() {
  if (MM_KEY) return 'minimax';
  if (SF_KEY) return 'siliconflow';
  return 'edge'; // 免费，演示/开发用
}

async function downloadTo(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

/* ---------- 文生图：返回本地文件路径数组 ---------- */
async function generateImages(prompts, outDir, onStep) {
  const mode = mediaMode();
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (let i = 0; i < prompts.length; i++) {
    const { prompt, ratio, slot } = prompts[i];
    onStep && onStep(`生成第 ${i + 1}/${prompts.length} 张（${slot}）`);
    const dest = path.join(outDir, `img${i + 1}_${slot || i + 1}.png`.replace(/\s+/g, '_'));
    if (mode === 'seedream') {
      const size = ratio === '4:5' ? '1440x1792' : ratio === '9:16' ? '1152x2048' : '2048x2048';
      const res = await fetch(ARK_BASE + '/images/generations', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + ARK_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ARK_IMAGE_MODEL, prompt, size, response_format: 'url', watermark: false }),
        signal: AbortSignal.timeout(120000),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || 'seedream error');
      const url = data.data?.[0]?.url;
      if (!url) throw new Error('seedream: no url');
      await downloadTo(url, dest); // URL 24h 过期，当场落盘
    } else if (mode === 'siliconflow') {
      const w = ratio === '4:5' ? 1024 : ratio === '9:16' ? 768 : 1024;
      const h = ratio === '4:5' ? 1280 : ratio === '9:16' ? 1344 : 1024;
      const res = await fetch(SF_BASE + '/images/generations', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + SF_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'Kwai-Kolors/Kolors', prompt, image_size: `${w}x${h}`, batch_size: 1 }),
        signal: AbortSignal.timeout(120000),
      });
      const data = await res.json();
      const url = data.images?.[0]?.url || data.data?.[0]?.url;
      if (!url) throw new Error('siliconflow: no url: ' + JSON.stringify(data).slice(0, 200));
      await downloadTo(url, dest);
    } else {
      throw new Error('LOCAL_FALLBACK');
    }
    files.push(dest);
  }
  return files;
}

/* ---------- TTS：返回 { file, duration } ---------- */
async function synthesizeSpeech(text, outFile, language) {
  const mode = ttsMode();
  if (mode === 'minimax') {
    const voice = language === 'en' ? 'English风格女' : 'zh_femaleqingxinnüsheng';
    const res = await fetch('https://api.minimaxi.com/v1/t2a_v2', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + MM_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'speech-02-turbo', text,
        voice_setting: { voice_id: 'female-shaonv', speed: 1.0 },
        audio_setting: { sample_rate: 32000, format: 'mp3' },
      }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    if (data.base_resp?.status_code) throw new Error('minimax tts: ' + JSON.stringify(data.base_resp));
    const buf = Buffer.from(data.data.audio, 'hex');
    fs.writeFileSync(outFile, buf);
    return { file: outFile, duration: data.extra_info?.audio_length || null };
  }
  if (mode === 'siliconflow') {
    const res = await fetch(SF_BASE + '/audio/speech', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + SF_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'FunAudioLLM/CosyVoice2-0.5B', input: text, voice: 'FunAudioLLM/CosyVoice2-0.5B:alex', response_format: 'mp3' }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error('sf tts http ' + res.status);
    fs.writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
    return { file: outFile, duration: null };
  }
  // Edge TTS（免费）——失败时抛错，由调用方决定是否静音继续；按市场语言选声线
  const { EdgeTTS } = require('node-edge-tts');
  const VOICES = {
    en: 'en-US-JennyNeural',
    zh: 'zh-CN-XiaoxiaoNeural',
    ja: 'ja-JP-NanamiNeural',
    ko: 'ko-KR-SunHiNeural',
  };
  const tts = new EdgeTTS();
  await tts.ttsPromise(text, outFile, { voice: VOICES[language] || VOICES.en });
  return { file: outFile, duration: null };
}

function probeDuration(file) {
  const { spawnSync } = require('child_process');
  // ffmpeg-static 只带 ffmpeg，无 ffprobe：用 ffmpeg -i 从 stderr 解析 Duration
  const r = spawnSync(require('ffmpeg-static'), ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = String(r.stderr).match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

module.exports = { mediaMode, ttsMode, generateImages, synthesizeSpeech, probeDuration, downloadTo };
