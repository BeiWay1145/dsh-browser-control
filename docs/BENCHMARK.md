# 基准测试与迁移评估：dsh-ego-browser vs dsh-browser-control (fork)

> 实测日期：2026-09-19 · 环境：Edge 151 on Windows · 中位数（3 次采样）
> 目的：评估用 dsh-ego-browser 替代 dsh-browser-control 的可行性，
> 并找出可从后者迁移的优化。

---

## 0. 结论摘要

| 问题 | 答案 |
|---|---|
| ego 能替代 browser-control 吗？ | **取决于是否需要"操作用户已登录的浏览器"** |
| 延迟差距 | **ego 慢 39–69 倍**（恒定 ~350ms vs 3–10ms） |
| 可否优化 ego 的 350ms？ | ✅ **可以**，根因是每次调用 spawn 新进程 |
| 可从 fork 迁移的优化 | ✅ **6 项**，见第 3 节 |

**核心矛盾**：ego 的慢来自它的**架构选择**（CLI 而非长连接），这与它的隔离能力
是同一个设计的两面 —— 而隔离恰恰是它相对 fork 的唯一优势。

---

## 1. 实测延迟对比

**测试条件**：两侧加载**完全相同**的 `data:` 页面（`<button id=b>` + `<input id=i>`），
各 3 次采样取中位数。

### 1.1 观测类

| ego | 延迟 | browser (fork) | 延迟 | 倍数 |
|---|---|---|---|---|
| `ego_js` | 426ms | `browser_evaluate` | **10ms** | **43×** |
| `ego_read_element` | 363ms | `browser_read`(text) | **6ms** | **61×** |
| `ego_snapshot` | 368ms | `browser_snapshot` | **6ms** | **61×** |
| `ego_page_info` | 365ms | —（无对应） | — | — |

### 1.2 交互类

| ego | 延迟 | browser (fork) | 延迟 | 倍数 |
|---|---|---|---|---|
| `ego_click` | 501ms | `browser_click` | **8ms** | **63×** |
| `ego_fill` | 354ms | `browser_type`(fill) | **9ms** | **39×** |
| `ego_scroll` | 349ms | `browser_scroll` | **6ms** | **58×** |
| `ego_key` | 416ms | `browser_press` | **6ms** | **69×** |

### 1.3 延迟根因

ego 的耗时**高度稳定**（344–357ms 波动 <4%），说明是**固定开销**而非工作量差异。

实测分解：

```
node -e 0                    →  53ms     （Node 启动基线）
ego-browser.mjs（空跑）       → 183ms     （CLI 自身引导）
完整 ego_* 调用               → ~350ms    （+ 实际工作）
```

**根因**（源码确认）：`lib/index.js` 的 `runEgoScript()` **每次工具调用都**：

```js
subprocess.spawn({
  argv: [process.execPath, cfg.egoBin, "nodejs", ...extraCliArgs],
  ...
})
```

即 **每个 `ego_*` 调用都 fork 一个新的 Node 进程**，执行一次 CLI，然后退出。

对比 fork 的架构：

| | ego-browser | browser-control (fork) |
|---|---|---|
| 传输 | **每次 spawn 子进程** | **WebSocket 长连接常驻** |
| CDP 附着 | 每次重新建立 | **持久附着**（附着命中后 2–3ms） |
| 单次开销 | ~350ms 固定 | 3–10ms |

---

## 2. 一个重要的非对称发现：click 受窗口状态影响

测试中出现过一次异常：`browser_click` 恒定 **5019ms**。诊断后定位到根因：

```
最小化窗口 → 标签无法被激活 → Input.dispatchMouseEvent 等待激活 → ~5s 超时后才投递
```

依据：[Chromium issue #89](https://github.com/ChromeDevTools/devtools-protocol/issues/89)
原文 —— *"It waits for specified tab to be active"*。

**决定性 A/B（同一标签）**：

| 条件 | click 延迟 |
|---|---|
| 标签活跃 | **8ms** |
| 标签非活跃（窗口最小化） | **5031ms** |
| `evaluate`/`press`/`scroll`（非活跃） | 4–5ms（**不受影响**） |

**只有鼠标事件受影响**，键盘与求值都不等激活。

> ⚠️ 这个发现推翻了本文档早前的一个结论。曾认为"后台标签的鼠标点击无需前台且无代价"
> —— 对于**标签级**非活跃成立，但对**窗口级最小化**不成立。区别在于：
> 非活跃标签仍在被渲染，最小化窗口的视口未被合成，鼠标事件因此等待激活。

**已修复**（见 `extension/background.js`）：恢复最小化检测，
但**不**像 upstream 那样抛错、也**不**还原窗口（那会抢用户屏幕），
而是在返回体里附 `warning` 字段说明原因与解决办法。

---

## 3. 可从 dsh-browser-control 迁移到 ego 的优化

按性价比排序。**前两项可直接解决 ego 最大的痛点（延迟）。**

### 🥇 P0 · 复用 node 进程，消除每次 spawn

**问题**：每次 `ego_*` 调用 spawn 一个 Node 进程，固定 ~350ms。

**证据**：
- `node -e 0` = 53ms，说明进程启动是可见成本
- ego 耗时波动 <4%，证明是固定开销
- 源码：`runEgoScript()` 每次 `subprocess.spawn`

**迁移方案**（三种，按改动量排序）：

| 方案 | 做法 | 预期收益 | 改动量 |
|---|---|---|---|
| A | 常驻 daemon：首次 spawn 后保持 stdin/stdout 打开，后续调用复用 | **~350ms → <20ms** | 大 |
| B | 批处理：提供 `ego_batch([...])` 一次进程跑多步 | 多步任务省 (n−1)×350ms | 中 |
| C | 预热：空闲时保持一个温进程 | 部分收益 | 小 |

**方案 A 的关键**：ego 已有 `ego_script`（多步脚本），说明进程内**支持**连续操作
—— 只需把「一次 spawn 一个脚本」改成「一个常驻进程接收多个脚本」。

> 这正是 browser-control 的做法：WS 长连接 + 持久 CDP 附着，
> 所以它 3–10ms 就完成一次调用。

### 🥈 P0 · 成本阶梯提示（零运行时开销）

**问题**：ego 没有告诉模型"哪种观测更便宜"。它的工具集里
`ego_snapshot`（语义树）/`ego_read_element`/`ego_js`/`ego_screenshot` 成本差异很大。

**迁移方案**：把 fork 的 `PICK THE CHEAPEST WAY TO OBSERVE` 段落移植进 ego 的系统提示词。
实测依据（fork 上测得）：

| 策略 | 体积 | 相对 |
|---|---|---|
| `evaluate` 精准取数 | 33B | 1× |
| `read`(text) | 577B | 17× |
| `snapshot` | 2,600B | 79× |
| `read`(html) | 126,658B | **219–1408×** |

**成本**：改文本 · **收益**：省 token，且不增加任何运行时开销。

### 🥉 P1 · `expect`：动作内终态校验

**问题**：ego 的 `ego_click` 返回`{ok, double, page}` —— **只说明"我点了"，
不说明"点成了没有"**。模型仍需额外调用确认。

**迁移方案**：移植 fork 的 `expect` 参数：

```js
ego_click({ space, selector, expect: { selector } | { text } | { gone } | { target, value } })
→ { ok, clicked, expected: { matched, waitedMs, detail } }
```

**关键设计**（移植时务必保留）：**超时是"答案"不是异常** —— 返回
`{matched:false, timedOut:true}`，否则调用方无法区分"没等到"与"调用失败"。

**对 ego 额外重要**：它每次调用 350ms，省一次确认往返就省 350ms。

### P1 · 受限目标的明确报告

**问题**：ego 与 fork 同受 Chromium 限制（跨扩展页、`chrome://` 页），
但如果它只是报底层错误，模型会无谓重试。

**迁移方案**：移植 fork 的 `classifyRestriction()` 思路 —— 抛出带 code 的
结构化错误（`restricted_other_extension` / `restricted_browser_internal`），
并说明"哪些操作仍可用"（列表/打开/关闭/导航仍可，只是不能读写页内）。

### P2 · 标签列表的结构化摘要

**问题**：若 ego 有列标签的能力，生切 JSON 会让人误读为"数据截断"。

**迁移方案**：移植 `summarizeTabs()` —— 精确声明总数、预览上限、
超限时明确说明"还有 N 条（完整列表始终返回）"。

### P2 · 遮挡命中测试与 `hitVerified`

**问题**：ego 的 `ego_click` 不报告点击是否真的落在目标上。

**迁移方案**：移植 fork 的 `elementFromPoint` 命中测试：

```js
const x = r.left + r.width/2, y = r.top + r.height/2;
const topEl = document.elementFromPoint(x, y);
const isTop = topEl === el || el.contains(topEl);
// 返回 hitVerified: isTop，false 时附 hitInstead
```

**注意**：实测在后台标签上命中测试**真实可用**（加 `z-index:99999` 遮罩后
事件正确落在 overlay），所以这不是理论上的能力。

---

## 4. 迁移可行性评估

### 4.1 能力对照

| 维度 | fork | ego | 迁移影响 |
|---|---|---|---|
| 操作**用户现有浏览器** | ✅ | ❌ 独立浏览器 | ⚠️ **不可迁移**，产品定位差异 |
| 登录态 | 零迁移 | 独立 Space | ⚠️ **需重新登录或迁移 profile** |
| 多 agent 并行 | ⚠️ 同标签竞争 | ✅ 独立 Space | ✅ ego 优势 |
| 延迟 | **3–10ms** | 350–500ms | ❌ **ego 劣势** |
| 工具数量 | 16 | **32** | ✅ ego 优势 |
| 观察窗 | ❌ | ✅ | ✅ ego 优势 |
| 下载捕获 | ❌ | ✅ `ego_download` | ✅ ego 优势 |
| 验证码检测 | ❌ | ✅ `ego_captcha` | ✅ ego 优势 |
| 受限目标处理 | ✅ 结构化报错 | ⚠️ 待核实 | 可迁移 |
| 成本阶梯 | ✅ | ❌ | **可迁移** |
| `expect` 终态校验 | ✅ | ❌ | **可迁移** |

### 4.2 迁移决策树

```
你的任务需要"用户已登录的站点"（B站/知乎/后台）？
├─ 是 → 保留 fork。ego 需重新登录或迁移 profile，且丢失所有 cookie
└─ 否 → ego 更合适，但要注意：
         ├─ 每次调用多 350ms（10 步任务多 3.5 秒）
         ├─ 但可用 [P0] 复用进程优化掉
         └─ 且获得：隔离、并行、下载、验证码、观察窗

需要"agent 绝不碰我的标签"的强保证？
├─ 是 → ego（物理隔离 > 逻辑不切换）
└─ 否 → 两者皆可，按延迟需求选
```

### 4.3 我的建议

**不要全量替换，而是按场景分流。** 理由：

1. **延迟差距是 39–69 倍**，对多步任务累积显著（10 步 ≈ 3.5s vs 0.06s）
2. 但 ego 的额外能力（隔离/并行/下载/验证码）**fork 完全不提供**
3. 两者**可以并存**（已实测：`ego_*` 与 `browser_*` 互不干扰）

**推荐分工**：

| 场景 | 用哪个 |
|---|---|
| 需要登录态（购物、后台、社交） | `browser_*` |
| 公开信息抓取、多任务并行 | `ego_*` |
| 需要观察窗/下载/验证码检测 | `ego_*` |
| 高频短交互（多步表单） | `browser_*` |

---

## 5. 未核实项（诚实说明）

- ego 的 `ego_screenshot`、`ego_download`、`ego_captcha` 等**未做延迟测试**
  （本次仅覆盖 8 个高频工具）
- ego 是否已有内部进程复用（我只读了 `lib/index.js` 的 `runEgoScript`，
  未穷尽所有调用路径）
- ego 在**多步任务**上的稳定性（README 自陈 Windows 上是社区移植，
  "复杂多步流程稳定性可能弱于 macOS"）—— 未做长任务验证
- P0/P1 迁移方案**均为建议，未实现也未验证收益**
