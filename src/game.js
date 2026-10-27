/**
 * game.js — 游戏内核驱动：重放 `.rec` 录制，算出链头。
 *
 * 纯 JS 内核路线（kernel/kernel-asm.js，wasm2js 转译产物，与 WASM 路逐帧
 * 字节等价——等价性锁在游戏仓库的判据里）。这里只用四样导出：
 *   sim_new / sim_new_v2 / sim_new_micro、sim_tick、sim_digests、frame_buf。
 *
 * 链头语义与游戏 ledger crate 一致：每一帧 `state_hash` =
 * H(上一环 || 帧号 || 本帧 canonical 状态)，**末帧的 state_hash 就是链头**。
 * `.rec` 只记输入流不记逐帧哈希 ⇒ 不给期望链头时，本工具证明的是
 * 「这份输入流可重放、产出这个头」；给了期望链头才是完整性校验。
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const KERNEL_PATH = join(HERE, '..', 'kernel', 'kernel-asm.js');

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

let kernelPromise = null;
export function loadKernel() {
  if (!kernelPromise) {
    kernelPromise = import(pathToFileURL(KERNEL_PATH).href).then((mod) => adapt(mod));
  }
  return kernelPromise;
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

/** 重放一份 `.rec`，产出链头与互证报告。 */
export async function replayRec(text, { expectedHead = null } = {}) {
  const rec = parseRec(text);
  const ex = await loadKernel();

  // 链路判别：初始 facts_digest 对三份卡池（v1/v2/micro）。
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
  if (!sim) {
    return {
      ok: false,
      error: 'facts_digest 与 v1/v2/micro 三份卡池都不一致：内容的事实层已变，这份回放的前提不成立',
      headerTag: rec.tag,
    };
  }

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

  const report = {
    ok: !trap && (expectedHead == null || head === expectedHead.toLowerCase()),
    pool,
    headerTag: rec.tag,
    tagMismatch: rec.tag !== '' && rec.tag !== pool,
    frames: rec.frames.length,
    seed: rec.seed,
    head,
    expectedHead: expectedHead ? expectedHead.toLowerCase() : null,
    headMatches: expectedHead ? head === expectedHead.toLowerCase() : null,
    initialDigests: probeDigests[pool],
    trap,
  };
  return report;
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
