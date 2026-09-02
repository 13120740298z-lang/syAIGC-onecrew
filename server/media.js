// 媒体工厂 v3.1：真·视频成片引擎（零 Key 零成本层，多通道降级）
//   生图 flux→turbo→本地渐变三级降级（按画幅原生分辨率）→ TTS edge-tts（按市场映射声线）→ ffmpeg 电影感合成
//   运镜库：zoom_in / zoom_out / pan_left / pan_right（2x 超采样抗抖动）
//   转场：xfade（fade / fadewhite / slideleft / circleopen）+ 棕噪声 whoosh 音效
//   结构：片头钩子卡（flux 暗调底 + 大字）→ 分镜 → 片尾 CTA 卡（品牌色）
//   产物：16:9 主片（1080p）+ 9:16 竖版（720x1280）+ 封面图 + SRT，落盘 data/runs/<run_id>/media/
// 设计约束：全部异步 Promise、可重试、进度经 onStep 上报、args 数组直传 ffmpeg（无 shell 转义问题）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/* ---------- ffmpeg / ffprobe 定位：环境变量 → WinGet 已知路径 → PATH ---------- */
const FF_CANDIDATES = [
  process.env.FFMPEG_PATH,
  'C:/Users/18201/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe',
  'ffmpeg',
].filter(Boolean);
const FFPROBE_CANDIDATES = [
  process.env.FFPROBE_PATH,
  'C:/Users/18201/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffprobe.exe',
  'ffprobe',
].filter(Boolean);

function resolveBin(cands) {
  for (const c of cands) {
    if (c === 'ffmpeg' || c === 'ffprobe') return c; // 信任 PATH
    try { fs.accessSync(c); return c; } catch (_) { /* next */ }
  }
  return cands[cands.length - 1];
}
const FF = () => resolveBin(FF_CANDIDATES);
const FFPROBE = () => resolveBin(FFPROBE_CANDIDATES);

const FONT_ZH = 'C:/Windows/Fonts/msyhbd.ttc';
const FONT_EN = 'C:/Windows/Fonts/arialbd.ttf';

/* ---------- 画幅与声线 ---------- */
const ASPECTS = {
  '16:9': { gen: [1280, 720], hd: [1920, 1080], ss: [2560, 1440] }, // gen=生图分辨率 ss=2x超采样
  '9:16': { gen: [720, 1280], hd: [720, 1280], ss: [1440, 2560] },
  '4:5': { gen: [1024, 1280], hd: [1024, 1280], ss: [2048, 2560] },
  '1:1': { gen: [1024, 1024], hd: [1024, 1024], ss: [2048, 2048] },
};
// edge-tts 声线按目标市场语言映射（neural 高自然度，全免费）
const VOICES = {
  en: 'en-US-AndrewNeural', ja: 'ja-JP-KeitaNeural', ko: 'ko-KR-InJoonNeural',
  de: 'de-DE-ConradNeural', fr: 'fr-FR-HenriNeural', es: 'es-ES-AlvaroNeural', zh: 'zh-CN-YunxiNeural',
};
const CAMERAS = ['zoom_in', 'zoom_out', 'pan_right', 'pan_left'];

/* ---------- 生图：多通道降级链（零 Key 零成本层） ----------
 * 通道1 flux（质量最佳）→ 通道2 turbo（快速宽松）→ 通道3 ffmpeg 本地渐变（终极兜底，永不失败）
 * 全局节流：请求间最小间隔 2.5s，防突发 429；429 指数退避并自动降级通道 */
let lastImgReq = 0;
const throttle = async () => {
  const wait = lastImgReq + 2500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastImgReq = Date.now();
};

function httpGetImage(url, timeoutMs = 180000) {
  return new Promise((done, fail) => {
    const req = require('https').get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://pollinations.ai/',
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return fail(new Error('pollinations HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < 8192) return fail(new Error('image too small: ' + buf.length));
        done(buf);
      });
    });
    req.on('error', fail);
    req.on('timeout', () => { req.destroy(); fail(new Error('pollinations timeout')); });
  });
}

/* 本地渐变兜底图：ffmpeg 生成电影感深色渐变 + 光斑（纯本地，零依赖） */
function localGradient(file, w, h, seedHint = 0) {
  const hue = 210 + (seedHint % 40); // 深蓝~靛色系
  const args = ['-y', '-f', 'lavfi',
    '-i', `gradients=s=${w}x${h}:c0=0x0d1420:c1=0x1a2b4a:c2=0x0a0f1a:x0=0:y0=0:x1=${w}:y1=${h}:duration=1`,
    '-frames:v', '1', '-q:v', '3', file];
  return new Promise((done, fail) => {
    const p = spawn(FF(), args, { windowsHide: true });
    p.on('error', fail);
    p.on('close', (code) => (code === 0 && fs.existsSync(file) ? done() : fail(new Error('gradient exit ' + code))));
  });
}

async function genImage(prompt, file, { width = 1280, height = 720, tries = 3, seed = null } = {}) {
  const sd = seed !== null ? seed : Math.floor(Math.random() * 1e6);
  const models = ['flux', 'turbo'];
  let lastErr;
  for (const model of models) {
    for (let i = 0; i < tries; i++) {
      try {
        await throttle();
        const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) +
          `?width=${width}&height=${height}&nologo=true&model=${model}&seed=` + (sd + i * 977);
        const buf = await httpGetImage(url);
        fs.writeFileSync(file, buf);
        return { file, bytes: buf.length, model };
      } catch (e) {
        lastErr = e;
        // 429 指数退避（换种子也难绕过限流，等为主），其他错误短等重试
        const is429 = String(e.message).includes('429');
        if (is429) await new Promise((r) => setTimeout(r, 4000 * (i + 1)));
        else await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  // 全通道失败：本地渐变兜底（成片流程绝不因生图挂掉）
  try { await localGradient(file, width, height, sd); return { file, bytes: fs.statSync(file).size, model: 'local-gradient' }; }
  catch (_) { throw lastErr; }
}

/* ---------- AI 视觉质检：vision 模型评审生图质量，不合格换种子重绘一次（可开关，默认开） ---------- */
const QC_QUESTION = '这是一张广告配图。请严格评审：1) 是否出现乱码文字/水印/扭曲的人手或人脸/肢体畸形等明显 AI 破绽；2) 是否符合商业广告摄影质量（构图/光线）。只回答 JSON：{"pass": true/false, "reason": "一句话"}';
async function qcImage(file, onStep) {
  let provider;
  try { provider = require('./provider'); } catch (_) { return { pass: true, skip: true }; }
  if (provider.mode !== 'real') return { pass: true, skip: true };
  const r = await provider.visionCheck(file, QC_QUESTION, { maxTokens: 300 });
  if (!r.ok) return { pass: true, skip: true }; // 质检通道故障不阻塞生产
  try {
    const m = String(r.text).match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    return j && typeof j.pass === 'boolean' ? { pass: j.pass, reason: j.reason || '' } : { pass: true, skip: true };
  } catch (_) { return { pass: true, skip: true }; }
}

async function genImageWithQc(prompt, file, opts, onStep, tag = '', label = '') {
  let r = await genImage(prompt, file, opts);
  if (opts.qc !== false && r.model !== 'local-gradient') {
    onStep && onStep(`${tag} ${label}：AI 视觉质检…`);
    const qc = await qcImage(file, onStep);
    if (!qc.pass) {
      onStep && onStep(`${tag} ${label}：质检未过（${(qc.reason || '').slice(0, 40)}），重绘…`);
      const retry = await genImage(prompt + ', flawless commercial photography, no distortion', file + '.retry.jpg', { ...opts, seed: Math.floor(Math.random() * 1e6) });
      const qc2 = await qcImage(retry.file, onStep);
      const useRetry = qc2.pass || fs.statSync(retry.file).size > fs.statSync(file).size;
      const finalFile = useRetry ? retry.file : file;
      if (useRetry) { fs.renameSync(retry.file, file); }
      else fs.unlinkSync(retry.file);
      r = { ...r, file: finalFile, qcRetried: true };
    }
  }
  return r;
}

/* ---------- TTS：edge-tts CLI，ENOENT 时回退 python -m edge_tts ---------- */
function tts(text, out, { voice = VOICES.en } = {}) {
  const run = (cmd, args) => new Promise((done, fail) => {
    spawn(cmd, args, { windowsHide: true })
      .on('error', fail)
      .on('close', (code) => (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 512 ? done() : fail(new Error(cmd + ' exit ' + code))));
  });
  return (async () => {
    try {
      await run('edge-tts', ['--voice', voice, '--text', text, '--write-media', out]);
    } catch (e) {
      if (e.code === 'ENOENT') await run('python', ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', out]);
      else throw e;
    }
    return { file: out, chars: text.length };
  })();
}
function mediaDuration(file) {
  return new Promise((done) => {
    const p = spawn(FFPROBE(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => done(parseFloat(out.trim()) || 0));
    p.on('error', () => done(0));
  });
}

function fmtSrt(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60).toFixed(0)).padStart(2, '0');
  const s = (sec % 60).toFixed(3).padStart(6, '0');
  return `${h}:${m}:${s.replace('.', ',')}`;
}

/* ---------- 运镜库：2x 超采样后 zoompan（抗亚像素抖动），输出到统一分辨率 ---------- */
function cameraFilter(cam, dur, ssW, ssH, outW, outH, fps) {
  const frames = Math.max(Math.round(dur * fps), 2);
  const zMax = 1.22, step = 0.0010;
  let expr;
  switch (cam) {
    case 'zoom_out': expr = `zoompan=z='if(lte(on,1),${zMax},max(zoom-${step},1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${ssW}x${ssH}:fps=${fps}`; break;
    case 'pan_left': expr = `zoompan=z='${zMax}':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)':d=${frames}:s=${ssW}x${ssH}:fps=${fps}`; break;
    case 'pan_right': expr = `zoompan=z='${zMax}':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${ssW}x${ssH}:fps=${fps}`; break;
    case 'zoom_in':
    default: expr = `zoompan=z='min(zoom+${step},${zMax})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${ssW}x${ssH}:fps=${fps}`; break;
  }
  return `scale=${ssW}:${ssH}:force_original_aspect_ratio=increase,crop=${ssW}:${ssH},${expr},scale=${outW}:${outH},format=yuv420p`;
}

/* ---------- 文本卡底图（flux 暗调电影感底，按画幅原生生成，复用给片头/片尾） ---------- */
async function cardBackground(dir, w, h, onStep) {
  const f = path.join(dir, `card_bg_${w}x${h}.jpg`);
  if (fs.existsSync(f)) return f;
  onStep && onStep('生成片头片尾卡底图…');
  const vertical = h > w;
  const prompt = (vertical
    ? 'dark cinematic gradient backdrop, vertical composition, deep navy blue to black, subtle bokeh light particles, premium advertising style, no text, minimalist'
    : 'dark cinematic gradient backdrop, deep navy blue to black, subtle bokeh light particles in corner, premium advertising style, no text, minimalist');
  try {
    await genImage(prompt, f, { width: w, height: h, tries: 2 });
  } catch (_) { return null; } // 底图失败不致命，回退纯色卡
  return f;
}

/* ---------- whoosh 转场音效：棕噪声 + 低通 + 包络（零素材声音设计） ---------- */
async function makeWhoosh(dir) {
  const f = path.join(dir, 'whoosh.wav');
  if (fs.existsSync(f)) return f;
  const args = ['-y', '-f', 'lavfi', '-i', 'anoisesrc=color=brown:duration=0.7:sample_rate=44100',
    '-af', 'lowpass=f=700,afade=t=in:st=0:d=0.18,afade=t=out:st=0.25:d=0.45,volume=1.6',
    '-c:a', 'pcm_s16le', f];
  await new Promise((done, fail) => {
    const p = spawn(FF(), args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? done() : fail(new Error('whoosh: ' + err.slice(-200)))));
  });
  return f;
}

/* ---------- 单画幅成片：scenes → MP4（片头卡 + xfade 分镜 + 片尾卡 + 双语字幕） ---------- */
const TD = 0.6; // 转场时长

function drawtextFile(file, { fontsize, color = 'white', y, x = '(w-text_w)/2', font, border = 2, shadow = 0, lineSpacing = 0 }) {
  // Windows 盘符冒号在滤镜图里必须转义（C: → C\:），否则被解析成选项分隔符
  const esc = (p) => p.split(path.sep).join('/').replace(/^([A-Za-z]):/, '$1\\:');
  const ff = font || FONT_ZH;
  return `drawtext=textfile='${esc(file)}':fontfile='${esc(ff)}':fontsize=${fontsize}:fontcolor=${color}:x=${x}:y=${y}:line_spacing=${lineSpacing}:borderw=${border}:bordercolor=black@0.55:shadowx=2:shadowy=2:shadowcolor=black@0.4`;
}
// 按内容选字体：含 CJK（中文/日文假名/韩文）→ 雅黑，纯拉丁 → Arial
const HAS_CJK = (t) => /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F\uAC00-\uD7AF]/.test(String(t || ''));
const pickFont = (t) => (HAS_CJK(t) ? FONT_ZH : FONT_EN);

async function renderAspect(scenes, dir, opts, tag, onStep) {
  const A = ASPECTS[opts.aspect] || ASPECTS['16:9'];
  const [outW, outH] = A.hd;
  const [ssW, ssH] = A.ss;
  const fps = 25;
  const lang = opts.language && VOICES[opts.language] ? opts.language : 'en';
  const voice = opts.voice || VOICES[lang];
  const styleSuffix = opts.styleSuffix ? ', ' + opts.styleSuffix : '';

  // 1) 生图（分镜 + 卡底）与配音
  const bg = await cardBackground(dir, outW, outH, onStep);
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    s.camera = CAMERAS.includes(s.camera) ? s.camera : CAMERAS[i % CAMERAS.length];
    onStep(`[${tag}] 分镜 ${i + 1}/${scenes.length}：AI 生图（${opts.aspect}）…`);
    s.imgFile = path.join(dir, `scene${i + 1}_${A.gen.join('x')}.jpg`);
    if (!fs.existsSync(s.imgFile)) await genImageWithQc(String(s.imgPrompt).slice(0, 800) + styleSuffix, s.imgFile, { width: A.gen[0], height: A.gen[1], tries: 3 }, onStep, `[${tag}]`, `分镜 ${i + 1}`);
    onStep(`[${tag}] 分镜 ${i + 1}/${scenes.length}：AI 配音（${voice}）…`);
    s.voFile = path.join(dir, `scene${i + 1}_${tag}.mp3`);
    if (!fs.existsSync(s.voFile)) await tts(String(s.vo).slice(0, 400), s.voFile, { voice });
    s.voDur = await mediaDuration(s.voFile);
    s.dur = Math.max(Math.min(Number(s.dur) || 4, 10), 2, (s.voDur || 0) + 0.6);
  }

  // 2) 时间线：片头卡(1.6s) + 分镜(xfade 交叠) + 片尾卡(2.2s)
  const INTRO_D = 1.6, END_D = 2.2;
  const timeline = [];
  timeline.push({ dur: INTRO_D, card: true });
  scenes.forEach((s) => timeline.push(s));
  timeline.push({ dur: END_D, card: true, end: true });
  const total = timeline.reduce((a, s) => a + s.dur, 0) - (timeline.length - 1) * TD;
  // xfade 链式偏移：第 j 个转场起点 = 前 j+1 段原始时长和 - (j+1)*TD（基于合并时间线，保证片尾卡完整露出）
  let acc = 0;
  const offsets = timeline.slice(0, -1).map((s, j) => (acc += s.dur) - (j + 1) * TD);
  // 每段分镜"完全可见且配音开口"的时刻（字幕与 VO 共用）：V_i = 片头 + 前_i_段分镜和 - i*TD
  let voAcc = INTRO_D;
  const voStarts = scenes.map((_, i) => { const v = i === 0 ? INTRO_D : voAcc - i * TD; voAcc += scenes[i].dur; return v; });

  // 3) 字幕（跟随各分镜可见窗口）
  const endCardVisible = offsets[offsets.length - 1] + TD;
  const srt = scenes.map((s, i) => {
    const start = voStarts[i];
    const end = i < scenes.length - 1 ? voStarts[i + 1] : endCardVisible;
    return `${i + 1}\n${fmtSrt(start)} --> ${fmtSrt(end)}\n${s.zh || ''}\n${s.vo || ''}\n`;
  }).join('\n');
  const srtFile = path.join(dir, `subs_${tag}.srt`);
  fs.writeFileSync(srtFile, srt, 'utf8');

  // 4) 文本卡内容（textfile 方式规避 drawtext 转义地狱）
  const writeTxt = (n, t) => { const f = path.join(dir, n); fs.writeFileSync(f, String(t || ''), 'utf8'); return f; };
  const vScale = opts.aspect === '9:16' ? 1.35 : 1; // 竖屏卡文字稍大
  // 钩子折行：宽度感知、绝不切断英文单词（中文字符逐个断，英文按词断）
  const wrapSmart = (t, maxUnits) => {
    t = String(t || '').trim();
    if (!t) return '';
    // 估算宽度单位：CJK≈1，拉丁/空格≈0.55
    const unit = (ch) => /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? 1 : 0.55;
    const lines = [];
    for (const para of t.split('\n')) {
      let cur = '', curW = 0, lineW = 0;
      // 先按词切（保留空格结构），CJK 单字成词
      const tokens = para.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]|[^\s\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]+|\s+/g) || [];
      for (const tok of tokens) {
        const w = [...tok].reduce((a, ch) => a + unit(ch), 0);
        if (curW + w > maxUnits && cur.trim()) { lines.push(cur.trim()); cur = tok.trimStart(); curW = w; }
        else { cur += tok; curW += w; }
        lineW = Math.max(lineW, curW);
      }
      if (cur.trim()) lines.push(cur.trim());
    }
    return lines.join('\n');
  };
  const maxUnits = opts.aspect === '9:16' ? 11 : 15;
  const hookZhText = wrapSmart((opts.hook && opts.hook.zh) || (scenes[0] && scenes[0].zh) || '', maxUnits);
  const hookEnText = wrapSmart((opts.hook && opts.hook.en) || (scenes[0] && scenes[0].vo) || '', maxUnits + 4);
  const hookZh = writeTxt(`hook_zh_${tag}.txt`, hookZhText);
  const hookEn = writeTxt(`hook_en_${tag}.txt`, hookEnText);
  const brandTxt = writeTxt(`brand_${tag}.txt`, (opts.brand || '').slice(0, 40));
  const ctaTxt = writeTxt(`cta_${tag}.txt`, (opts.cta || 'Shop now').slice(0, 60));  const srtEsc = srtFile.split(path.sep).join('/').replace(/^([A-Za-z]):/, '$1\\:');
  // 钩子块整体（中文+英文+间距）按真实行数计算总高，垂直居中；副标题固定在中文块下方不再重叠
  const zhLines = hookZhText.split('\n').length, enLines = hookEnText.split('\n').length;
  const fsBig = Math.round(outH / 15 * vScale), fsSub = Math.round(outH / 32 * vScale);
  const gap = Math.round(outH / 26);
  const blockH = zhLines * fsBig * 1.28 + gap + enLines * fsSub * 1.25;
  const yBig = `(${outH / 2})-(${Math.round(blockH / 2)})`;

  // 5) ffmpeg 合成
  onStep(`[${tag}] ffmpeg 合成 ${total.toFixed(1)}s（运镜 + 转场 + 声音设计）…`);
  const args = ['-y'];
  for (const s of timeline) {
    if (s.card && bg) args.push('-loop', '1', '-t', s.dur.toFixed(2), '-i', bg);
    else if (s.card) args.push('-f', 'lavfi', '-t', s.dur.toFixed(2), '-i', `color=c=0x0d1117:s=${outW}x${outH}:r=${fps}`);
    else args.push('-loop', '1', '-t', s.dur.toFixed(2), '-i', s.imgFile);
  }
  const whoosh = await makeWhoosh(dir);
  args.push('-i', whoosh);
  for (const s of scenes) args.push('-i', s.voFile); // VO 音频输入（下标 = timeline.length + 1 + i）

  const filters = [];
  // 视频链：卡底 drawtext + 分镜运镜
  timeline.forEach((s, i) => {
    if (s.card && bg) {
      const overlays = s.end
        ? [drawtextFile(brandTxt, { fontsize: Math.round(outH / 14 * vScale), y: yBig, font: pickFont(opts.brand) }), drawtextFile(ctaTxt, { fontsize: Math.round(outH / 24 * vScale), color: '0xBFE3FF', y: `${yBig}+${Math.round(outH / 10)}`, font: pickFont(opts.cta) })]
        : [drawtextFile(hookZh, { fontsize: fsBig, y: yBig, lineSpacing: Math.round(fsBig * 0.28) }), drawtextFile(hookEn, { fontsize: fsSub, color: '0xBFE3FF', y: `${yBig}+${Math.round(zhLines * fsBig * 1.28 + gap)}`, font: pickFont(hookEnText) })];
      filters.push(`[${i}:v]scale=${outW}:${outH},format=yuv420p,${overlays.join(',')}[c${i}]`);
    } else if (s.card) {
      filters.push(`[${i}:v]format=yuv420p[c${i}]`);
    } else {
      filters.push(`[${i}:v]${cameraFilter(s.camera, s.dur, ssW, ssH, outW, outH, fps)}[c${i}]`);
    }
  });
  // xfade 串接（首段用 fade 起黑场）
  let cur = 'c0';
  timeline.slice(1).forEach((_, k) => {
    const trans = k === 0 ? 'fade' : (timeline[k + 1] && timeline[k + 1].end ? 'fadewhite' : (['fade', 'slideleft', 'circleopen', 'fadewhite'][k % 4]));
    const nxt = `x${k}`;
    filters.push(`[${cur}][c${k + 1}]xfade=transition=${trans}:duration=${TD}:offset=${offsets[k].toFixed(3)}[${nxt}]`);
    cur = nxt;
  });
  filters.push(`[${cur}]subtitles=filename='${srtEsc}':force_style='FontName=Microsoft YaHei,FontSize=${Math.round(outH / 54)},PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,BorderStyle=1,Outline=1.1,Shadow=0.5,MarginV=${Math.round(outH / 18)}'[vout]`);

  // 音频链：每段 VO 精准对位到其画面窗口（adelay）+ whoosh 点缀（同一输入需 asplit）→ amix → 淡出
  const vIdx = timeline.length; // whoosh 输入下标
  scenes.forEach((s, i) => filters.push(`[${timeline.length + 1 + i}:a]aformat=sample_rates=44100:channel_layouts=mono,adelay=delays=${Math.round(voStarts[i] * 1000)}:all=1[vo${i}]`));
  filters.push(`[${vIdx}:a]asplit=${offsets.length}${offsets.map((_, k) => `[ws${k}]`).join('')}`);
  offsets.forEach((off, k) => {
    const d = Math.max(Math.round(off * 1000) - 250, 0);
    filters.push(`[ws${k}]adelay=delays=${d}:all=1,volume=${k === 0 || k === offsets.length - 1 ? 0.9 : 0.55}[w${k}]`);
  });
  filters.push(`${scenes.map((_, i) => `[vo${i}]`).join('')}${offsets.map((_, k) => `[w${k}]`).join('')}amix=inputs=${scenes.length + offsets.length}:duration=longest:normalize=0,afade=t=out:st=${Math.max(total - 0.9, 0).toFixed(2)}:d=0.9,apad=whole_dur=${total.toFixed(2)}[aout]`);

  const outFile = path.join(dir, `ad_${opts.aspect.replace(':', 'x')}_${Date.now()}.mp4`);
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', total.toFixed(2),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outFile);
  await new Promise((done, fail) => {
    const p = spawn(FF(), args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    p.on('error', fail);
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(outFile)) return done();
      // 失败时完整命令落盘，便于复核复现
      try { fs.writeFileSync(path.join(dir, `ffmpeg_fail_${Date.now()}.json`), JSON.stringify({ args, errTail: err.slice(-2000) }, null, 2)); } catch (_) {}
      fail(new Error('ffmpeg exit ' + code + ': ' + err.slice(-500)));
    });
  });
  const duration = await mediaDuration(outFile);

  // 6) 封面：第一个分镜中点抽帧
  let coverFile = null;
  try {
    const coverT = Math.min(INTRO_D - TD / 2 + scenes[0].dur / 2, Math.max(duration - 0.5, 0.5));
    coverFile = path.join(dir, `cover_${tag}.jpg`);
    await new Promise((done) => {
      const p = spawn(FF(), ['-y', '-ss', coverT.toFixed(2), '-i', outFile, '-frames:v', '1', '-q:v', '3', coverFile], { windowsHide: true });
      p.on('close', () => done());
      p.on('error', () => done());
    });
    if (!fs.existsSync(coverFile) || fs.statSync(coverFile).size < 4096) coverFile = null;
  } catch (_) { coverFile = null; }

  return { file: outFile, duration: duration || total, srtFile, coverFile, aspect: opts.aspect, images: scenes.length, ttsChars: scenes.reduce((a, s) => a + (s.vo || '').length, 0) };
}

/**
 * 视频工厂 v3 主流程：多画幅成片
 * scenes=[{imgPrompt, vo, zh, dur, camera}] → { renders: [{aspect, file, duration, coverFile, srtFile}], images, ttsChars }
 */
async function makeVideoAd(scenes, dir, opts = {}, onStep = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  const aspects = (opts.aspects && opts.aspects.length ? opts.aspects : ['16:9']).filter((a) => ASPECTS[a]);
  const renders = [];
  for (const aspect of aspects) {
    renders.push(await renderAspect(scenes, dir, { ...opts, aspect }, aspect.replace(':', ''), onStep));
  }
  return { renders, images: renders.reduce((a, r) => a + r.images, 0), ttsChars: renders.reduce((a, r) => a + r.ttsChars, 0) };
}

/* ---------- 成图直出：批量生图（支持多画幅） ---------- */
async function makeImages(items, dir, onStep = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const A = ASPECTS[it.aspect] || ASPECTS['16:9'];
    onStep(`成图 ${i + 1}/${items.length}：AI 绘制中（${A.hd.join('x')}）…`);
    const file = path.join(dir, `img_${Date.now()}_${i + 1}.jpg`);
    const r = await genImageWithQc(String(it.prompt).slice(0, 900), file, { width: A.gen[0], height: A.gen[1] }, onStep, '', `成图 ${i + 1}`);
    out.push({ ...r, name: it.name || ('配图-' + (i + 1)), aspect: it.aspect || '16:9' });
  }
  return out;
}

module.exports = { makeVideoAd, makeImages, genImage, VOICES, ASPECTS, CAMERAS };
