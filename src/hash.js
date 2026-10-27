/**
 * hash.js — 逐环摘要。sha256（node:crypto，零依赖）。
 *
 * 与游戏内核 ledger crate 的 HashChain 同构：
 *   链头 = H(上一环 || 本环 canonical 字节)
 * 区别一处：游戏内核用四巷道 FNV-1a（纯整数、跨平台确定，防的是意外漂移）；
 * 这里是独立审计账本，对抗面包含「人改文件」⇒ 直接上 sha256。
 */
import { createHash } from 'node:crypto';

export const ZERO_HASH = '0'.repeat(64);

/** 条目的 canonical 编码：定长顺序数组的 JSON——字段边界无歧义、
 *  与序列化实现无关（数组元素个数与顺序即 schema）。 */
export function entryBytes({ seq, ts, actor, action, note, prev }) {
  return JSON.stringify([seq, ts, actor, action, note, prev]);
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 条目哈希 = sha256(canonical 字节)。 */
export function entryHash(fields) {
  return sha256Hex(entryBytes(fields));
}
