# 内核出生证明（PROVENANCE）

`kernel/` 里的每个文件都是**编译产物**——本文件是它的出生证明：
每个版本登记「从哪来、怎么重建、怎么验」。任何人可当场重算，不需要信任作者。

## 版本登记表

| 内核版本 | 对应游戏 | 源 wasm | 源 wasm SHA-256 | 产物 | 产物 SHA-256 |
|---|---|---|---|---|---|
| 0.1 | 三链头版（v1 / v2 / micro） | `kernel/sim-0.1.wasm` | `363a0c007dd733a83b55140d21d470f499c6059f7f46ca1777b87ada1ca8691c` | `kernel/kernel-asm-0.1.js` | `778f5313a22e22c353bf9abcd75b4e94ca91b2810f34e87153475daba46d2b01` |

**游戏黄金链头（公开登记值，锚定内核里的叙事内容）**：

| 链路 | 链头 |
|---|---|
| v1 | `680346569758f1b999bb6db91c3c11cc5940f864710cb7ad3e1efc7e91303637` |
| v2 | `1f72be3185c1f2f0dce6a7a50729c4c3f2749827b331db20e229af29e8df138e` |
| micro | `65f9ec2d461ee690cc8d490a5b25117ad6d2f0aeb76a0259edb564d05e9ac142` |

内容被改动任何一个字段，重放出的链头就对不上上表——这是游戏本体的
反抄袭设计，在这里兼任内核完整性的公开证明。

## 怎么重建（可复现构建）

固定工具链：**binaryen 120** 的 `wasm2js`（其他版本可能产出字节不同但语义
相同的 JS；要逐字节对哈希请用 120）。

```sh
./gen-kernel.sh 0.1
```

等价的手工命令（`gen-kernel.sh` 就是它的固化）：

```sh
wasm2js --pedantic --enable-bulk-memory --enable-sign-ext \
        --enable-mutable-globals --enable-nontrapping-float-to-int \
        kernel/sim-0.1.wasm -o /tmp/sim.asm.js
# 然后把头部的 import * as env from 'env'; 换成：
#   const env = new Proxy({}, { get: () => () => 0 });
# （env 只需 setTempRet0 一族，本项目 i64 全是小整数，高半恒 0）
```

对 `kernel/sim-0.1.wasm` 重跑上述命令，产物应与 `kernel/kernel-asm-0.1.js`
**逐字节一致**（SHA-256 见上表）。

## 验证链（不信任作者也能走完）

1. **产物 ← 源 wasm**：`./gen-kernel.sh 0.1` 重建后 `sha256sum` 对上表——
   证明 JS 内核没有被手改过（它是纯生成物）。
2. **源 wasm ← 游戏内容**：实例化 `sim-0.1.wasm` 按游戏文档的黄金 walk
   推进，末帧 `state_hash` 应逐字节等于上表链头——证明内核里的叙事内容
   就是公开登记的那一版（v1/v2 链头与 itch 公开版一致；micro 是同源的
   微缩切片，链头登记在游戏文档）。
3. **工具行为**：`npm test` 跑判据——账本防篡改、录像重放、三态报告
   全部走这套内核，测试即演示。

## 升级纪律

内核升级 = 新增一个版本条目（`sim-<ver>.wasm` + `kernel-asm-<ver>.js` +
本表新行），**旧版本永不删除**——老录像永远有老内核可验。`game_verify_rec`
逐版本尝试重放：某个登记版本能复现链头 ⇒ 真实；所有登记版本都复现不出
⇒ 篡改（或从未登记的游戏版本录制，报告会点名）。

游戏内核受黄金链纪律约束，升级是低频、需重新登记链头的版本事件。
