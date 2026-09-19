# 对比报告：本 fork / upstream / dsh-ego-browser

> 生成日期：2026-09-19 · 实测环境：Edge 151 on Windows
> 对比对象：
> - **本 fork** `BeiWay1145/dsh-browser-control`（基于 upstream v1.0.7 + 8 个提交）
> - **upstream** `caob23/dsh-browser-control` v1.0.7
> - **dsh-ego-browser** `citrolabs/ego-lite`（16.2k★）

---

## 0. 一句话结论

**三者不是同一类东西。** 先厘清这一点，否则对比会得出错误结论：

| | 本 fork / upstream | dsh-ego-browser |
|---|---|---|
| **形态** | MV3 扩展 + DSH 插件 | **独立 Chromium 浏览器** + Skill |
| **驱动哪个浏览器** | **你现有的** Edge/Chrome | ego-lite **自己的**浏览器 |
| **安装代价** | 加载已解压扩展 | 下载安装 DMG/安装包 |
| **登录态** | **零迁移**（本就用你的 profile） | 需从 Chrome profile 迁移选定登录态 |
| **用户标签页** | 与 agent 共用 | **agent 有独立 Space** |

**核心权衡**：
- **ego-browser 用"换浏览器"换取了隔离性** —— agent 的标签永远不会碰到你的
- **本插件用"共用浏览器"换取了零迁移** —— 但代价是必须自己解决"不抢焦点"

这也是为什么本项目要投入精力做 `focusPolicy`；对 ego-lite 来说这个问题
**在产品层面就不存在**（它有独立 Space）。

---

## 1. 本 fork vs upstream 功能对比

基线相同（均 v1.0.7，16 个工具），差异在**可靠性与行为语义**：

| 维度 | upstream v1.0.7 | 本 fork | 影响 |
|---|---|---|---|
| **CDP 脱离恢复** | ❌ 缓存脏读后**永久失效**，须新开标签 | ✅ 自动重挂（单次重试） | 消除最高频的"标签死掉"问题 |
| **焦点占用** | ❌ `click`/`press` 强制切前台 | ✅ `preserve` 默认不切（保真度相同） | **agent 与用户可并行** |
| **`click` 事件可信度** | 真实（但抢焦点） | **真实且不抢焦点** | 两者兼得 |
| **`type` 输入** | 真实（抢焦点） | **真实且不抢焦点** | |
| **降级标记** | 无概念 | ✅ `inputDegraded`/`degradedReason` | 诚实报告 |
| **受限目标识别** | ❌ 报 Chrome 原始错误 + **误导性提示** | ✅ `restricted_*` 结构化 code | 不再无谓重试 |
| **标签列表卡片** | ❌ 生切 JSON（读起来像数据截断） | ✅ 结构化摘要 + `restricted` 标记 | 消除误解 |
| **`evaluate` 超时** | ❌ 无法指定，非法值落到 100ms 兜底 | ✅ `timeoutMs` 透传（100–120000） | 消除"100ms 超时"困惑 |
| **终态校验** | ❌ 需自行截图比对 | ✅ `expect`（click/type/press） | 省一次往返 |
| **成本指引** | ❌ 无 | ✅ 四级成本阶梯写进提示词 | 实测省 200–1400× |

### 1.1 实测性能对比（本 fork）

| 工具 | 延迟 | 体积 | 备注 |
|---|---|---|---|
| `evaluate`(热) | **2–3ms** | ~33B | 附着命中 |
| `tabs list` | 4ms | 2.1KB | 19 标签完整 |
| `read`(text) | 23ms | 7.7KB | |
| `type`(fill) | 28ms | 74B | |
| `snapshot` | 35ms | 14.9KB | |
| `read`(html) | 37ms | **127.9KB** | ⚠️ 应避免 |
| `press` | 50ms | 35B | |
| `click` | 161ms | 106B | 含坐标计算 |
| **`screenshot`** | **713ms** | 298B | ⚠️ 最慢 |

**读取策略成本差（三站点实测）**：

| 站点 | `evaluate` 精准取数 | `read`(html) | 倍率 |
|---|---|---|---|
| GitHub | 90B | 126,695B | **1408×** |
| Bilibili | 93B | 124,331B | **1337×** |
| arXiv | 66B | 13,990B | **212×** |

---

## 2. 三方完整对比

### 2.1 能力矩阵

| 能力 | upstream | 本 fork | ego-browser |
|---|---|---|---|
| 操作用户现有浏览器 | ✅ | ✅ | ❌（独立浏览器） |
| 登录态零迁移 | ✅ | ✅ | ⚠️ 需 profile 迁移 |
| **用户与 agent 并行** | ❌ 抢焦点 | ✅ **不抢焦点** | ✅ 独立 Space |
| 多 agent 并行 | ❌ | ⚠️ 同标签会竞争 | ✅ 每任务一个 Space |
| 读取 DOM / 结构化状态 | ✅ | ✅ | ✅ |
| 执行任意 JS | ✅ | ✅ | ✅ |
| 截图 | ✅ | ✅ | ✅ |
| Console / Network 日志 | ✅ | ✅ | ⚠️ 待核实 |
| PDF 导出 | ✅ | ✅ | ⚠️ 待核实 |
| 设备视口模拟 | ✅ | ✅ | ⚠️ 待核实 |
| **跨扩展页/内置页** | ❌ | ❌（明确报告） | ❌（同为 Chromium 限制） |
| CDP 脱离自愈 | ❌ | ✅ | — |
| 终态校验 `expect` | ❌ | ✅ | ⚠️ 待核实 |
| 成本阶梯指引 | ❌ | ✅ | ⚠️ 待核实 |
| 需要装新浏览器 | ❌ | ❌ | ✅ |

> ⚠️ ego-browser 的工具清单未逐项核实 —— 它是 Skill + CLI 形态，能力面与
> CDP 直控不同，上表相关行仅供参考，不应作为选型依据。

### 2.2 "不抢焦点"的两种解法

两者都实现了"不打扰用户"，但**代价结构完全不同**：

| | 本 fork（`preserve`） | ego-browser（Space） |
|---|---|---|
| 实现方式 | 后台标签直接收可信事件 | agent 用自己的标签/窗口 |
| **是否共用你的标签** | 是（不切换而已） | 否（物理隔离） |
| 用户误关 agent 标签 | ⚠️ 可能 | ✅ 不会 |
| 需要新浏览器 | ✅ 不需要 | ❌ 需要 |
| 登录态 | 天然共享 | 需迁移 |
| 多 agent 并行 | ⚠️ 同标签会打架 | ✅ 天然支持 |

**结论**：如果痛点是"agent 碰我的标签"，ego-browser 的 Space 模型更彻底；
如果痛点是"别切走我的屏幕、别让我重登"，本插件的 `preserve` 更省事。

### 2.3 生态位

```
                        零迁移 / 用你的浏览器
                              ▲
                              │
              本 fork ────────┤
              （preserve）    │
                              │
          upstream ───────────┤  ← 抢焦点
                              │
        ──────────────────────┼──────────────────────►
        共用标签               │              物理隔离
                              │
                              │        ego-browser
                              │        （独立 Space）
```

---

## 3. 本 fork 相对 upstream 的改动清单

```
7b04c02  chore: 整理研究产物
256ad07  feat!: preserve 下 click 不再降级        ← 行为变更
0b0374e  docs: PAIN-POINTS.md 按实测更新
bd85ae6  feat: P0 成本阶梯 + P1 expect 终态校验
8fd91a9  docs: PAIN-POINTS.md 初版
3e24c63  feat: 受限目标识别 + 结构化错误
b5fb106  feat: 焦点保全 + 标签摘要 + 超时透传
8494fcb  fix: CDP 脱离缓存失效 + 自动重挂          → upstream PR #7
```

规模：18 文件，+2,640 / −64 行（含文档与构建产物）。

### 3.1 兼容性

- **工具签名**：完全向后兼容（新增可选参数，未删改既有参数）
- **唯一破坏性变更**：`preserve` 下 `click` 的返回体不再含
  `inputDegraded`/`degradedReason`，且 `hitVerified` 由恒 `false` 变为真实判定
  → 依赖这两个字段的下游代码需调整
- **配置**：新增 `focusPolicy`，默认 `preserve`（= 行为变更）

---

## 4. 命名问题：要不要改包名？

### 现状

```
package.json:  "name": "@caob23/dsh-browser-control"     ← 仍是上游的 scope
profile 依赖:  "file:D:/VibeCoding/project/dsh-plugin/dsh-browser-control"
```

UI 显示 `@caob23/dsh-browser-control` 是**正确反映了 package.json 的 name 字段**，
但该 name 指向的已不是它实际加载的代码（加载的是 fork 目录）。

### 风险分析

| 场景 | 用 `@caob23/...` | 改 `@beiway1145/...` |
|---|---|---|
| 与上游共存 | ❌ 包名冲突，pnpm 无法同时装两者 | ✅ 可共存对比 |
| 发布到 npm | ❌ 无权限（非你的 scope） | ✅ 需先建 scope |
| 与上游合并 | ✅ 差异清晰 | ⚠️ 需改回 |
| 误以为装了原版 | ⚠️ 会困惑（正是当前的困惑） | ✅ 名实相符 |
| 上游 PR 提交 | ✅ 无需改 | ⚠️ 需维护两个名字 |

### 改名涉及的全部位置（已核实）

共 **4 处**，缺一即加载失败：

| # | 文件 | 当前值 | 说明 |
|---|---|---|---|
| 1 | fork `package.json` → `name` | `@caob23/dsh-browser-control` | 包身份 |
| 2 | fork `cordis.patch.yml` → `insert[0].name` | `'@caob23/dsh-browser-control'` | **Loader 的解析目标** |
| 3 | profile `package.json` → `dependencies` 键 | `@caob23/dsh-browser-control` | pnpm 依赖键 |
| 4 | profile `package.json` → `dsh.profile.bundles` 项 | `@caob23/dsh-browser-control` | bundle 注册名（必须是包名） |

> ⚠️ 第 2 与第 4 项最容易漏。第 2 项是 Loader 实际解析的目标；
> 第 4 项必须是**包名**而非目录名。

### 风险分析

| 场景 | 保持 `@caob23/...` | 改为 `@beiway1145/...` |
|---|---|---|
| 与上游共存 | ❌ 包名冲突，pnpm 无法同时装 | ✅ 可共存对比 |
| 发布到 npm | ❌ 无权限（非你的 scope） | ✅ 需先建 scope |
| 与上游合并 / 提 PR | ✅ diff 干净 | ⚠️ 多出改名噪音，需排除 |
| **UI 名实相符** | ❌ **会误以为装的是原版** | ✅ 相符 |

### 我的建议：改

**决定性理由不是"好看"，而是这个误认本身就是真实故障源。**

本轮之前发生过一次"插件层改动从未生效"的 bug：DSH 一直加载 npm 原版
（46KB），而 fork 产物（69KB）未被使用，却因为 UI 显示 `@caob23/dsh-browser-control`
而看不出来。改名能让这类问题**在 UI 上一眼可见**。

**唯一代价**：若将来给上游提 PR，需把改名相关改动排除。考虑到 PR #7
至今无回应、上游自 2026-09-04 停滞，这个代价很小。

### 若决定改，操作顺序

```bash
# 1) 改 fork 的两个文件
#    package.json         name -> @beiway1145/dsh-browser-control
#    cordis.patch.yml     insert[0].name -> @beiway1145/dsh-browser-control
cd D:/VibeCoding/project/dsh-plugin/dsh-browser-control
# （编辑后无需重新构建，这两个字段不参与打包）
# 2) 改 profile
cd ~/.dsh/profiles/desktop
pnpm remove @caob23/dsh-browser-control
pnpm add "file:D:/VibeCoding/project/dsh-plugin/dsh-browser-control"
# 3) 手工把 dsh.profile.bundles 里的名字改成新包名
# 4) 重启 DSH
```

> 注意：`pnpm add` 会把依赖键写成新包名，但 **`dsh.profile.bundles` 需要手工改**
> —— pnpm 不感知该字段。

---

## 5. 选型建议

| 你的场景 | 推荐 |
|---|---|
| 要用**已登录的**站点（B站/知乎/后台） | **本 fork** |
| 不想装第二个浏览器 | **本 fork** |
| 痛点是"agent 别碰我的标签" | **ego-browser** |
| 要多 agent 并行跑不同任务 | **ego-browser**（Space 天然隔离） |
| 要和上游保持同步 | upstream |
| 需要 100% 确定 agent 看不到某些标签 | **ego-browser**（物理隔离 > 逻辑不切换） |

---

## 6. 尚待核实的项

为保持诚实，以下**未做核实**，不应作为决策依据：

- ego-browser 的完整工具清单与参数（本次仅查了官方文档与仓库概览，未读源码）
- ego-browser 处理 `isTrusted`、遮挡命中测试、跨扩展页的具体方式
- ego-browser 的性能数据（其宣称"比 Vercel agent-browser 快 2.5×"，**未独立验证**）
- 本 fork 与 upstream 在 upstream 未来版本上的兼容性（上游已停滞于 2026-09-04）
