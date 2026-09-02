// JSON 文件存储：sessions / runs / exports（零安装、可直接打开文件复核 —— 评审留证用）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const DIRS = {
  sessions: path.join(DATA, 'sessions'),
  runs: path.join(DATA, 'runs'),
  exports: path.join(ROOT, 'exports'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

function atomicWrite(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
const rid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- Sessions ---------- */
function createSession(title) {
  const s = {
    session_id: rid('s'),
    title: (title || '新会话').slice(0, 24),
    messages: [],
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  atomicWrite(path.join(DIRS.sessions, s.session_id + '.json'), s);
  return s;
}
function getSession(id) {
  const f = path.join(DIRS.sessions, id + '.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
function saveSession(s) {
  s.updated_at = Date.now();
  atomicWrite(path.join(DIRS.sessions, s.session_id + '.json'), s);
}
function listSessions() {
  return fs.readdirSync(DIRS.sessions)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DIRS.sessions, f), 'utf8')))
    .sort((a, b) => b.updated_at - a.updated_at)
    .map(({ session_id, title, updated_at }) => ({ session_id, title, updated_at }));
}
function deleteSession(id) {
  const f = path.join(DIRS.sessions, id + '.json');
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

/* ---------- Runs（不可变审计：重跑 = 新 run） ---------- */
function createRun(agent_id, params, session_id, mode) {
  const run = {
    run_id: rid('r'),
    agent_id,
    session_id: session_id || null,
    user_id: 'local',
    status: 'pending',
    current_step: null,
    mode,
    params,
    steps: [],
    artifacts: [],
    result: null,
    error: null,
    created_at: Date.now(),
  };
  saveRun(run);
  return run;
}
function saveRun(run) {
  atomicWrite(path.join(DIRS.runs, run.run_id + '.json'), run);
}
function getRun(id) {
  const f = path.join(DIRS.runs, id + '.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
function listRuns(sessionId, limit = 30) {
  let runs = fs.readdirSync(DIRS.runs)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DIRS.runs, f), 'utf8')));
  if (sessionId) runs = runs.filter((r) => r.session_id === sessionId);
  return runs.sort((a, b) => b.created_at - a.created_at).slice(0, limit)
    .map((r) => ({ run_id: r.run_id, agent_id: r.agent_id, session_id: r.session_id, status: r.status, mode: r.mode, params: r.params, current_step: r.current_step, steps: r.steps.map((s) => ({ step_id: s.step_id, name: s.name, type: s.type, status: s.status, ms: s.ended_at && s.started_at ? s.ended_at - s.started_at : null })), artifact_count: r.artifacts.length, created_at: r.created_at }));
}
function cancelRun(id) {
  const run = getRun(id);
  if (!run) return null;
  if (['done', 'failed', 'canceled'].includes(run.status)) return run;
  run.status = 'canceled';
  run.error = '用户取消';
  const cur = run.steps.find((s) => ['running', 'pending', 'waiting_confirm'].includes(s.status));
  if (cur) { cur.status = 'canceled'; cur.detail = (cur.detail || '') + '（用户取消）'; }
  run.current_step = null;
  saveRun(run);
  return run;
}

/* ---------- Artifacts ---------- */
// type: markdown | json | csv（文本，content 落盘 exports/）| video | image（二进制，path 指向 data/runs/<run_id>/media/，meta 记录时长/尺寸等）
function saveArtifact(sessionId, runId, name, type, content, extra) {
  const a = {
    artifact_id: rid('a'),
    session_id: sessionId || null,
    run_id: runId || null,
    name,
    type, // markdown | json | csv | video | image
    path: null,
    content: null,
    meta: null,
    created_at: Date.now(),
  };
  if (type === 'video' || type === 'image') {
    // 二进制工件：文件已由媒体引擎落盘，这里只登记路径与元信息
    a.path = extra && extra.path;
    a.meta = (extra && extra.meta) || null;
  } else {
    const ext = type === 'csv' ? 'csv' : type === 'json' ? 'json' : 'md';
    const fname = `${Date.now()}_${name.replace(/[\\/:*?"<>| ]+/g, '_')}.${ext}`;
    const fpath = path.join(DIRS.exports, fname);
    fs.writeFileSync(fpath, type === 'csv' ? '\ufeff' + content : content, 'utf8');
    a.path = 'exports/' + fname;
    if (extra) a.extra_path = extra;
  }
  const idx = path.join(DATA, 'artifacts.json');
  const list = fs.existsSync(idx) ? JSON.parse(fs.readFileSync(idx, 'utf8')) : [];
  const brief = { artifact_id: a.artifact_id, session_id: a.session_id, run_id: a.run_id, name: a.name, type: a.type, path: a.path, meta: a.meta, created_at: a.created_at };
  list.push(brief);
  atomicWrite(idx, list.slice(-500));
  return a;
}
const artifactsIndex = () => (fs.existsSync(path.join(DATA, 'artifacts.json')) ? JSON.parse(fs.readFileSync(path.join(DATA, 'artifacts.json'), 'utf8')) : []);
function getArtifact(id) {
  return artifactsIndex().find((a) => a.artifact_id === id) || null;
}

module.exports = { ROOT, DIRS, rid, createSession, getSession, saveSession, listSessions, deleteSession, createRun, saveRun, getRun, listRuns, cancelRun, saveArtifact, getArtifact, artifactsIndex };
