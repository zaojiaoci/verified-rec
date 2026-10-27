/**
 * ledger.js — 追加式哈希账本（.vrec，行式 JSONL）。
 *
 * 一环一条：{ seq, ts, actor, action, note, prev, hash }
 *   - hash = sha256(canonical)（见 hash.js）
 *   - prev = 上一环的 hash；创世环 prev = 64 个 0
 *   - seq 从 0 起逐环 +1
 *
 * 校验是全量重算：任何一个字段被改过、任何一环被插/删/换位，
 * 第一处断链的行号会被报出来。检测面是**意外与人为修改**；
 * 对抗性重算整条链 + 伪造头（“账本自己说自己是真的”）防不了——
 * 那要把链头登记到外部（git 提交 / 公开贴文），让事后改账无处遁形。
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { entryHash, ZERO_HASH } from './hash.js';

const HEAD_ZERO = ZERO_HASH;

function parseLedger(text) {
  const lines = text.split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (_) {
      throw Object.assign(new Error(`第 ${i + 1} 行：不是合法 JSON`), { brokenAt: i + 1 });
    }
    entries.push({ line: i + 1, ...obj });
  }
  if (entries.length === 0) throw Object.assign(new Error('账本为空'), { brokenAt: 0 });
  return entries;
}

/** 全量校验：哈希重算 + 环环相扣 + 序号连续。 */
export function verifyLedger(path) {
  const entries = parseLedger(readFileSync(path, 'utf8'));
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const fields = { seq: e.seq, ts: e.ts, actor: e.actor, action: e.action, note: e.note, prev: e.prev };
    const expectPrev = i === 0 ? HEAD_ZERO : entries[i - 1].hash;
    if (e.seq !== i) {
      return { ok: false, entries: entries.length, brokenAt: e.line, reason: `seq 应为 ${i}，实为 ${e.seq}`, head: entries[entries.length - 1].hash };
    }
    if (e.prev !== expectPrev) {
      return { ok: false, entries: entries.length, brokenAt: e.line, reason: `prev 不等于上一环 hash（环在第 ${e.line} 行断开）`, head: entries[entries.length - 1].hash };
    }
    const h = entryHash(fields);
    if (h !== e.hash) {
      return { ok: false, entries: entries.length, brokenAt: e.line, reason: `第 ${e.line} 行的 hash 重算不等——这一环被人动过`, head: entries[entries.length - 1].hash };
    }
  }
  return {
    ok: true,
    entries: entries.length,
    head: entries[entries.length - 1].hash,
    brokenAt: null,
    reason: null,
  };
}

/** 建账本：写创世环。文件已存在则拒绝（不覆盖别人的账）。 */
export function startLedger(path, { title = '', actor = 'agent' } = {}) {
  if (existsSync(path)) {
    throw new Error(`文件已存在：${path}（账本不覆盖旧账，换一个路径）`);
  }
  const fields = {
    seq: 0,
    ts: new Date().toISOString(),
    actor,
    action: 'begin',
    note: title,
    prev: HEAD_ZERO,
  };
  const entry = { ...fields, hash: entryHash(fields) };
  writeFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  return { path, seq: 0, head: entry.hash, title, actor };
}

/** 追加一环：读尾环 → 接 hash → 落盘。 */
export function appendEntry(path, { action, actor = 'agent', note = '' }) {
  if (!existsSync(path)) throw new Error(`文件不存在：${path}`);
  const check = verifyLedger(path);
  if (!check.ok) {
    throw new Error(`账本已断链（第 ${check.brokenAt} 行）：${check.reason}——先修账再记新账`);
  }
  const entries = parseLedger(readFileSync(path, 'utf8'));
  const last = entries[entries.length - 1];
  const fields = {
    seq: last.seq + 1,
    ts: new Date().toISOString(),
    actor,
    action,
    note,
    prev: last.hash,
  };
  const entry = { ...fields, hash: entryHash(fields) };
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  return { path, seq: entry.seq, head: entry.hash };
}

/** 重放：按环吐回（可切片）。只读，不校验——校验走 verifyLedger。 */
export function replayLedger(path, { from = 0, to = Infinity } = {}) {
  const entries = parseLedger(readFileSync(path, 'utf8'));
  const out = entries.filter((e) => e.seq >= from && e.seq <= to).map((e) => ({
    seq: e.seq,
    ts: e.ts,
    actor: e.actor,
    action: e.action,
    note: e.note,
    prev: e.prev,
    hash: e.hash,
    line: e.line,
  }));
  return {
    entries: out,
    total: entries.length,
    head: entries[entries.length - 1].hash,
  };
}
