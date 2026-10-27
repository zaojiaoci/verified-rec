// verified-rec 判据：账本防篡改 + 游戏重放链头 + MCP 协议面。
// 跑法：node test/verify.mjs（零依赖，node >= 18）。
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startLedger, appendEntry, verifyLedger, replayLedger } from '../src/ledger.js';
import { recordSession, replayRec } from '../src/game.js';

let pass = 0;
let fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) {
    pass++;
    console.log('PASS:', name);
  } else {
    fail++;
    console.log('FAIL:', name, detail);
  }
};

const dir = mkdtempSync(join(tmpdir(), 'vrec-'));
const P = (f) => join(dir, f);

// ---------------------------------------------------------------- 账本

const led = P('work.vrec');
const started = startLedger(led, { title: '发布 v1.0', actor: 'agent' });
ok(/^[0-9a-f]{64}$/.test(started.head), '① 创世环落盘，链头是 64 位 hex');

let v = verifyLedger(led);
ok(v.ok && v.entries === 1, '② 创世账本自校验通过', JSON.stringify(v));

const h1 = appendEntry(led, { action: 'edit src/app.ts', actor: 'agent', note: '修按钮' }).head;
const h2 = appendEntry(led, { action: 'run tests', actor: 'agent' }).head;
appendEntry(led, { action: 'deploy', actor: 'human:zaojiaoci', note: '批准上线' });
v = verifyLedger(led);
ok(v.ok && v.entries === 4 && v.head && h1 !== h2, '③ 三环追加后校验通过，链头逐环推进', JSON.stringify(v));

const r = replayLedger(led);
ok(
  r.entries.length === 4 && r.entries[0].action === 'begin' && r.entries[3].action === 'deploy',
  '④ 重放按序吐环（begin → … → deploy）',
);

// 篡改：改中间一环的 note，hash 重算必须抓到。
const lines = readFileSync(led, 'utf8').split('\n');
const mid = JSON.parse(lines[1]);
mid.note = '修按钮（改过）';
lines[1] = JSON.stringify(mid);
writeFileSync(led, lines.join('\n'));
v = verifyLedger(led);
ok(!v.ok && v.brokenAt === 2 && /hash 重算不等/.test(v.reason), '⑤ 篡改一行 → 第 2 行断链', JSON.stringify(v));

// 断链后拒绝记新账。
let refused = false;
try {
  appendEntry(led, { action: 'sneak' });
} catch (e) {
  refused = /断链/.test(String(e.message));
}
ok(refused, '⑥ 断链账本拒绝追加（先修账再记账）');

// 换位：把第 3、4 环对调 ⇒ prev 断链。
const l2 = readFileSync(led, 'utf8').split('\n').filter(Boolean);
const fixed = l2.map((l, i) => {
  if (i !== 1) return l;
  const o = JSON.parse(l);
  o.note = '修按钮'; // 还原
  return JSON.stringify(o);
});
const swapped = [fixed[0], fixed[1], fixed[3], fixed[2]].join('\n') + '\n';
writeFileSync(P('swap.vrec'), swapped);
v = verifyLedger(P('swap.vrec'));
ok(!v.ok, '⑦ 环换位 → 断链', JSON.stringify(v));

// 覆盖保护。
let noOverwrite = false;
try {
  startLedger(led, { title: 'x' });
} catch (e) {
  noOverwrite = /已存在/.test(String(e.message));
}
ok(noOverwrite, '⑧ start 拒绝覆盖已有账本');

// ---------------------------------------------------------------- 游戏重放

const frames = [
  { frame: 1, tokens: '' },
  { frame: 2, tokens: 'N' },
  { frame: 3, tokens: 'N' },
  { frame: 4, tokens: 'N' },
  { frame: 5, tokens: 'I8' },
  { frame: 6, tokens: 'N' },
];
const sess = await recordSession('micro', frames, 42);
writeFileSync(P('play.rec'), sess.text);

let rep = await replayRec(sess.text);
ok(rep.ok && rep.pool === 'micro' && rep.head === sess.head, '⑨ micro 录制重放：链头逐帧同源', JSON.stringify(rep));
// micro 录制的头行写 v2（游戏 buildRec 的行为：MICRO||V2 ⇒ v2）——链路判别以
// facts_digest 为准，头行只是标签，所以 tagMismatch=true 是**预期**的互证警告。
ok(rep.frames === 6 && rep.tagMismatch === true, '⑩ 帧数正确 + 头行标签与摘要互证（micro 头写 v2 被点名）');

rep = await replayRec(sess.text, { expectedHead: sess.head });
ok(rep.ok && rep.headMatches, '⑪ 给定期望链头 → 完整性校验通过');

rep = await replayRec(sess.text, { expectedHead: '0'.repeat(64) });
ok(!rep.ok && rep.headMatches === false, '⑫ 期望链头不符 → 报不等（改一个 token 就换头）');

const tampered = sess.text.replace('f=5 I8', 'f=5 I1');
rep = await replayRec(tampered, { expectedHead: sess.head });
ok(!rep.ok && rep.head !== sess.head, '⑬ 输入流被改 → 链头漂移被抓住', `head=${rep.head}`);

const sess2 = await recordSession('v2', [{ frame: 1, tokens: '' }, { frame: 2, tokens: 'N' }], 7);
rep = await replayRec(sess2.text);
ok(rep.ok && rep.pool === 'v2', '⑭ v2 录制按 facts_digest 判别链路', JSON.stringify(rep));

let badRec = false;
try {
  await replayRec('not a recording\n');
} catch (e) {
  badRec = /不是切片录制文件/.test(String(e.message));
}
ok(badRec, '⑮ 非录制文件被拒');

// ---------------------------------------------------------------- MCP 协议面

function mcpSession(calls) {
  return new Promise((resolve) => {
    const child = spawn('node', [new URL('../src/server.js', import.meta.url).pathname], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const out = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) out.push(JSON.parse(line));
        if (out.length >= calls.length) {
          child.kill();
          resolve(out);
        }
      }
    });
    for (const c of calls) child.stdin.write(JSON.stringify(c) + '\n');
    setTimeout(() => {
      child.kill();
      resolve(out);
    }, 8000);
  });
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const results = await mcpSession([
  rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }),
  rpc(2, 'tools/list', {}),
  rpc(3, 'tools/call', { name: 'ledger_start', arguments: { path: P('mcp.vrec'), title: 'via MCP' } }),
  rpc(4, 'tools/call', { name: 'ledger_append', arguments: { path: P('mcp.vrec'), action: 'hello' } }),
  rpc(5, 'tools/call', { name: 'ledger_verify', arguments: { path: P('mcp.vrec') } }),
  rpc(6, 'tools/call', { name: 'game_verify_rec', arguments: { path: P('play.rec'), expectedHead: sess.head } }),
]);
const byId = Object.fromEntries(results.map((m) => [m.id, m]));
ok(byId[1]?.result?.serverInfo?.name === 'verified-rec', '⑯ initialize 握手');
ok((byId[2]?.result?.tools || []).length === 5, '⑰ tools/list 五个工具');
const t3 = JSON.parse(byId[3]?.result?.content?.[0]?.text || '{}');
const t5 = JSON.parse(byId[5]?.result?.content?.[0]?.text || '{}');
ok(t3.head && t5.ok && t5.entries === 2, '⑱ MCP 三连：start → append → verify', JSON.stringify(t5));
const t6 = JSON.parse(byId[6]?.result?.content?.[0]?.text || '{}');
ok(t6.ok && t6.head === sess.head, '⑲ MCP game_verify_rec 完整性校验', JSON.stringify(t6));

rmSync(dir, { recursive: true, force: true });
console.log(`\nverified-rec 判据：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
