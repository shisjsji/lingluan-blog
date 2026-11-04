#!/usr/bin/env node
// 神经元 MCP 服务端（stdio）
// 让 MiMo 智能体能在对话中把片段写进神经元网络，也能检索过去想过什么。
// 手写 JSON-RPC，不依赖任何 npm 包。
import readline from 'node:readline';

const API = process.env.NEURAL_API || 'https://lingluandf.online/neural-api';
const TOKEN = (process.env.NEURAL_TOKEN || '').trim();

if (!TOKEN) {
  process.stderr.write('缺少 NEURAL_TOKEN 环境变量\n');
  process.exit(1);
}

const TOOLS = [
  {
    name: 'memory_load',
    description:
      '加载某个项目的长期记忆：进度做到哪、踩过哪些坑、做过什么决定、有哪些可复用的窍门。接手一个项目、或用户说「继续上次」「我们做到哪了」「读取知识库」时，先调用这个，拿到上下文再动手。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目标识，例如 lingluan-blog、neural-memory、chaoxing-ai' },
      },
      required: ['project'],
    },
  },
  {
    name: 'memory_save',
    description:
      '把这次工作的成果写回项目记忆，供以后的会话加载。一个阶段做完、踩到坑、做出取舍时调用。只写结论和方法，不要写过程流水账。同名条目会被更新而不是重复添加。',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '要写入的条目，可批量提交',
          items: {
            type: 'object',
            properties: {
              project: { type: 'string', description: '项目标识' },
              kind: {
                type: 'string',
                enum: ['progress', 'pitfall', 'insight', 'decision', 'output'],
                description: 'progress=进度、pitfall=踩过的坑、insight=窍门、decision=做过的取舍、output=交付物',
              },
              title: { type: 'string', description: '一句话标题，不超过 40 字' },
              body: { type: 'string', description: '具体内容：现象、原因、结论或做法' },
              tags: { type: 'array', items: { type: 'string' }, description: '主题标签' },
              status: { type: 'string', enum: ['active', 'done', 'dropped'], description: 'active=仍在生效，done=已完成，dropped=已废弃' },
            },
            required: ['project', 'kind', 'title', 'body'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'neural_record',
    description:
      '把一个思考片段记进用户的神经元网络。当对话产生了有价值的结论、决定、排查过程或新认知时调用。只写摘要与标签，不要写原文、个人信息或密钥。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话标题，不超过 40 字' },
        summary: { type: 'string', description: '一到两句总结，说明结论或结果' },
        tags: { type: 'array', items: { type: 'string' }, description: '两到四个主题标签，用于和其他神经元连边' },
        sessionId: { type: 'string', description: '本次会话的标识，同一会话的片段会连成一条时间链' },
        kind: { type: 'string', enum: ['dialog', 'tool', 'note', 'insight'], description: '片段类型' },
        weight: { type: 'number', description: '重要性 0.3-3，越大节点越显眼' },
      },
      required: ['title'],
    },
  },
  {
    name: 'neural_search',
    description: '在用户的神经元网络里检索过去记录过的片段，用于回忆之前讨论过什么、做过什么决定。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '关键词，会匹配标题、摘要和标签' },
        tag: { type: 'string', description: '按标签精确过滤' },
        limit: { type: 'number', description: '返回条数，默认 10' },
      },
    },
  },
  {
    name: 'neural_stats',
    description: '查看神经元网络的规模、今天的活跃度和最常用的标签。',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callApi(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    // 服务器不响应时不能把对话挂死
    signal: AbortSignal.timeout(15000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function handleTool(name, args) {
  if (name === 'memory_load') {
    const project = String(args.project || '').trim();
    if (!project) throw new Error('需要 project 参数');
    const d = await callApi(`/brief?project=${encodeURIComponent(project)}`);
    if (!d.total) return `项目「${project}」还没有存过任何记忆。`;

    const label = { progress: '进度', pitfall: '踩过的坑', insight: '窍门', decision: '做过的取舍', output: '交付物' };
    const lines = [`项目 ${project}｜${d.total} 条｜最后更新 ${String(d.lastActive).slice(0, 16).replace('T', ' ')}`];
    for (const kind of ['progress', 'decision', 'pitfall', 'insight', 'output']) {
      const list = d[kind] || [];
      if (!list.length) continue;
      lines.push('', `【${label[kind]}】`);
      for (const item of list) {
        const flag = item.status === 'done' ? '（已完成）' : item.status === 'dropped' ? '（已废弃）' : '';
        lines.push(`- ${item.title}${flag}\n  ${item.body}`);
      }
    }
    return lines.join('\n');
  }

  if (name === 'memory_save') {
    const items = Array.isArray(args.items) ? args.items : [args];
    const d = await callApi('/knowledge', { method: 'POST', body: JSON.stringify(items) });
    return `已写入 ${d.saved} 条项目记忆。`;
  }

  if (name === 'neural_record') {
    const data = await callApi('/record', { method: 'POST', body: JSON.stringify(args) });
    const tags = (data.node?.tags || []).join('、') || '无';
    const links = (data.edges || []).length;
    return `已写入神经元「${data.node.title}」，标签 ${tags}，新织出 ${links} 条突触。`;
  }

  if (name === 'neural_search') {
    const data = await callApi('/search', { method: 'POST', body: JSON.stringify(args) });
    if (!data.nodes.length) return '没有找到匹配的神经元。';
    const lines = data.nodes.map((n) => {
      const date = n.createdAt.slice(0, 10);
      return `- ${date} ${n.title}${n.summary ? '：' + n.summary : ''} [${n.tags.join('、')}]`;
    });
    return `找到 ${data.nodes.length} 条：\n${lines.join('\n')}`;
  }

  if (name === 'neural_stats') {
    const s = await callApi('/stats');
    const tags = (s.topTags || []).map((t) => `${t.name}(${t.count})`).join('、');
    return `神经元 ${s.total} 个，突触 ${s.edges} 条，今日新增 ${s.today}，参与会话 ${s.sessions} 次。常用标签：${tags}`;
  }

  throw new Error(`未知工具：${name}`);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

// 未完成的调用计数，全部结束后才允许退出
let pending = 0;
let closed = false;
const maybeExit = () => {
  if (closed && pending === 0) process.exit(0);
};

rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  let req;
  try {
    req = JSON.parse(text);
  } catch {
    return;
  }

  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'neural-memory', version: '1.0.0' },
      },
    });
    return;
  }

  if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
    return;
  }

  if (req.method === 'tools/call') {
    const { name, arguments: args } = req.params || {};
    pending += 1;
    try {
      const content = await handleTool(name, args || {});
      send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: content }] } });
    } catch (err) {
      send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: `失败：${err.message}` }], isError: true } });
    } finally {
      pending -= 1;
      maybeExit();
    }
    return;
  }

  if (req.method === 'ping') {
    send({ jsonrpc: '2.0', id: req.id, result: {} });
    return;
  }

  // 通知类消息（notifications/initialized 等）不需要响应
  if (req.id !== undefined) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } });
  }
});

rl.on('close', () => { closed = true; maybeExit(); });