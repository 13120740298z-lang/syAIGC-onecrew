import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ssePost } from './sse.js';

/* ---------- 小组件 ---------- */

const STEP_ICON = { pending: '○', running: '◍', done: '●', failed: '✕', canceled: '⃠', waiting_confirm: '⏸' };

function StatusChip({ status }) {
  const map = {
    running: ['执行中', 'c-running'], done: ['已完成', 'c-done'], failed: ['失败', 'c-fail'],
    canceled: ['已取消', 'c-cancel'], waiting_confirm: ['等待确认', 'c-wait'], pending: ['排队中', 'c-pending'],
  };
  const [t, cls] = map[status] || [status, ''];
  return <span className={'chip ' + cls}>{t}</span>;
}

function RunCard({ run, onConfirm, onCancel, onRetry }) {
  const live = run.status === 'running' || run.status === 'pending';
  return (
    <div className="run-card">
      <div className="run-head">
        <b>{run.agent_id === 'onecrew' ? '🚢 出海内容包工作流' : '⚡ 即席技能'}</b>
        <StatusChip status={run.status} />
        <span className="muted run-mode">{run.mode === 'real' ? '真实模型' : run.mode === 'mock-fallback' ? '降级演示' : '演示模式'}</span>
      </div>
      {run.params && <div className="run-params muted">产品：{run.params.product}{run.params.market ? ` · 市场：${run.params.market}` : ''}</div>}
      <div className="run-steps">
        {(run.steps || []).map((s, i) => (
          <div key={s.step_id} className={'step st-' + s.status}>
            <span className="step-ico">{STEP_ICON[s.status] || '○'}</span>
            <span className="step-name">{s.name}</span>
            {s.detail && s.status !== 'pending' && <span className="step-detail muted">{s.detail}</span>}
            {s.status === 'waiting_confirm' && run.status === 'waiting_confirm' && (
              <div className="confirm-row">
                <button className="btn btn-primary btn-sm" onClick={() => onConfirm(run.run_id, true)}>✓ 批准，继续执行</button>
                <button className="btn btn-ghost btn-sm" onClick={() => onConfirm(run.run_id, false)}>✕ 驳回终止</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {(live || run.status === 'waiting_confirm') && (
        <div className="run-ops">
          <button className="btn btn-ghost btn-sm" onClick={() => onCancel(run.run_id)}>停止</button>
        </div>
      )}
      {(run.status === 'failed' || run.status === 'canceled') && (
        <div className="run-ops">
          <button className="btn btn-ghost btn-sm" onClick={() => onRetry(run.run_id)}>↻ 重跑（生成新记录）</button>
        </div>
      )}
    </div>
  );
}

function ArtifactRow({ a, onPreview }) {
  const icon = a.type === 'csv' ? '📊' : a.type === 'json' ? '🧩' : a.type === 'image' ? '🖼️' : a.type === 'video' ? '🎬' : '📄';
  return (
    <div className="artifact-row" onClick={() => onPreview(a.artifact_id)}>
      <span>{icon}</span>
      <span className="artifact-name">{a.name}</span>
      <span className="muted">{a.type.toUpperCase()}</span>
      <a className="dl" href={`/api/artifacts/${a.artifact_id}/download`} onClick={(e) => e.stopPropagation()} title="下载">⬇</a>
    </div>
  );
}

function PreviewModal({ artifactId, onClose }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch(`/api/artifacts/${artifactId}`).then((r) => r.json()).then(setData).catch(() => setData({ name: '加载失败', content: '' }));
  }, [artifactId]);
  if (!data) return null;
  const isImage = data.type === 'image';
  const isVideo = data.type === 'video';
  const rawUrl = `/api/artifacts/${data.artifact_id}/raw`;
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{data.name}</b>
          <span className="muted">{data.type?.toUpperCase()}</span>
          <a className="btn btn-ghost btn-sm" href={`/api/artifacts/${data.artifact_id}/download`}>⬇ 下载</a>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>关闭</button>
        </div>
        <div className="modal-body">
          {isImage && <img className="media-view" src={rawUrl} alt={data.name} />}
          {isVideo && <video className="media-view" src={rawUrl} controls autoPlay loop playsInline />}
          {!isImage && !isVideo && (data.type === 'markdown'
            ? <Markdown remarkPlugins={[remarkGfm]}>{data.content}</Markdown>
            : <pre className="codeblock">{data.content}</pre>)}
        </div>
      </div>
    </div>
  );
}

/* ---------- 主应用 ---------- */

const EXAMPLES = [
  { icon: '🚢', text: '我的产品是智能保温杯，316不锈钢12小时保温，想卖日本，帮我出全套出海内容' },
  { icon: '🔍', text: '帮我做一次北美市场的快研，产品是宠物智能喂食器' },
  { icon: '🎙️', text: '给我的手作银饰品牌定一个声音档案和口号' },
  { icon: '🎨', text: '为露营氛围灯生成 Midjourney 和即梦的提示词' },
];

export default function App() {
  const [health, setHealth] = useState(null);
  const [skills, setSkills] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [runsMap, setRunsMap] = useState({});
  const [artifacts, setArtifacts] = useState([]);
  const [previewId, setPreviewId] = useState(null);
  const [tab, setTab] = useState('runs');
  const chatEndRef = useRef(null);
  const streamBufRef = useRef('');
  const msgIdRef = useRef(null);
  const sessionIdRef = useRef(null);

  const loadSessions = () => fetch('/api/sessions').then((r) => r.json()).then(setSessions);
  const loadArtifacts = (sid) => fetch('/api/artifacts?session_id=' + (sid || '')).then((r) => r.json()).then(setArtifacts);
  const loadRuns = (sid) => {
    if (!sid) return;
    fetch('/api/runs?session_id=' + sid).then((r) => r.json()).then((list) => {
      setRunsMap((prev) => {
        const next = { ...prev };
        for (const b of list) if (!next[b.run_id] || !['running', 'waiting_confirm'].includes(next[b.run_id]?.status)) next[b.run_id] = b;
        return next;
      });
    });
  };

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth);
    fetch('/api/skills').then((r) => r.json()).then(setSkills);
    loadSessions();
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const openSession = async (id) => {
    setSessionId(id);
    sessionIdRef.current = id;
    const s = await fetch('/api/sessions/' + id).then((r) => r.json());
    setMessages(s.messages || []);
    setRunsMap({});
    loadRuns(id);
    loadArtifacts(id);
  };
  const newSession = () => { setSessionId(null); sessionIdRef.current = null; setMessages([]); setRunsMap({}); setArtifacts([]); };

  const deleteSession = async (e, id) => {
    e.stopPropagation();
    await fetch('/api/sessions/' + id, { method: 'DELETE' });
    if (id === sessionId) newSession();
    loadSessions();
  };

  /* SSE 事件统一处理 */
  const makeHandlers = () => ({
    start: ({ message_id }) => { msgIdRef.current = message_id; },
    token: ({ message_id, delta }) => {
      streamBufRef.current += delta;
      const buf = streamBufRef.current, mid = message_id || msgIdRef.current;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === mid);
        if (idx >= 0) { const next = [...prev]; next[idx] = { ...next[idx], content: buf }; return next; }
        // 服务端消息（如工作流启动语）：优先填充末尾的空占位气泡
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant' && !last.content && !last.run_id) {
          const next = [...prev.slice(0, -1), { ...last, id: mid, content: buf }];
          return next;
        }
        return [...prev, { id: mid, role: 'assistant', content: buf }];
      });
    },
    run: (brief) => {
      setRunsMap((prev) => ({ ...prev, [brief.run_id]: { ...prev[brief.run_id], ...brief } }));
      if (brief.message_id) msgIdRef.current = brief.message_id;
      setTab('runs');
    },
    step: (e) => {
      setRunsMap((prev) => {
        const run = prev[e.run_id];
        if (!run) return prev;
        if (!e.step_id) return prev; // 无步骤归属的事件（如整体取消提示）不改步骤表
        const steps = [...(run.steps || [])];
        const i = steps.findIndex((s) => s.step_id === e.step_id);
        const patch = { ...e };
        if (i >= 0) steps[i] = { ...steps[i], ...patch };
        else steps.push(patch);
        const status = e.status === 'waiting_confirm' ? 'waiting_confirm' : run.status;
        return { ...prev, [e.run_id]: { ...run, steps, current_step: e.step_id, status } };
      });
    },
    artifact: (a) => {
      setRunsMap((prev) => {
        const run = prev[a.run_id];
        if (!run) return prev;
        if ((run.artifacts || []).some((x) => x.artifact_id === a.artifact_id)) return prev;
        return { ...prev, [a.run_id]: { ...run, artifacts: [...(run.artifacts || []), { artifact_id: a.artifact_id, name: a.name, type: a.type }] } };
      });
      const sid = sessionIdRef.current;
      if (sid || a.run_id) {
        // 会话内工件即时刷新；跨会话由 loadSessions 后的加载兜底
        const target = sid || null;
        fetch('/api/artifacts' + (target ? '?session_id=' + target : '')).then((r) => r.json()).then(setArtifacts).catch(() => {});
      }
    },
    done: ({ run_id, status }) => {
      if (run_id) setRunsMap((prev) => (prev[run_id] ? { ...prev, [run_id]: { ...prev[run_id], status } } : prev));
      streamBufRef.current = '';
    },
    error: ({ run_id, message }) => {
      if (run_id) setRunsMap((prev) => (prev[run_id] ? { ...prev, [run_id]: { ...prev[run_id], status: 'failed' } } : prev));
      streamBufRef.current = '';
      setMessages((prev) => [...prev, { id: 'err_' + Date.now(), role: 'assistant', content: '⚠️ ' + message }]);
    },
  });

  const send = async (text) => {
    text = (text || input).trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    streamBufRef.current = '';
    msgIdRef.current = null;
    setMessages((prev) => [...prev, { id: 'u_' + Date.now(), role: 'user', content: text }]);
    const placeholder = { id: 'a_' + Date.now(), role: 'assistant', content: '' };
    setMessages((prev) => [...prev, placeholder]);
    try {
      await ssePost('/api/chat', { session_id: sessionId, message: text }, makeHandlers());
    } catch (e) {
      setMessages((prev) => [...prev.slice(0, -1), { id: 'err_' + Date.now(), role: 'assistant', content: '⚠️ 连接失败：' + e.message }]);
    }
    setBusy(false);
    loadSessions();
    if (!sessionId) { /* 首条消息后服务端已建会话 */ fetch('/api/sessions').then((r) => r.json()).then((list) => { if (list[0]) { setSessionId(list[0].session_id); sessionIdRef.current = list[0].session_id; loadRuns(list[0].session_id); loadArtifacts(list[0].session_id); } }); }
  };

  const runSkill = async (skill) => {
    const template = skill.input_schema.market
      ? `请执行「${skill.name}」：产品是____，目标市场是____`
      : `请执行「${skill.name}」：产品是____`;
    setInput(template);
    document.getElementById('chat-input')?.focus();
  };

  const onConfirm = async (runId, approve) => {
    setBusy(true);
    try { await ssePost(`/api/runs/${runId}/confirm`, { approve }, makeHandlers()); } catch (e) { console.warn(e); }
    setBusy(false);
  };
  const onCancel = async (runId) => {
    await fetch(`/api/runs/${runId}/cancel`, { method: 'POST' });
    const r = await fetch(`/api/runs/${runId}`).then((x) => x.json());
    setRunsMap((prev) => ({ ...prev, [runId]: r }));
  };
  const onRetry = async (runId) => {
    setBusy(true);
    try { await ssePost(`/api/runs/${runId}/retry`, {}, makeHandlers()); } catch (e) { console.warn(e); }
    setBusy(false);
  };

  const runsForSession = Object.values(runsMap).filter((r) => !sessionId || r.session_id === sessionId)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, 20);
  const artifactsList = artifacts.filter((a) => !sessionId || a.session_id === sessionId);

  return (
    <div className="app">
      {/* 左栏 */}
      <aside className="sidebar">
        <div className="logo">
          <span className="logo-mark">🌊</span>
          <div>
            <div className="logo-name">OneCrew</div>
            <div className="logo-sub">一人出海 · AIGC 内容官</div>
          </div>
        </div>
        <button className="btn btn-primary btn-block" onClick={newSession}>＋ 新对话</button>
        <div className="side-label">会话</div>
        <div className="session-list">
          {sessions.map((s) => (
            <div key={s.session_id} className={'session-item' + (s.session_id === sessionId ? ' active' : '')} onClick={() => openSession(s.session_id)}>
              <span className="session-title">{s.title}</span>
              <button className="session-del" onClick={(e) => deleteSession(e, s.session_id)} title="删除">✕</button>
            </div>
          ))}
          {!sessions.length && <div className="muted pad8">暂无会话</div>}
        </div>
        <div className="side-label">技能（点卡片快速发起）</div>
        <div className="skill-list">
          {skills.map((s) => (
            <div key={s.skill_id} className="skill-card" onClick={() => runSkill(s)} title={s.description}>
              <span className="skill-ico">{s.icon}</span>
              <span>{s.name}</span>
            </div>
          ))}
        </div>
        <div className="side-foot muted">
          {health && (health.mode === 'real'
            ? <>● 真实模型 <b>{health.model}</b></>
            : <>○ 演示模式（未配置模型 Key）</>)}
        </div>
      </aside>

      {/* 中栏 对话 */}
      <main className="chat">
        <header className="chat-head">
          <b>OneCrew 出海内容官</b>
          <span className="chip c-agent">Wave 3 · Agents</span>
          {health && <span className={'chip ' + (health.mode === 'real' ? 'c-done' : 'c-wait')}>{health.mode === 'real' ? '真实模型' : '演示模式'}</span>}
        </header>
        <div className="msgs">
          {!messages.length && (
            <div className="welcome">
              <div className="welcome-logo">🌊</div>
              <h1>一个人，一支内容小队</h1>
              <p>把产品讲给我听，八位 AI 队友接力完成：市场快研 → 人工确认 → 品牌声音 → 五平台文案 → 图像提示词 → <b>视觉工坊（AI 真出图 ×4）</b> → <b>短片导演（15 秒带货成片）</b> → 内容日历 → 合规体检。上游成果自动接力下游，全程步骤可视、可停、可复核。</p>
              <div className="examples">
                {EXAMPLES.map((e, i) => (
                  <div key={i} className="example-card" onClick={() => send(e.text)}>
                    <span className="ex-ico">{e.icon}</span>{e.text}
                  </div>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={'msg ' + m.role}>
              <div className="bubble">
                {m.role === 'assistant' ? <Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown> : m.content}
              </div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>
        <div className="input-bar">
          <textarea
            id="chat-input"
            value={input}
            placeholder="描述你的产品，例如：我的产品是XX，想卖XX…（Enter 发送 / Shift+Enter 换行）"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            rows={2}
          />
          <button className="btn btn-primary send-btn" disabled={busy || !input.trim()} onClick={() => send()}>{busy ? '…' : '发送'}</button>
        </div>
      </main>

      {/* 右栏 工作台 */}
      <aside className="workbench">
        <div className="wb-tabs">
          <button className={'wb-tab' + (tab === 'runs' ? ' on' : '')} onClick={() => setTab('runs')}>运行</button>
          <button className={'wb-tab' + (tab === 'artifacts' ? ' on' : '')} onClick={() => setTab('artifacts')}>工件 ({artifactsList.length})</button>
        </div>
        <div className="wb-body">
          {tab === 'runs' && (
            runsForSession.length ? runsForSession.map((r) => (
              <RunCard key={r.run_id} run={r} onConfirm={onConfirm} onCancel={onCancel} onRetry={onRetry} />
            )) : <div className="muted pad8">暂无运行记录。发起对话或点技能卡即可看到步骤级进度。</div>
          )}
          {tab === 'artifacts' && (
            artifactsList.length ? artifactsList.map((a) => <ArtifactRow key={a.artifact_id} a={a} onPreview={setPreviewId} />)
              : <div className="muted pad8">暂无工件。运行完成后产物会落在这里，可预览、可下载（图片/视频/CSV/MD/JSON）。</div>
          )}
        </div>
      </aside>

      {previewId && <PreviewModal artifactId={previewId} onClose={() => setPreviewId(null)} />}
    </div>
  );
}
