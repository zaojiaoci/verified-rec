# verified-rec

**Hash-chained audit ledger for AI agent work.** Append-only records anyone can
verify and replay — did the agent really do what it says it did?

An MCP server. Zero npm dependencies. Records land in a plain text file you own.

```
You:   "ship the release."
Agent: *does the work, records each step into the ledger*
You:   "verify the ledger."
Agent: "chain intact — 14 entries, head 9f3c…, nothing edited."
```

## Tools

| Tool | What it does |
|---|---|
| `ledger_start` | Start a new ledger (`.vrec`). Genesis entry + chain head. Never overwrites. |
| `ledger_append` | Append one step. Returns the new chain head. Refuses to write to a broken chain. |
| `ledger_verify` | Recompute every hash, check every link. Returns the first broken line if someone edited the file. |
| `ledger_replay` | List entries in order (optionally a range). |
| `game_verify_rec` | Replay a game `.rec` recording through a deterministic kernel and compute its chain head — see [Origin](#origin). |

## Install

One line, any MCP host:

```jsonc
// ~/.codebuddy/.mcp.json  (WorkBuddy / CodeBuddy)   — user scope
// ~/Library/Application Support/Claude/claude_desktop_config.json  (Claude Desktop)
{
  "mcpServers": {
    "verified-rec": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "verified-rec"]
    }
  }
}
```

Local checkout works the same way (`"command": "node", "args": ["/path/to/verified-rec/src/server.js"]`).
Node ≥ 18. No build step, no native modules, no network.

## Usage

After installing, just talk to your agent — the tools are named in plain
language and it will pick them up:

- **"Open a ledger for today's release work."** → `ledger_start` creates
  `release.vrec` with a genesis entry and returns the first chain head.
- **"Record what you just did."** (as the agent works) → `ledger_append`
  adds one step (`action`, optional `actor` / `note`) and returns the new head.
- **"Verify the ledger."** → `ledger_verify` recomputes the chain and reports
  `ok` + entry count + head — or the **first broken line number** if anything
  was edited.
- **"Show me the ledger."** → `ledger_replay` lists entries in order.

Verifying a game recording (see [Origin](#origin)):

- **"Check this recording: /path/to/play.rec, head 9f3c…"** → `game_verify_rec`
  replays it and answers one of three ways: `reproduced` (some registered
  kernel recomputes the head — authentic), `not-reproduced` (none does —
  tampered or from an unregistered game version), `premise-broken` (the
  recording's facts match no kernel at all). Without an expected head it just
  proves the recording is replayable and reports its head.

Tip: after any important `ledger_append`, **publish the chain head** (commit
message, release note, chat). That is what turns "I didn't edit it" into
"nobody edited it" — the published head pins the chain retroactively.

## How verification works

Each entry links to the previous one by hash:

```
entry.hash = sha256([seq, ts, actor, action, note, prev].canonical)
entry.prev = previous entry.hash          (genesis prev = 64 zeros)
```

`ledger_verify` recomputes the whole chain. Edit one field in one line, swap
two lines, delete one — the first broken line is reported by number.

**Threat model, honestly stated:** this catches accidental edits and casual
tampering. It cannot catch an attacker who rewrites the entire chain and its
head. The fix is the oldest trick in accounting: **publish the head** — commit
it, tweet it, put it in a release note. A retroactive edit then breaks against
the published head, anywhere.

## Origin

This ledger is an extraction. It came from a game —
[《它在维护一场对话》(*It Is Maintaining a Conversation*)](https://zaojiaoci.itch.io/it-is-maintaining-a-conversation),
a free narrative game about a mind that maintains memories for someone, and
loses them. Every in-game state is hash-chained; every playthrough can be
recorded as a `.rec` file and replayed byte-for-byte. The design discipline
behind that ("decisions are hashed, prose is not; same inputs, same chain
head") is what this tool generalizes.

The lineage is one step older: the game evolved from
[dbx-sql-guard](https://github.com/zaojiaoci/dbx-sql-guard), a hash-chain
guard for SQL — the same instinct, three forms: a database guard, a game, a
work ledger.

`game_verify_rec` keeps that story executable. It replays a `.rec` recording
through the same deterministic narrative kernel (versioned compiled artifacts,
see LICENSE-content.md and [PROVENANCE.md](PROVENANCE.md)) and reports the
chain head — the head of the game's own hash chain, where
`head = H(prev ‖ frame ‖ canonical state)` per frame. Give it an `expectedHead`
and it becomes an integrity check with three outcomes: **reproduced** (some
registered kernel version recomputes the head — authentic), **not-reproduced**
(no registered kernel does — tampered, or from an unregistered game version),
**premise-broken** (the recording's facts digest matches no kernel at all).
Kernel upgrades add a new registered version; old recordings keep verifying
against old kernels — an upgrade never falsifies an honest recording.

The kernel is a compiled artifact, and that is a fair thing to be suspicious
of in an audit tool. [PROVENANCE.md](PROVENANCE.md) answers it: every kernel
version ships with its source wasm and SHA-256, is byte-reproducible from it
via a pinned `wasm2js` command (`./gen-kernel.sh`), and is anchored to the
game's publicly registered golden chain heads — verify it yourself in minutes,
no trust in the author required.

## Files

- `*.vrec` — ledger files, newline-delimited JSON. Plain text; diffable, greppable.
- `.rec` — game recordings (`crossgame-slice-recording` line format: `seed=`,
  `facts=`, `variants=`, then `f=<frame> <tokens>` per frame). Produced by the
  game's own export panel.

## License

Code: Apache-2.0. The narrative content compiled into `kernel/`
(`sim-<ver>.wasm` / `kernel-asm-<ver>.js`): All Rights Reserved (see
LICENSE-content.md). The two halves are explained in both files — engine is
engineering, story is authorship.

---

## 中文

**给 AI Agent 工作用的哈希链账本。** 追加式记录，任何人都能校验和重放——
Agent 说它做过的事，链上做没做过，一验便知。

MCP server，零 npm 依赖，账本是你自己机器上的纯文本文件。

| 工具 | 作用 |
|---|---|
| `ledger_start` | 开一本新账（`.vrec`），创世环 + 链头。已存在则拒绝（账不覆盖旧账） |
| `ledger_append` | 记一环，返回新链头。链断了先修账才准记 |
| `ledger_verify` | 全量重算哈希、环环相扣。谁改过文件，报第一个断链行号 |
| `ledger_replay` | 按序重放（可切片） |
| `game_verify_rec` | 用版本化确定性内核重放游戏 `.rec`，算出链头并给三态判定（见下） |

**安装**：上面那段 JSON 照抄进 MCP 配置（WorkBuddy/CodeBuddy 是
`~/.codebuddy/.mcp.json`），一行 `npx -y verified-rec`。Node ≥ 18，
无构建、无原生模块、不碰网络。

**使用**：装完直接跟 Agent 说话就行，工具会被自动挑中：

- **"开一本账记今天的发版工作"** → `ledger_start` 建 `.vrec`，创世环 + 首个链头
- **"把刚才做的事记上"**（干活途中随时）→ `ledger_append` 记一环，返回新链头
- **"验一下这本账"** → `ledger_verify` 全量重算：完好报 `ok` + 条数 + 链头，
  被改过就报**第一个断链行号**
- **"把账读一遍"** → `ledger_replay` 按序列出

验游戏录像（见出处段）：

- **"验这份录像 /path/to/play.rec，链头 9f3c…"** → `game_verify_rec` 三态回答：
  **reproduced**（某登记内核复现链头 ⇒ 真实）/ **not-reproduced**（都复现不出
  ⇒ 篡改或未登记版本）/ **premise-broken**（facts 对不上任何内核）。不给链头
  则只证明可重放并报出链头。

**用法要点**：重要操作 `ledger_append` 之后，把链头**登记出去**（提交信息 /
发布记录 / 聊天里贴一下）——这一步才把"我没改过"升级成"谁都没法改"。

**防篡改的诚实边界**：抓得住手改和误改；抓不住「重算整条链并伪造链头」的
攻击者。解法是会计行最古老的一招——**把链头登记出去**（git 提交 / 公开贴文），
事后改账就与公开链头对不上。

**内核的出生证明**：`kernel/` 里的编译产物不是黑箱——每个版本带源 wasm
与 SHA-256，可用 [PROVENANCE.md](PROVENANCE.md) 里钉死的 `wasm2js` 命令
（`./gen-kernel.sh`）逐字节重建，并用游戏公开登记的黄金链头锚定内容。
`game_verify_rec` 的三态判定：**reproduced**（某登记版本内核复现链头 ⇒
真实）/ **not-reproduced**（所有登记版本都算不出 ⇒ 篡改或录自未登记版本）/
**premise-broken**（facts 对不上任何内核）。内核升级是追加新版本，老录像
永远用老内核验，升级不会冤枉诚实的录像。

**出处**：这套账本是从游戏里提出来的。[《它在维护一场对话》](https://zaojiaoci.itch.io/it-is-maintaining-a-conversation)
——一个关于记忆衰减的免费叙事游戏，它把每一帧状态都串成哈希链，每一局都能
录成 `.rec` 逐帧重放。本工具就是那套纪律的通用化。谱系再往前一步：游戏本身
演化自 [dbx-sql-guard](https://github.com/zaojiaoci/dbx-sql-guard)——
同一个本能的三种形态：数据库守卫、游戏、工作账本。
