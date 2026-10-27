/**
 * game.js — 游戏内核驱动：重放 `.rec` 录制，算出链头。
 *
 * 内核是版本化留档的编译产物（kernel/kernel-asm-<ver>.js，出生证明见
 * PROVENANCE.md）。这里只用四样导出：
 *   sim_new / sim_new_v2 / sim_new_micro、sim_tick、sim_digests、frame_buf。
 *
 * 链头语义与游戏 ledger crate 一致：每一帧 `state_hash` =
 * H(上一环 || 帧号 || 本帧 canonical 状态)，**末帧的 state_hash 就是链头**。
 * `.rec` 只记输入流不记逐帧哈希 ⇒ 不给期望链头时，本工具证明的是
 * 「这份输入流可重放、产出这个头」；给了期望链头才是完整性校验。
 *
 * 三态报告（v0.2 起）：「真」不是「用最新内核重放得对」，而是
 * 「用某个已登记版本的内核重放得对」——篡改 = 所有登记内核都算不出
 * 期望链头；真实 = 某个版本能逐帧复现。版本偏差因此不会被误报成篡改。
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 内核注册表：升级 = 追加一项，旧版本永不删除（老录像永远有老内核可验）。 */
export const KERNELS = [
  { version: '0.1', file: 'kernel-asm-0.1.js', game: '三链头版（v1 / v2 / micro）' },
];

const MODES = [
  { name: 'v1', ctor: 'sim_new' },
  { name: 'v2', ctor: 'sim_new_v2' },
  { name: 'micro', ctor: 'sim_new_micro' },
];

/** wasm2js legalstub 把 i64 拆 (lo,hi) 两个 i32 ⇒ 薄适配（与 app.js 同款）。 */
function adapt(mod) {
  return {
    ...mod,
    sim_tick: (h, frameBig, ptr, len, seedBig) =>
      mod.sim_tick(h, Number(frameBig) | 0, 0, ptr, len, Number(seedBig) | 0, 0),
    sim_frame: (h) => Number(mod.sim_frame(h)) | 0,
    memory: mod.memory,
  };
}

const kernelCache = new Map();
export function loadKernel(version = null) {
  const k = version
    ? KERNELS.find((x) => x.version === version)
    : KERNELS[KERNELS.length - 1];
  if (!k) {
    throw new Error(
      `没有登记内核版本「${version}」（已登记：${KERNELS.map((x) => x.version).join(', ')}）`,
    );
  }
  if (!kernelCache.has(k.version)) {
    const p = join(HERE, '..', 'kernel', k.file);
    kernelCache.set(k.version, import(pathToFileURL(p).href).then((mod) => adapt(mod)));
  }
  return kernelCache.get(k.version);
}

function hex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function makeSim(ex, mode) {
  const handle = ex[mode.ctor]();
  const mem = () => new Uint8Array(ex.memory.buffer);
  const copyBuf = (ptrFn, lenFn) => mem().slice(ptrFn(), ptrFn() + lenFn());
  const digests = () => {
    ex.sim_digests(handle);
    const d = copyBuf(ex.digest_buf_ptr, ex.digest_buf_len);
    return { facts: hex(d.slice(0, 32)), variants: hex(d.slice(32)) };
  };
  return {
    handle,
    digests,
    tick(frame, actionsText, seed) {
      const bytes = new TextEncoder().encode(actionsText || '');
      const ptr = ex.alloc(bytes.length);
      mem().set(bytes, ptr);
      const rc = ex.sim_tick(handle, BigInt(frame), ptr, bytes.length, BigInt(seed >>> 0));
      if (rc !== 0) {
        const err = new TextDecoder().decode(copyBuf(ex.err_buf_ptr, ex.err_buf_len));
        throw new Error(`sim_tick 第 ${frame} 帧失败（rc=${rc}）：${err}`);
      }
      // 帧包：u64 frame + bytes(32) state_hash + 节点表……头两样就够。
      const buf = copyBuf(ex.frame_buf_ptr, ex.frame_buf_len);
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const hashLen = Number(view.getBigUint64(8, true));
      return { frame, stateHash: hex(buf.slice(16, 16 + hashLen)) };
    },
    free() {
      ex.sim_free(handle);
    },
  };
}

/** `.rec` 行式格式（游戏 ledger crate Recording::decode 的同构移植）。
 *  头行 `crossgame-slice-recording v1|v2`，`seed=` `facts=` `variants=`，
 *  然后逐行 `f=N tokens`。判别链路**以 facts 为准**，头行标签只给人看。 */
export function parseRec(text) {
  const rec = { tag: '', seed: 0, facts: '', variants: '', frames: [] };
  let sawHeader = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!sawHeader) {
      const tag = line.startsWith('crossgame-slice-recording ')
        ? line.slice('crossgame-slice-recording '.length)
        : null;
      if (tag === null) throw new Error(`第 ${i + 1} 行：不是切片录制文件`);
      if (tag !== 'v1' && tag !== 'v2') throw new Error(`第 ${i + 1} 行：不认识的链路标签「${tag}」（只认 v1 / v2）`);
      rec.tag = tag;
      sawHeader = true;
      continue;
    }
    if (line.startsWith('seed=')) {
      rec.seed = Number(line.slice(5));
      if (!Number.isInteger(rec.seed)) throw new Error(`第 ${i + 1} 行：seed 不是整数`);
    } else if (line.startsWith('facts=')) {
      rec.facts = line.slice(6);
    } else if (line.startsWith('variants=')) {
      rec.variants = line.slice(9);
    } else if (line.startsWith('f=')) {
      const rest = line.slice(2);
      const sp = rest.indexOf(' ');
      const frameStr = sp === -1 ? rest : rest.slice(0, sp);
      const tokens = sp === -1 ? '' : rest.slice(sp + 1);
      const frame = Number(frameStr);
      if (!Number.isInteger(frame)) throw new Error(`第 ${i + 1} 行：帧号不是整数`);
      rec.frames.push({ frame, tokens });
    } else {
      throw new Error(`第 ${i + 1} 行：无法识别的行`);
    }
  }
  if (!sawHeader) throw new Error('文件缺少头行');
  return rec;
}

/** 用一个内核跑一次：判别卡池（facts_digest）→ 重放 → 末帧链头。 */
async function attemptKernel(version, rec) {
  const ex = await loadKernel(version);
  let sim = null;
  let pool = null;
  const probeDigests = {};
  for (const mode of MODES) {
    const s = makeSim(ex, mode);
    const d = s.digests();
    probeDigests[mode.name] = d;
    if (!sim && d.facts === rec.facts) {
      sim = s;
      pool = mode.name;
    } else {
      s.free();
    }
  }
  if (!sim) return { version, matchedPool: false };
  let head = null;
  let trap = null;
  try {
    for (const { frame, tokens } of rec.frames) {
      const r = sim.tick(frame, tokens, rec.seed);
      head = r.stateHash;
    }
  } catch (e) {
    trap = String(e && e.message);
  } finally {
    sim.free();
  }
  return { version, matchedPool: true, pool, head, trap, initialDigests: probeDigests[pool] };
}

/** 重放一份 `.rec`，产出链头与三态互证报告。
 *  status：reproduced（期望链头被某登记内核复现）/ replayable（未给期望链头，
 *  可重放）/ not-reproduced（给了期望链头，所有登记内核都算不出——篡改或
 *  未登记的游戏版本）/ premise-broken（facts 与所有登记内核的卡池都不符）。 */
export async function replayRec(text, { expectedHead = null, kernelVersion = null } = {}) {
  const rec = parseRec(text);
  const want = expectedHead ? expectedHead.toLowerCase() : null;
  const kernels = kernelVersion ? KERNELS.filter((k) => k.version === kernelVersion) : KERNELS;
  if (!kernels.length) {
    throw new Error(
      `没有登记内核版本「${kernelVersion}」（已登记：${KERNELS.map((x) => x.version).join(', ')}）`,
    );
  }

  const attempts = [];
  for (const k of kernels) attempts.push(await attemptKernel(k.version, rec));
  const matched = attempts.filter((a) => a.matchedPool);

  let status;
  let chosen = null;
  if (!matched.length) {
    status = 'premise-broken';
  } else if (want) {
    chosen = matched.find((a) => !a.trap && a.head === want) || null;
    if (chosen) {
      status = 'reproduced';
    } else {
      status = 'not-reproduced';
      chosen = matched.find((a) => !a.trap) || matched[0];
    }
  } else {
    chosen = matched.find((a) => !a.trap) || matched[0];
    status = chosen.trap ? 'trap' : 'replayable';
  }

  const ok = status === 'reproduced' || status === 'replayable';
  const head = chosen ? chosen.head : null;
  return {
    ok,
    status,
    kernelVersion: chosen ? chosen.version : null,
    kernelsTried: attempts.map((a) => ({
      version: a.version,
      matchedPool: a.matchedPool,
      head: a.head ?? null,
    })),
    pool: chosen ? chosen.pool : null,
    headerTag: rec.tag,
    tagMismatch: chosen ? rec.tag !== '' && rec.tag !== chosen.pool : null,
    frames: rec.frames.length,
    seed: rec.seed,
    head,
    expectedHead: want,
    headMatches: want ? head === want : null,
    initialDigests: chosen ? chosen.initialDigests : null,
    trap: chosen ? chosen.trap : null,
    error:
      status === 'premise-broken'
        ? 'facts_digest 与所有已登记内核的 v1/v2/micro 卡池都不一致：内容的事实层已变或录自未登记的游戏版本，这份回放的前提不成立'
        : undefined,
  };
}

export function replayRecFile(path, opts) {
  return replayRec(readFileSync(path, 'utf8'), opts);
}

/** 造一份 `.rec`：跑一段输入流并按游戏回收面板的行式格式落盘文本。
 *  测试与演示用——真实录制来自游戏本体（同一格式）。 */
export async function recordSession(modeName, frames, seed = 0) {
  const mode = MODES.find((m) => m.name === modeName);
  if (!mode) throw new Error(`未知模式：${modeName}`);
  const ex = await loadKernel();
  const sim = makeSim(ex, mode);
  try {
    const d = sim.digests();
    const lines = [
      `crossgame-slice-recording ${modeName === 'v1' ? 'v1' : 'v2'}`,
      `seed=${seed}`,
      `facts=${d.facts}`,
      `variants=${d.variants}`,
    ];
    let head = null;
    for (const { frame, tokens } of frames) {
      const r = sim.tick(frame, tokens, seed);
      head = r.stateHash;
      lines.push(tokens ? `f=${frame} ${tokens}` : `f=${frame}`);
    }
    return { text: lines.join('\n') + '\n', head, digests: d };
  } finally {
    sim.free();
  }
}
