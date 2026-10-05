# 升到 DSH 0.2.0-rc.2 的适配记录（fork 侧）

> 对应交接单：`~/.dsh/upgrade-prep/20261005/fork-brief-dsh-browser-control.md`
> 本文件是那份交接单 §7 要求的**差异回写**：凡与交接单冲突处，以实机实测为准，逐条记录。
> 完成日期：2026-10-06 · 环境：DSH Desktop **2.0.10 → 目标 2.0.17** · 内核 **0.1.5-rc.2 → 目标 0.2.0-rc.2**

---

## 0. 结论

交接单的 **P0（peer 范围）正确**，但**漏判了两项同样会导致插件不可用/不可编译的破坏面**，
并把一项**已实测证伪**的内容写成了"稳定 API"。本 fork 已按实测结果适配完毕。

| 项 | 交接单 | 实机实测 | 处置 |
|---|---|---|---|
| peer 范围 | 🔴 会被禁用 | ✅ **确认** | 已改 |
| `settings.register` | ⚠️ "稳定 API，未删除" | 🔴 **已被移除** | 已改（双路径） |
| `JsonValue` 导出 | 未提及 | 🔴 **已移出 dsh-tools** | 已改（本地声明） |
| schemastery 版本 | 未提及 | 🔴 **需 3.18.4** | 已改 |
| bundle 单文件 patch | 应向后兼容 | ✅ **确认仍有效** | 不变 |

---

## 1. 工具与版本

- 插件版本：**1.0.7 → 1.1.0**（新增对 0.2.0 的兼容属能力扩展 → minor）
- 包名：`@caob23/dsh-browser-control` → **`@beiway1145/dsh-browser-control`**
- **插件 id 保持 `browser-bridge` 不变**（profile patch 的 id-override 锚点）
- 分支：`feat/dsh-0.2.0`

---

## 2. P0-1 · peer 范围（交接单正确）

内核树自带 `semver@7.8.5` + `{includePrerelease:true}` 逐条求值：

| 范围 | 0.2.0-rc.2 | 0.2.0 | 0.1.5-rc.2 |
|---|---|---|---|
| 原 `>=0.1.0-rc.1 <0.1.0 \|\| >=0.1.0-rc.1 <0.2.0-0` | ❌ | ❌ | ✅ |
| **`^0.1.0 \|\| ^0.2.0-rc.1`** | ✅ | ✅ | ✅ |

上游卡 `DSH-0.2.0-RC1-01` 佐证（source: `packages/boot/app-boot/src/plugin-compatibility.ts` @ `dsh-v0.2.0-rc.1`）；
已迁移插件 `dsh-cost-meter@1.8.12` 亦用 `>=0.2.0-rc.1 <0.3.0-0`。

**改动**：`peerDependencies` 与 `devDependencies` **两处共 6 行**。`@deepseek-ai/cordis: ^4.0.1` 不动（独立版本线）。

---

## 3. 🔴 P0-2 · `settings.register` 已被移除（交接单判错）

交接单 §3 原文：_「⚠️ 经核实是稳定 API，未删除（0.1.7 的破坏面是 settings 存储位置迁移，不是该 API）」_，
证据强度自评「中」。**实测证伪。**

**上游卡 `DSH-0.1.7-J1-04`**（`breaking` / **`required`**）：_"settings move into the profile plugin
Config; `ctx.settings.register` is gone"_。

**对会真正运行的产物做对照**（jsdelivr 上的 npm 包本体）：

| 版本 | `register(ns, schema)` | `SettingsForms.configure` |
|---|---|---|
| `dsh-settings@0.1.5-rc.2` | ✅ 有 | ❌ 无 |
| `dsh-settings@0.2.0-rc.2` | ❌ **无** | ✅ **有** |

类型面：**`SettingsScope` 已删除**（本插件原样 import 它）；`SettingsNamespace` 保留。
新服务 `SettingsForms` 暴露 `configure / writable / documentPath / prepareDocument / describe / update / replace / mutate`，**无 `watch()`**。

**若只改 peer 会怎样**：`ctx.inject(['settings'], sctx => sctx.settings.register(...))` 在激活时抛错 →
**16 个 `browser_*` 工具全部注册不上** → 浏览器通道消失。这正是交接单想避免的后果，但只改 peer 拦不住。

**改动：特性探测双路径 + 收敛边界**

```ts
ctx.inject(['settings'], (sctx) => {
  const service = sctx.settings as unknown as SettingsServiceLike
  try {
    if (typeof service.register === 'function') { /* 0.1.x：scope.get()/watch() */ return }
    if (typeof service.configure === 'function') { /* 0.2.0+：仅页面策略 */ return }
    /* 都不认：退化为仅用 cordis config */
  } catch (error) { ctx.logger.info(...) }   // ← 设置服务出问题不得cost工具
})
```

**为什么 0.2.0 路径不需要替代 `get()`/`watch()`**：那里的配置是 **profile 所有**的
（就住在 profile `cordis.patch.yml` 的该 entry id 下），经 cordis `config` 参数进入 `apply` ——
而 `current` 本就回退到 `resolved`；实时编辑会重新 apply 该 entry，函数末尾的
激活期 reconcile 会再跑一次。

---

## 4. 🔴 P0-3 · `JsonValue` 已移出 `@deepseek-ai/dsh-tools`（交接单未提及）

对 **0.2.0-rc.2 真实类型**跑 `tsc`：

```
src/index.ts(24,15): error TS2614: Module '"@deepseek-ai/dsh-tools"' has no exported member 'JsonValue'.
```

0.2.0 的 `dsh-tools` 改为 `import { type JsonValue } from '@deepseek-ai/dsh-util-values'`，**不再转出**。
而 `dsh-util-values` 只是 dsh-tools 的**传递依赖**，pnpm 严格布局下从本仓库**解析不到**（且 0.1.x 宿主根本没有该包）。

**改动：本地结构化声明**（12 处用途全是 `Record<string, JsonValue>`，结构类型等价）：

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
```

---

## 5. 🔴 P0-4 · schemastery 需 3.18.4（交接单未提及）

`dsh-tools@0.2.0-rc.2` 要求 **`@deepseek-ai/schemastery: ~3.18.4`**（该版引入 `Volatile` 类型），
而本插件原声明 `^3.18.1`、lockfile 锁在 3.18.1 → 树里出现**两份 schemastery**，`type` 身份不一致：

```
Type 'boolean | Volatile<boolean>' is not assignable to type 'boolean | undefined'.
```

**改动**：`"@deepseek-ai/schemastery": "^3.18.4"`。

> 注：交接单 §3 提到的 `z.boolean().default(true).volatile()` 配方**在 3.18.1/3.18.2 里并不存在**
> （本机实测 0 命中）；`Volatile` 自 3.18.4 起才有。本次**未采用**该配方 —— 配置本就住在
> profile `cordis.patch.yml`，页面策略只用 `configure({auto:false})` 即可，无需标 `volatile`。

---

## 6. 已核对但**未命中**的卡（不动代码）

| 卡 / 笔记 | 判定依据 |
|---|---|
| `DSH-0.1.7-J1-15` bundle 清单 | `patch` 现为 `string \| string[]`，**单文件形式仍有效**（本插件与 `dsh-cost-meter@1.8.12` 均如此） |
| `DSH-0.1.7-J1-16` 包改名台账 | 本插件依赖的 `@deepseek-ai/dsh-settings` **已是新名**（旧名是 `dsh-settings-file`） |
| `DSH-0.1.7-J1-23` toolview 三阶段 | 仅适用于注册 `tool.call.toolview` 视图的 **Web Client** 插件；本插件是 **host-only** |
| `DSH-0.1.7-J1-14` tool-cordis 收窄 | 本插件未使用 `tool-cordis` |
| Desktop 笔记 A（`ctx.sessions` 为空） | 全源码零命中 `sessions`/`workspaceRegistry` |
| Desktop 笔记 B（桌面 PATH 最小化） | 全源码零命中 `child_process`/`spawn` —— 本插件**不 spawn 子进程** |
| `dsh-tools` / `dsh-system-prompt` | `defineTool` / `systemPrompt` 在两个版本均健在 |

---

## 7. 验证（已完成的部分）

| 验证 | 结果 |
|---|---|
| `pnpm typecheck` **对 0.2.0-rc.2 真实类型** | ✅ **exit 0** |
| `pnpm build` | ✅ 产出 `lib/index.js` 69.53 KB |
| **迁移前基线**（原源码 + 新依赖） | 4 个错误（已记录，非本次引入） |
| 双路径冒烟（legacy / modern / 都无） | ✅ **三种形态各注册 16/16 工具** |
| 实装副本冒烟 | ✅ `name=browser-bridge`、`inject=[tools,systemPrompt]`、16 工具 |
| 三处名称一致性 | ✅ dep 键 = bundles 项 = 实装 name |
| fork 产物 vs 实装副本 SHA256 | ✅ **一致** |
| `browser-bridge` loader id 重复 | ✅ 仅 1 处 |
| peer 语义（3 个目标） | ✅ true / true / true |

> 基线纪律：改用新依赖、**未改源码**时 `tsc` 报 4 个错（`JsonValue`、`SettingsScope`、
> `Schema<Config>`、`settings.register`）。这些属**依赖升级引起**，已逐条处理，未计入本插件原有缺陷。

---

## 8. 尚未验证（需重启/升级后确认）

1. **重启 DSH Desktop 后**：stderr 无 `disabling profile plugin row`；`--dump-config` 中该行存在且 `enabled: true`
2. **浏览器扩展连上 9777**（设置页显示已连接）
3. **真实跑通一个浏览器工具**，确认 16 个工具全部注册
4. **升级到 0.2.0-rc.2 之后**：设置页出现「DSH Browser Control」卡片（走 `configure` 新路径的证据）
5. 无 `duplicate loader entry id`

---

## 9. 回滚

```powershell
cd C:\Users\BeiWay1145\.dsh\profiles\desktop
# 1) 卸新装旧
pnpm remove @beiway1145/dsh-browser-control
pnpm add "@caob23/dsh-browser-control@npm:^1.0.7"
# 2) 还原声明：package.json 的 bundles 项、cordis.patch.yml 注释
# 备份：package.json.bak-before-020-20261006_014838
#       cordis.patch.yml.bak-before-020-20261006_014838
```

fork 侧回滚：`git checkout main`（本适配在 `feat/dsh-0.2.0` 分支）。

---

## 10. 附：交接单事实性偏差

| 交接单 | 实机 |
|---|---|
| §1 称 fork 目录 remote 指向上游 `caob23`，§4.1 要求复制新目录并改 remote | ❌ 已过期：该目录**早已是 fork**，`origin`=`BeiWay1145/dsh-browser-control`、`upstream`=`caob23/dsh-browser-control`。**无需复制新目录**，直接在其上开 `feat/dsh-0.2.0` 分支 |
| §3 称 `settings.register` 未删除 | 🔴 见 §3，**已证伪** |
