// roadshow/build_video.js — 对比宣传视频合成器（P2）
// 输入：roadshow/storyboard.yml（10 幕）+ roadshow/work/nar_*.mp3（旁白）+ assets/bgm_calm_loop.m4a
// 输出：roadshow/OneCrew_对比视频.mp4（1920x1080 横屏 h264 + aac）
// 结构：每幕 = 底图动效（Ken Burns/滑移/数字弹出）+ 底部大字 + 底条 + 旁白；BGM 全程 ducking
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'roadshow', 'work');
const W = 1920, H = 1080, FPS = 30;

function parseStoryboard(text) {
  const scenes = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const m = raw.match(/^-\s+id:\s*(\d+)/);
    if (m) { cur = { id: +m[1] }; scenes.push(cur); continue; }
    if (!cur) continue;
    const kv = raw.match(/^\s+(\w+):\s*(.*)$/);
    if (!kv) continue;
    let [, k, v] = kv;
    v = v.trim();
    if (k === 'stats') cur.stats = JSON.parse(v);
    else cur[k] = v;
  }
  return scenes;
}

function probeDur(file) {
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = String(r.stderr).match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null;
}

function escFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

// ASS 字幕（横屏 1920x1080）：主标题 64px + 小字 40px，用系统微软雅黑
function buildAss(scene, dur) {
  const esc = (s) => s.replace(/\\/g, '').replace(/\{/g, '(').replace(/\}/g, ')');
  const hasBig = !!scene.big;
  const hasTitle = !!scene.title;
  const bigLine = scene.big || '';
  const titleLine = scene.title || '';
  const subLine = scene.sub || '';
  const lines = [];
  const push = (t, txt, size, colour) => lines.push({ t, txt, size, colour });
  if (hasBig) push(0, esc(bigLine), 110, '&H00FFFFFF');
  if (hasTitle) push(0, esc(titleLine), 88, '&H00FFFFFF');
  if (subLine) push(hasBig || hasTitle ? 0.7 : 0.2, esc(subLine), 44, '&H00BFD4FF');
  const fmt = (t) => {
    const h = String(Math.floor(t / 3600)).padStart(1, '0');
    const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
    const s = (t % 60).toFixed(2).padStart(5, '0');
    return `${h}:${m}:${s}`;
  };
  const events = lines.map((L, idx) =>
    `Dialogue: 0,${fmt(L.t)},${fmt(dur - 0.05)},Sell${idx},,0,0,0,,${L.txt}`).join('\n');
  const header = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Sell0,Microsoft YaHei,${lines[0] ? lines[0].size : 88},${lines[0] ? lines[0].colour : '&H00FFFFFF'},&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,1,2,60,60,150,1`,
    ...lines.slice(1).map((L, i) => `Style: Sell${i + 1},Microsoft YaHei,${L.size},${L.colour},&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,2,60,60,${210 + i * 70},1`),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
  return header + '\n' + events + '\n';
}

// 单幕合成 → work/scene_XX.mp4（含该幕旁白音轨，等长）
async function buildScene(scene, sceneIdx) {
  const dur = +(probeDur(path.join(ROOT, scene.nar)) + 1.1).toFixed(2); // 旁白 + 1.1s 余韵
  const assFile = path.join(WORK, `ass_${String(scene.id).padStart(2, '0')}.ass`);
  fs.writeFileSync(assFile, buildAss(scene, dur), 'utf8');
  const out = path.join(WORK, `scene_${String(scene.id).padStart(2, '0')}.mp4`);

  const args = [];
  const f = [];
  let baseIdx = null;

  if (scene.base_type === 'video') {
    // 视频底：缩放裁切到 1920x1080（居中裁 9:16→16:9），循环到幕长
    baseIdx = 0;
    args.push('-stream_loop', '-1', '-t', String(dur), '-i', path.join(ROOT, scene.base));
    f.push(`[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,bwdif=0[vb]`);
  } else {
    // 图片底：slide → 横移；kb → Ken Burns；stats → 静态底 + 前景数字由 ASS 呈现
    baseIdx = 0;
    args.push('-loop', '1', '-t', String(dur), '-i', path.join(ROOT, scene.base));
    let motion;
    if (scene.kind === 'slide') {
      motion = `zoompan=z='1.06':x='(iw-iw/zoom)*(on/${(dur * FPS).toFixed(0)})':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}`;
    } else {
      motion = `zoompan=z='1+0.00045*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS}`;
    }
    f.push(`[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,${motion}[vb]`);
  }

  // 暗角压暗 + ASS 字幕
  f.push(`[vb]eq=brightness=-0.06,ass='${escFilterPath(assFile)}'[vout]`);

  // 音频：该幕旁白，加 0.25s 淡入淡出
  const narIdx = baseIdx + 1;
  args.push('-i', path.join(ROOT, scene.nar));
  f.push(`[${narIdx}:a]aresample=44100,afade=t=in:st=0:d=0.25,afade=t=out:st=${(dur - 0.45).toFixed(2)}:d=0.4,apad[aout]`);

  const filterFile = path.join(WORK, `filter_${String(scene.id).padStart(2, '0')}.txt`);
  fs.writeFileSync(filterFile, f.join(';\n'), 'utf8');
  args.push('-filter_complex_script', filterFile,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', String(FPS),
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-t', String(dur), '-y', out);

  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { shell: false });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + String(d)).slice(-2000); });
    p.on('error', reject);
    p.on('close', (c) => c === 0 ? resolve(out) : reject(new Error(`scene ${scene.id} exit ${c}: ${err.slice(-500)}`)));
  });
  console.log(`scene ${scene.id} ok (${dur}s)`);
  return { out, dur };
}

// 全幕 concat（re-encode 级联，避免参数不一致）→ 加 BGM ducking → 成片
async function finalize(scenes, metas) {
  const listFile = path.join(WORK, 'concat.txt');
  fs.writeFileSync(listFile, metas.map((m) => `file '${m.out.replace(/\\/g, "/").replace(/'/g, "\\'")}'`).join('\n'), 'utf8');
  const joined = path.join(WORK, 'joined.mp4');
  const total = metas.reduce((a, m) => a + m.dur, 0) + 2.0; // +2s 尾板黑场
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', joined], { shell: false });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + String(d)).slice(-1500); });
    p.on('error', reject);
    p.on('close', (c) => c === 0 ? resolve() : reject(new Error('concat exit ' + c + ' ' + err)));
  });
  const bgm = path.join(ROOT, 'assets', 'bgm_calm_loop.m4a');
  const outFile = path.join(ROOT, 'roadshow', 'OneCrew_对比视频.mp4');
  const args = ['-i', joined, '-stream_loop', '-1', '-i', bgm,
    '-filter_complex',
    `[1:a]volume=0.16,aresample=44100,aformat=channel_layouts=stereo[bg];` +
    `[0:a]asplit=2[n1][n2];` +
    `[bg][n1]sidechaincompress=threshold=0.03:ratio=8:attack=120:release=700[duck];` +
    `[duck][n2]amix=inputs=2:duration=first:normalize=0,afade=t=out:st=${(total - 1.6).toFixed(2)}:d=1.5[aout]`,
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    '-t', total.toFixed(2), '-y', outFile];
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { shell: false });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + String(d)).slice(-1500); });
    p.on('error', reject);
    p.on('close', (c) => c === 0 ? resolve() : reject(new Error('bgm exit ' + c + ' ' + err.slice(-500))));
  });
  console.log('final:', outFile, 'total', total.toFixed(1) + 's');
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  const scenes = parseStoryboard(fs.readFileSync(path.join(__dirname, 'storyboard.yml'), 'utf8'));
  console.log('scenes:', scenes.length);
  const metas = [];
  for (const s of scenes) metas.push(await buildScene(s, scenes.indexOf(s)));
  await finalize(scenes, metas);
})().catch((e) => { console.error(e); process.exit(1); });
