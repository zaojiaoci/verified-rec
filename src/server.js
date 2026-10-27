#!/usr/bin/env node
/**
 * server.js — verified-rec MCP server（零依赖，stdio）。
 *
 * 传输：换行分隔的 JSON-RPC 2.0（MCP stdio 约定）。
 * 工具面五个：
 *   ledger_start / ledger_append / ledger_verify / ledger_replay / game_verify_rec
 *
 * 零 npm 依赖是有意的：npx 一行装进任何宿主（WorkBuddy / Claude Desktop /
 * Qoder / Trae），不需要安装链、不碰网络。协议手写 ~100 行，
 * 覆盖 initialize / tools/list / tools/call / ping 四个方法。
 */
import { createInterface } from 'node:readline';
import { startLedger, appendEntry, verifyLedger, replayLedger } from './ledger.js';
import { replayRecFile } from './game.js';

const SERVER_INFO = { name: 'verified-rec', version: '0.1.0' };
const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'ledger_start',
    description:
      'Start a new append-only hash-chained ledger file (.vrec). Each entry links to the previous one by hash; anyone can later verify the file was not tampered with. Fails if the file already exists (ledgers never overwrite).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path for the new ledger, e.g. ./work.vrec' },
        title: { type: 'string', description: 'What this ledger is for (recorded as the genesis entry note)' },
        actor: { type: 'string', description: 'Who is writing (agent/human name), default "agent"' },
      },
      required: ['path'],
    },
  },
  {
    name: 'ledger_append',
    description:
      'Append one entry to a ledger. Returns the new chain head. Verifies the existing chain first — you cannot append to a broken ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ledger file path' },
        action: { type: 'string', description: 'What happened, e.g. "deploy", "edit src/app.ts", "approve release"' },
        actor: { type: 'string', description: 'Who did it, default "agent"' },
        note: { type: 'string', description: 'Optional detail' },
      },
      required: ['path', 'action'],
    },
  },
  {
    name: 'ledger_verify',
    description:
      'Verify a ledger end-to-end: recompute every entry hash, check the links and sequence. Returns ok=true with the chain head, or the first broken line number and why.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ledger file path' } },
      required: ['path'],
    },
  },
  {
    name: 'ledger_replay',
    description:
      'Replay a ledger: list entries in order (optionally a seq range). Read-only; run ledger_verify to check integrity.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ledger file path' },
        from: { type: 'number', description: 'First seq to include (default 0)' },
        to: { type: 'number', description: 'Last seq to include (default end)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'game_verify_rec',
    description:
      'Replay a game .rec recording through versioned deterministic kernels and compute its chain head. With expectedHead this is an integrity check with three outcomes: "reproduced" (some registered kernel reproduces the head — authentic), "not-reproduced" (no registered kernel does — tampered, or from an unregistered game version), "premise-broken" (facts digest matches no kernel). Without expectedHead it proves the recording is replayable and reports its head plus the kernel version used. Old recordings verify against old kernels — kernel upgrades never falsify them.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '.rec recording file path' },
        expectedHead: { type: 'string', description: 'Optional: the claimed 64-hex chain head to check against' },
        kernelVersion: { type: 'string', description: 'Optional: verify with one specific registered kernel version (e.g. "0.1"); default tries all' },
      },
      required: ['path'],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function okResult(id, payload) {
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] } });
}

function toolError(id, err) {
  send({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: String(err && err.message ? err.message : err) }], isError: true },
  });
}

function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function callTool(name, args) {
  switch (name) {
    case 'ledger_start':
      return startLedger(args.path, { title: args.title || '', actor: args.actor || 'agent' });
    case 'ledger_append':
      return appendEntry(args.path, { action: args.action, actor: args.actor || 'agent', note: args.note || '' });
    case 'ledger_verify':
      return verifyLedger(args.path);
    case 'ledger_replay':
      return replayLedger(args.path, { from: args.from ?? 0, to: args.to ?? Infinity });
    case 'game_verify_rec':
      return replayRecFile(args.path, { expectedHead: args.expectedHead || null, kernelVersion: args.kernelVersion || null });
    default:
      throw new Error(`未知工具：${name}`);
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification（如 notifications/initialized）
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params && params.protocolVersion ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
      return;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    case 'tools/call': {
      try {
        const payload = await callTool(params.name, params.arguments || {});
        okResult(id, payload);
      } catch (e) {
        toolError(id, e);
      }
      return;
    }
    default:
      rpcError(id, -32601, `方法不存在：${method}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (_) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
    return;
  }
  handle(msg).catch((e) => {
    if (msg.id !== undefined) rpcError(msg.id, -32603, String(e && e.message));
  });
});
