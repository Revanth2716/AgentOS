#!/usr/bin/env node
/**
 * Minimal MCP stdio server fixture (newline-delimited JSON-RPC).
 * Implements initialize, tools/list, tools/call — enough to exercise
 * AgentOS MCP registration, discovery, and execution fully offline.
 */
import readline from 'node:readline';

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo text back to the caller.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'text to echo' } },
      required: ['text'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentos-fixture', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params ?? {};
    if (name === 'echo') {
      if (typeof args.text !== 'string' || args.text.length === 0) {
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'missing required argument: text' }], isError: true },
        });
        return;
      }
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${String(args.text)}` }] } });
      return;
    }
    if (name === 'add') {
      const sum = Number(args.a ?? 0) + Number(args.b ?? 0);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(sum) }] } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true },
    });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handle(JSON.parse(trimmed));
  } catch (e) {
    // ignore malformed lines
    void e;
  }
});
rl.on('close', () => process.exit(0));
