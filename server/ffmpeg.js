// 视频合成层：spawn + ffmpeg-static（fluent-ffmpeg 已弃维，直接拼滤镜链）
// 流程：产品图×4 → Ken Burns(zoompan) → 交叉淡化(xfade) → ASS 字幕烧录 → 旁白+BGM ducking 混音 → 1080x1920 MP4
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const W = 1080, H = 1920, FPS = 30;

/* 每张图的 Ken Burns 表达式轮换：推近 / 横移 / 微缩放 / 拉远 */
const KEN_BURNS = [
  "zoompan=z='1+0.0009*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
  "zoompan=z='1.15':x='(iw-iw/zoom)*(on/DPD)':y='ih/2-(ih/zoom/2)'",
  "zoompan=z='1+0.0006*on':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*0.4'",
  "zoompan=z='1.20-0.0009*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
];

function escFilterPath(p) {
  // 滤镜层路径转义：\ → / 、: → \: 、' → \'
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/* ASS 字幕：底部大字 + 描边，移动端可读 */
function buildAss(subtitles, fontsDir) {
  const fmt = (t) => {
    const h = String(Math.floor(t / 3600)).padStart(1, '0');
    const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
    const s = (t % 60).toFixed(2).padStart(5, '0');
    return `${h}:${m}:${s}`;
  };
  const header = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Sell,Noto Sans CJK SC,88,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,5,2,2,60,60,180,1`, '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
  const events = subtitles.map((s) => `Dialogue: 0,${fmt(s.start)},${fmt(s.end)},Sell,,0,0,0,,${s.text}`).join('\n');
  return header + '\n' + events + '\n';
}

/*
 * images: 本地图片路径数组（≥1）
 * narration: 旁白音频路径（可 null）
 * subtitles: [{text,start,end}]（可 null）
 * bgm: 背景音乐路径（可 null）
 * out: 输出 mp4 路径
 * onProgress(pct, note)
 */
async function synthesizeVideo({ images, narration, subtitles, bgm, out, durationSec, onProgress }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onecrew-vid-'));
  let assFile = null;
  if (subtitles && subtitles.length) {
    assFile = path.join(tmp, 'subs.ass');
    fs.writeFileSync(assFile, buildAss(subtitles), 'utf8');
  }
  const each = 4; // 每图时长（秒）
  const total = durationSec || Math.max(images.length * each - (images.length - 1) * 1, 8);

  // 输入参数
  const args = [];
  for (const img of images) args.push('-loop', '1', '-t', String(each), '-i', img);
  let narIdx = null, bgmIdx = null;
  if (narration && fs.existsSync(narration)) { narIdx = images.length; args.push('-i', narration); }
  if (bgm && fs.existsSync(bgm)) { bgmIdx = images.length + (narIdx === null ? 0 : 1); args.push('-stream_loop', '-1', '-i', bgm); }

  // 滤镜图
  const f = [];
  images.forEach((_, i) => {
    const kb = KEN_BURNS[i % KEN_BURNS.length].replace(/DPD/g, String(each * FPS));
    f.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,${kb}:d=1:s=${W}x${H}:fps=${FPS}[v${i}]`);
  });
  let last = 'v0';
  for (let i = 1; i < images.length; i++) {
    const offset = i * (each - 1); // 累计 offset：每段 4s、淡化 1s
    const outL = `x${i}`;
    f.push(`[${last}][v${i}]xfade=transition=fade:duration=1:offset=${offset}[${outL}]`);
    last = outL;
  }
  let vchain = `[${last}]format=yuv420p`;
  if (assFile) vchain += `,ass='${escFilterPath(assFile)}'`;
  vchain += '[vout]';
  f.push(vchain);

  // 音频：旁白优先，BGM ducking
  let aout = null;
  if (narIdx !== null && bgmIdx !== null) {
    f.push(`[${narIdx}:a]aresample=44100[nar]`);
    f.push(`[${bgmIdx}:a]volume=0.18,afade=t=in:st=0:d=1,atrim=0:${total.toFixed(2)},aresample=44100[mus]`);
    f.push(`[mus][nar]sidechaincompress=threshold=0.03:ratio=8:attack=120:release=700[duck]`);
    f.push(`[duck][nar]amix=inputs=2:duration=first:normalize=0[aout]`);
    aout = 'aout';
  } else if (narIdx !== null) {
    f.push(`[${narIdx}:a]aresample=44100[aout]`); aout = 'aout';
  } else if (bgmIdx !== null) {
    f.push(`[${bgmIdx}:a]volume=0.35,atrim=0:${total.toFixed(2)},aresample=44100[aout]`); aout = 'aout';
  }

  const outArgs = ['-map', '[vout]'];
  if (aout) outArgs.push('-map', `[${aout}]`);
  outArgs.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', String(FPS),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  );
  if (aout) outArgs.push('-c:a', 'aac', '-b:a', '128k');
  outArgs.push('-t', total.toFixed(2), '-y', out);

  const filterFile = path.join(tmp, 'filter.txt'); // 滤镜链走文件，免 shell/长度/转义三层坑
  fs.writeFileSync(filterFile, f.join(';\n'), 'utf8');
  const fullArgs = [...args, '-filter_complex_script', filterFile, ...outArgs];

  onProgress && onProgress(10, `ffmpeg 合成中（${images.length} 镜 · ${total.toFixed(0)}s · ${aout ? '旁白+BGM' : '无音频'}）`);
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, fullArgs, { shell: false });
    let errTail = '';
    proc.stderr.on('data', (d) => {
      errTail = (errTail + String(d)).slice(-4000);
      const m = String(d).match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (m && onProgress) {
        const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
        onProgress(10 + Math.min(85, (t / total) * 85), `编码 ${Math.round((t / total) * 100)}%`);
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
      if (code === 0) resolve(out);
      else reject(new Error('ffmpeg exit ' + code + ' :: ' + errTail.slice(-600)));
    });
  });
}

/* 本地降级：无生图 Key 时，用 ffmpeg 程序化合成「构图小样」图（渐变底 + 产品名大字） */
async function makePlaceholderImage(text, sub, dest) {
  const tmpf = path.join(os.tmpdir(), 'oc-ph-' + Date.now() + '.txt');
  fs.writeFileSync(tmpf, text, 'utf8');
  const args = [
    '-f', 'lavfi', '-i', `gradients=s=${W}x${H}:c0=0x1a2a4f:c1=0x4f7bd9:speed=0.05`,
    '-vf', `drawtext=textfile='${escFilterPath(tmpf)}':fontcolor=white:fontsize=100:x=(w-text_w)/2:y=(h-text_h)/2-120:line_spacing=20,` +
      `drawtext=textfile='${escFilterPath(tmpf)}':fontcolor=0xBFD4FF:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2+80`,
    '-frames:v', '1', '-y', dest,
  ];
  // drawtext 的 textfile 只能读一份；此处两次引用同一文件没问题
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { shell: false });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (c) => { try { fs.unlinkSync(tmpf); } catch (_) {} c === 0 ? resolve(dest) : reject(new Error('placeholder exit ' + c + ' ' + err.slice(-300))); });
  });
  return dest;
}

module.exports = { synthesizeVideo, buildAss, makePlaceholderImage, KEN_BURNS };
