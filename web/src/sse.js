// SSE 工具：POST + event-stream 解析
export async function ssePost(url, body, handlers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch (_) {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      let event = 'message', data = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (!data) continue;
      try { handlers[event]?.(JSON.parse(data)); } catch (_) {}
    }
  }
}
