# 痛点与优化分析（PAIN POINTS）

> 来源：真实的「学习通刷课油猴脚本」会话踩坑记录 + 多个 DSH 会话的实测复核 +
> 本 fork 的修复。**所有结论均来自实测，非推测**；凡是被实测推翻的旧结论，
> 下方都会显式标注「已证伪」。
>
> 维护者：BeiWay1145 · 基线：v1.0.7（upstream 2763148）
> 实测环境：**Edge 151**（Chromium 内核）+ Windows · 扩展 v1.0.7 + fork 插件

---

## 0. 一句话总纲

这个插件的可靠性问题**几乎全部集中在"状态没有正确失效"这一件事上**，
而不是能力缺失。四处实测确诊的根因：

1. **CDP 附着缓存脏读** → 标签看起来"永久不可用"，实则从未重试附着
2. **渲染层切片 JSON** → 完整数据被误读成"数据被截断"
3. **本地标签页被抢占焦点** → agent 与用户争夺浏览器使用权
4. **"构建成功"被当成"已生效"** → 插件改动长期未加载（第 7.2 节，方法论教训）

前三者不需要新能力，只需要**正确地报告状态**。

### 最重要的单点发现：两全方案成立

源码注释声称"真实按键需要 OS 焦点"，因此 `preserve` 模式下 `type` 只能降级为
`fill`。**实测推翻了这一前提**——CDP 按键事件可以送达后台标签，页面自己的
`keydown` 监听器照常触发，而用户标签全程不被抢。

**"不抢焦点"与"正常输入"不是二选一。** 详见第 3 节。

---

## 1. 【已修复】CDP 意外脱离后永久失效

### 现象

```
Runtime.evaluate failed: Debugger is not attached to the tab with id: 1252984349.
```

且 `browser_tabs activate`、`browser_navigate` 重载**均无效**，标签看起来"死了"。

### 实测证据（本轮真实复现）

对同一标签连续三次调用，**每次 2–3ms 就失败**：

```
第1次 ERR 3ms: Debugger is not attached to the tab with id: 1252984349
第2次 ERR 2ms: 同上
第3次 ERR 2ms: 同上
```

**2–3ms 这个数字本身就是证据**——真正的 `chrome.debugger.attach()` 需要几十到几百毫秒
（实测冷附着后首次 evaluate 约 6ms 起，含 CDP 域启用则更久）。耗时这么短，说明
**代码根本没有尝试附着就返回了**。

决定性对照：**同一 URL 在新标签里立即可用**：

```
同 URL 新标签 1252984616: OK → "哔哩哔哩 (゜-゜)つロ 干杯~-bilibili"
```

→ 目标本身完全可以附着，**失败纯属缓存短路**。

### 根因

`chrome.debugger.onDetach` 是个空监听器：

```js
chrome.debugger.onDetach.addListener((_source, reason) => {
  if (reason === 'target_closed' || reason === 'canceled_by_user') {
    // attachedTabs cleanup is handled by chrome.tabs.onRemoved
  }
});
```

注释假设 `tabs.onRemoved` 能覆盖所有脱离。但**标签没关闭、CDP 会话已丢**的情况
（DevTools 抢占、导航竞态、Service Worker 重启）不会触发 `onRemoved`，
`attachedTabs` 于是永远留着这个 tab。而 `ensureAttached()` 首行就是：

```js
if (attachedTabs.has(tabId)) return;   // ← 脏缓存在此短路
```

### 修复

见 commit `8494fcb`（已提 upstream PR #7）：

- 新增 `clearAttachment()`，不发 `chrome.debugger` 调用，故可在 `onDetach` 回调内安全执行
- `onDetach` **无条件**失效缓存
- `dbgSend` 识别 Chrome 的"会话丢失"措辞 → 失效缓存 + 抛 `code='cdp_detached'`
- `withCDP` 捕获后**重新附着并重放一次**；二次失败原样抛出（最多两次尝试，不无限重试）

### ⚠️ 对旧文档的修正

旧经验文档称「脱离后**基本无法恢复**」「必须新开标签」。**该结论的成因判断是错的**：
不是无法恢复，而是**代码从未尝试恢复**。修复后无需再采用"新开标签"这一高代价规避 ——
而新开标签恰恰是下一节"反爬"的诱因之一，两者是连锁的。

---

## 2. 【已修复】标签列表被误读为"数据截断"

旧文档：「`browser_tabs list` 在标签多时返回会被截断（17 个标签只显示 4 条）」。

**已证伪。** 本轮实测 **19 个标签完整返回**，`count: 19`、`tabs` 数组 19 项，
数据层没有任何截断。

真正的截断在**渲染层**：

```ts
render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 400) }],
```

生切 JSON 会切出**非法 JSON 片段**，读起来正像"列表不全"。这是把**显示截断**
误判成**数据截断**，进而导致无谓规避。

**修复**：`summarizeTabs()` 输出人类可读摘要，精确声明总数、最多预览 25 条、
`*` 标记活跃标签，超限时明确写出还有多少条。截断不再伪装成数据缺失。

---

## 3. 【已修复】与用户争夺浏览器

### 实测证据

```
用户活跃标签: 1252984603  (arxiv.org)
[click 到另一标签后] 活跃 → 1252984533   ❌ 用户标签被夺走
```

根因在 `cmdClick`：

```js
// Mouse events land on whatever is under the viewport coordinates of the
// focused tab; ensure our tab is frontmost so coordinates are meaningful.
await activateTabWindow(tab.id);   // ← 元凶
```

CDP 鼠标事件走**视口坐标**，坐标只在被渲染的前台标签才有意义，所以作者主动切前台。
**同样的调用存在于 `cmdInput` 的 type 模式、`cmdPress`（`cmdScroll` 不需要，它走
`Runtime.evaluate`）。**

### 边界澄清（重要）

问题**不是**"插件只能控制活跃标签"——`resolveTab` 只在**没传 tabId** 时才回退到活跃标签。
实测非活跃标签的读取**不抢焦点**。

### 两全方案：不抢焦点 + 正常输入（实测推翻既有假设）

**这是本 Fork 最重要的发现，它推翻了插件源码注释里的一个错误前提。**

原 `cmdInput` 里写着：

```js
// Real key events require the tab to have OS-level focus; activate first.
if (mode === 'type') await activateTabWindow(tab.id);
```

以及 `cmdPress` 里的同类注释。**这两条注释都是错的**——它们把"鼠标事件的坐标依赖"
错误地推广到了所有输入事件。论文 ASIL 批评的正是这类"用运动原语表达语义意图"的
设计。实测结果：

在**非活跃标签**上依次投放三种输入方式，观察页面自己的 `keydown` 监听器：

| 输入方式 | 后台标签结果 | 是否可信 |
|---|---|---|
| `Input.insertText` | ✅ 送达 | 走 IME 路径，不触发 keydown（正常） |
| `Input.dispatchKeyEvent` | ✅ 送达 | **真实按键**，keydown 正常触发 |
| 合成 `KeyboardEvent` | ✅ 但 `isTrusted: false` | 降级方案（已不再使用） |

**决定性证据**——页面通过 `document.addEventListener('keydown', …)` 捕获到每个字符：

```json
{"keys":["A","B","C"], "value":"SYNTH", "active":"i"}
```

而**用户标签全程保持在 `edge://extensions/`，从未被抢**。

#### 真正的依赖边界

| 输入类型 | 需要前台？ | 原因 |
|---|---|---|
| 读取（evaluate/read/snapshot） | ❌ | 无坐标、无焦点依赖 |
| **按键（insertText / dispatchKeyEvent）** | ❌ | 送到"当前焦点元素"，与视口渲染无关 |
| **鼠标（dispatchMouseEvent）** | ✅ | **坐标是视口坐标**，后台标签不渲染则无意义 |

**所以只有点击受限**——而点击在 `preserve` 下已用 DOM `el.click()` 解决。

#### 端到端验证（经插件层，非直连桥）

```
browser_type(mode:"type", tabId:<后台标签>, expect:{target:"#i", value:"PLUGIN"})
→ {"mode":"type", "filled":{"value":"PLUGIN"},
   "expected":{"matched":true,"waitedMs":1}}
页面 keydown 记录: ["P","L","U","G","I","N"]   ← 真实按键
用户标签: 1252984630 (edge://extensions/)      ← 全程未变
```

中文输入同样验证通过（`"两全方案"`，走 `insertText`）。

### 修复

`Config.focusPolicy`（默认 `preserve`）。基于上述实测，**降级面已收窄到只剩点击**：

| 操作 | preserve 下的行为 | 上报字段 |
|---|---|---|
| `click` | 页内 `el.click()`（坐标依赖无法回避） | `inputDegraded: 'dom-synthetic'` |
| `type` | **真实按键，不再降级** ✅ | — |
| `press` | **真实按键，不再降级** ✅ | — |
| `tabs.open` | 默认后台打开 | `openedInBackground: true` |
| 读取类 | 无需改动，本就后台安全 | — |

**`inputDegraded` 现在只在点击时出现。** 它意味着：合成点击（`isTrusted` 为 false），
`hitVerified` 恒为 `false`（无坐标命中测试），sticky 头部/广告遮挡不会被发现。
故点击结果同时带 `degradedReason`，并用 `expect` 提供替代校验手段。

`browser_tabs activate` 与显式 `active:true` 始终生效——那是明确的前台请求。

---

## 4. 【已修复】受限目标：跨扩展页与浏览器内置页

### 实测

在 Tampermonkey 的 `chrome-extension://iikmkjmpaadaobahmlepeloendndfphd/options.html`
上，**所有读写全部失败**：

```
debugger attach failed: Cannot access a chrome-extension:// URL of different extension
```

### 根因

Chrome 在 attach 时按 scheme 做白名单校验。**这是浏览器安全边界，不可绕过**：
`debugger` 权限若能读同级扩展的上下文，任何扩展都能窥探密码管理器或钱包。

**多个独立项目撞同一堵墙**：[Claude in Chrome #45221](https://github.com/anthropics/claude-code/issues/45221)、
[OpenCLI #197](https://github.com/jackwener/opencli/issues/197)。

### 实测边界（比旧文档描述的更窄）

| 操作 | 受限目标上 |
|---|---|
| `tabs list` 读 url/title | ✅ 可用 |
| `tabs open`/`close`/`activate` | ✅ 可用 |
| `navigate` 到该页 | ✅ 可用 |
| 需要 CDP 的读写 | ❌ 永久拒绝 |

对比（**均实测**）：`file://`、`about:blank` **可**正常 attach；
本扩展自己的页面也不受限（**受限的只有"其他"扩展**）。

> 分类器初版曾把 `about:blank` 误判为受限，实测后修正为**显式枚举受限 scheme**，
> 而非"凡非 http(s) 即拒"——误判会白白放弃本可完成的工作。

### 修复

- 新增 `classifyRestriction()`/`assertAttachable()`，抛出带 `code` 的结构化错误：
  `restricted_other_extension` / `restricted_browser_internal`
- `tabs.list` 标注 `restricted`，摘要内联显示，**盘点阶段即可见**
- 修掉了原先误导性的提示：旧代码在跨扩展错误后追加「(DevTools 打开着这个页面? 先关掉)」
  —— 对这类目标**归因错误**，会诱导模型反复重试一个永久性条件

---

## 5. 实测性能数据（本轮全面测试）

**所有数据来自真实浏览器调用**（实际是 **Edge 151**，非 Chrome——同为 Chromium 内核，
不影响功能，但文档与插件文案里的"Chrome"字样并不准确）。工具为 fork 版插件 +
v1.0.7 扩展，两者均已确认在运行。

### 5.1 各工具延迟与体积

| 工具 | 延迟 | 返回体积 | 备注 |
|---|---|---|---|
| `tabs list` | 4ms | 2,105B | 19 标签 |
| `evaluate`(轻) | 21–32ms | 124–158B | **最省** |
| `evaluate`(热) | 2–3ms | ~33B | 附着命中时极快 |
| `read`(text) | 23ms | 7,743B | GitHub 页 |
| `read`(html) | 37ms | **127,925B** | ⚠️ 见 5.3 |
| `snapshot` | 35ms | 14,917B | 默认 limit |
| `snapshot`(limit50) | 46ms | 4,472B | 限流有效 |
| `screenshot` | **713ms** | 298B | ⚠️ 最慢 |
| `click`(命中) | 161ms | 106B | 含前台切换 |
| `click`(未命中) | 3ms(热) | — | 首次含附着开销 |
| `type`(fill) | 28ms | 74B | |
| `scroll` | 6ms | 90B | 走 evaluate，快 |
| `press` | 50ms | 35B | |
| `tabs open` | 39ms | 62B | |
| `tabs close` | 21ms | 21B | |
| `cleanup` | 5ms | 38B | |
| `evaluate`(不存在 tab) | 3ms | 0B | 错误路径极快 |

### 5.2 冷热差异

首次附着有明显一次性开销；附着命中后 `evaluate` 降到 **2–3ms**。
→ **长任务应优先复用同一 tabId**，避免反复触发 attach。

### 5.2b 完整工具矩阵验证（fork 版，重启后实测）

确认插件层已真正加载（此前曾长期加载 npm 原版而未生效，见第 7 节），逐项验证：

| 工具 | 结果 | 焦点 |
|---|---|---|
| `browser_evaluate` | ✅ `"PROBE"` | 未变 |
| `browser_read` | ✅ title + 87B | 未变 |
| `browser_snapshot` | ✅ 1 item | 未变 |
| `browser_scroll` | ✅ 返回 scrollY/pageHeight | 未变 |
| `browser_press` | ✅ 真实按键 | 未变 |
| `browser_press` + `expect` | ✅ `matched:true, waitedMs:1` | 未变 |
| `browser_click`(preserve) + `expect` | ✅ `inputDegraded: dom-synthetic` | 未变 |
| `browser_type`(mode:type) + `expect` | ✅ `keys:["P","L","U","G","I","N"]` | 未变 |

**8/8 通过，用户标签全程保持在 `edge://extensions/`。**

### 5.3 token 成本：读取策略在真实站点上差 200–1400 倍

在三个真实站点上对比同一页面的不同读法（返回体积，单位字节）：

| 站点 | `evaluate`(精准取数) | `read`(text) | `snapshot`(limit40) | `read`(html) | **html/eval** |
|---|---|---|---|---|---|
| GitHub | **90** | 577 | 2,600 | 126,695 | **1408x** |
| Bilibili | **93** | 2,061 | 3,291 | 124,331 | **1337x** |
| arXiv | **66** | 117 | 83 | 13,990 | **212x** |

**`read(html)` 比精准 `evaluate` 贵 200–1400 倍**，且极少提供 `evaluate` 拿不到的信息。
这是本插件最大的单点浪费，也是 P0 成本阶梯最主要的依据。

> 注：早前版本的本节只测了 GitHub 单页，得出"219 倍"。扩到三站点后真实差距更大 —— 
> **单页数据不足以支撑结论**，这是本节自身的教训。

**结论**：能用 `evaluate` 精准取数就不要 `read(text)`；**几乎永远不要用 `read(html)`**。

---

## 6. ASIL 论文视角的优化方向

> 论文：**ASIL: Replacing Screenshot-and-Click with Structured State and Semantic Actions**
> arXiv:2608.26991 · 本机采纳分析见另外那份文档

### 6.1 为什么用 ASIL 分析这个插件

论文核心主张是**更换观测-动作契约**：
`pixels → coordinates → motor events` 换成 `structured state → semantic action → check`。

本插件恰好**同时包含两端**：

- `browser_evaluate` / `browser_read` / `browser_snapshot` → 已是**结构化观测**
- `browser_screenshot` + 视觉判断 → 仍是 **pixel 路径**（论文 §3.1：每一步都为视觉编码付费）

论文自陈的消融实验很关键：**GIMP 任务 ASIL-only 44.1 vs 加截图 43.7** —— **加截图没用**。
本插件的 `browser_screenshot` 实测 **713ms**，是第二慢工具，且输出的是**文件路径**
（还需再花一次 `read_image` 才能看），成本极高。

### 6.2 采纳 ASIL 的「最深可行路径」阶梯（本 fork 已隐含实现）

论文 §5.2 结论：**成熟原生接口已存在时，ASIL 的正确用法是把它作为访问路径吸收**，
而不是重写。对本插件的映射：

| 层级 | 工具 | ASIL 定位 | 实测成本 |
|---|---|---|---|
| 1️⃣ 首选 | `browser_evaluate`（读 DOM/结构化状态） | Pattern A/C 等价 | **2–32ms, ~100B** |
| 2️⃣ | `browser_read`(text) | 结构化文本 | 23ms, 7.7KB |
| 3️⃣ | `browser_snapshot` → `browser_click(ref)` | **语义动作**（按 ref 而非坐标） | 35ms + 161ms |
| 4️⃣ 最后手段 | `browser_screenshot` | 残余感知任务 | **713ms + 读图** |

**这正好解释了 `read(html)` 为什么该被劝退**——它比精准 evaluate 贵
**200–1400 倍**（见 5.3），却几乎从不提供 evaluate 拿不到的信息。

### 6.3 与论文「语义动作 + 终态校验」的对照

本插件的 `ref` 机制（`browser_snapshot` → `e01` → `browser_click(ref)`）
已经是 ASIL 说的 **Stability**（标识符在表现层变化下保持有效，比坐标稳定）。

但**缺 ASIL 的后半截**：

1. **动作缺少 schema 约束与终态校验** → ✅ **已由 P1 补齐**。
   `click`/`type`/`press` 现在接受 `expect: {selector|text|gone|target+value}`，
   在同一调用内完成 act+check 并返回 `expected.matched`。
   设计上刻意把**超时当作答案而非异常**（返回 `{matched:false, timedOut:true}`），
   否则调用方无法区分"没等到"与"调用硬失败"，会误触发重试。
   注意 `hitVerified` 仍是局部校验且 preserve 下恒为 `false`，`expect` 是它的替代。
2. **轨迹未序列化**。ASIL 的 SFT/RL 全靠 (observation, action, evaluator outcome)
   三元组。本插件不产出这类结构。**评估后决定不做**，理由见 6.4。

### 6.4 可落地的优化建议（按性价比）

| 优先级 | 建议 | 状态 | 依据 |
|---|---|---|---|
| **P0** | 工具描述内联"成本阶梯"，让模型优先选便宜路径 | ✅ **已实施** | ASIL §5.2；实测 200–1400x 差距 |
| **P1** | 为 `click`/`type`/`press` 增加 `expect`，一步内完成 act+check | ✅ **已实施** | ASIL 语义动作 + 终态校验 |
| ~~P2~~ | ~~可选轨迹输出 (observation, action, outcome) JSONL~~ | ❌ **决定不做** | 见下方理由 |
| P1' | `screenshot` 默认返回**内联图片**而非文件路径（省一次 `read_image` 往返） | ⏸ 待定 | 实测 713ms + 额外一次调用；涉及接口语义变更，需决策 |

#### 为什么 P2（轨迹序列化）不做

ASIL 的轨迹有**明确消费方**——喂给 SFT/RL 训练（论文用数千条 step-level 样本把
2B 模型从 58.0 拉到 72.1）。但训练需要 4–8×A800，本机没有。轨迹写出来之后
**没有任何东西会读它**，只会变成一份不断增长、无人消费的日志。

本机 `dsh-watcher` 记的是**诊断日志**（喂给 `dsh-error-triage`），有明确消费者，
这个分工是合理的。而 P1 的 `expect` 让每次调用**当场**返回判定结果——在线收益比
事后从日志里挖更直接。

**若将来要做，唯一有意义的形态是窄口径失败样本收集**：当 `expect.matched === false`
时记录 (工具, 参数, 期望, 实际观测)。它服务于一个具体决策——**`focusPolicy` 的默认值**：
若常用站点中需要 `steal` 的比例很高，说明 `preserve` 做默认值不合适。这比通用轨迹
小一个数量级，且有决策要支撑。

> ⚠️ **不要**照搬论文主表 "81.6 vs 6.6"。论文自己承认提示不对称（29/30 vs 26/30），
> 主表**不能**单独归因于接口变量。也别指望这些改动带来数量级提升。

---

## 7. 旧文档中被证伪的结论（速查）

| 旧结论 | 实测结果 | 正确说法 |
|---|---|---|
| 脱离后基本无法恢复，必须新开标签 | ❌ **已修复** | 缓存短路所致；修复后自动重挂 |
| `tabs list` 返回被截断（17 显示 4） | ❌ 数据层完整 | 是**渲染层** `.slice(0,400)` 所致 |
| `evaluate` 默认超时 60000 | ❌ 代码为 `\|\| null` | **省略即无客户端超时**；100 只是非法输入的下限兜底 |
| `eval timeout after 100ms` 是默认行为 | ❌ 归因错误 | 系非法 `timeoutMs` 落到下限，现已支持透传 |
| chrome-extension:// 页面完全不可访问 | ⚠️ 过宽 | tabs list/open/close/navigate **仍可用**，仅 CDP 读写被拒 |
| **源码注释**：`Real key events require the tab to have OS-level focus` | ❌ **错误前提** | 实测按键走后台标签完全正常。该注释把鼠标的**坐标依赖**错误推广到了所有输入事件，直接导致了不必要的降级设计 |

### 7.1 方法论教训：单页样本不足以支撑结论

本节自身犯过一次同类错误：5.3 最初只测了 GitHub 单页，得出"read(html) 贵 219 倍"。
扩到三站点后，真实差距是 **200–1400 倍**。**单点测量容易低估问题的规模。**

### 7.2 更严重的教训：「构建成功」≠「已生效」

第 5 节的性能数据、以及本 fork 的**四个插件层改动**（`focusPolicy` / `summarizeTabs` /
`expect` / P0 提示词），曾**长期没有生效**——而 typecheck、build、git push 全部通过。

原因：DSH 加载的是 npm 安装的 **未修改 1.0.7**（`node_modules/@caob23/dsh-browser-control`，
46,301B），而 fork 的构建产物（69,065B）从未被使用：

```
npm 原版 : clampText ✅ | focusPolicy ❌ | summarizeTabs ❌ | expect ❌
fork     : focusPolicy ✅ | summarizeTabs ✅ | expect ✅ | 成本阶梯 ✅
```

发现路径很曲折：测试 `browser_type(mode:"type")` 时它始终返回 `mode:"fill"`，
我先后怀疑了扩展未重载、参数未透传，最后对比两个 `lib/index.js` 才发现根因。

**修正方式**：把 profile 依赖从 npm 版改为 `file:` 挂载 fork：

```bash
cd ~/.dsh/profiles/desktop
pnpm remove @caob23/dsh-browser-control
pnpm add "file:D:/VibeCoding/project/dsh-plugin/dsh-browser-control"
```

> ⚠️ **必须显式 `file:` 前缀**。裸路径会被 pnpm 当作 `link:`，在 hoisted 布局下
> 无法正确物化。（本 profile 的 `link:` 依赖是 junction，`file:` 依赖是复制。）

**教训**：对插件类改动，「构建成功」「推送成功」**都不等于「已生效」**。
必须独立验证加载来源 —— 最省事的办法是在 fork 里加一个可观测特征（如本 fork 的
`summarizeTabs`），重启后看它是否出现。

---

## 8. 本 fork 相对 upstream 的改动

| commit | 内容 | 是否已提 upstream |
|---|---|---|
| `8494fcb` | CDP 脱离缓存失效 + 自动重挂 | ✅ **PR #7** |
| `b5fb106` | 焦点保全 + 标签摘要 + evaluate 超时透传 | ❌ 待定（行为变更需维护者拍板） |
| `3e24c63` | 受限目标识别 + 结构化错误 + 文档 | ❌ 待定 |
| `8fd91a9` | 本文档 | — |
| `bd85ae6` | P0 成本阶梯 + P1 `expect` 终态校验 | ❌ 待定 |

**本机部署状态**（截至本文档更新时）：

| 组件 | 来源 | 状态 |
|---|---|---|
| 插件 | `file:D:/VibeCoding/project/dsh-plugin/dsh-browser-control` | ✅ 已生效（重启后确认） |
| 扩展 | `~/.dsh/browser-control-extension`（v1.0.7 + fork 修复） | ✅ 已生效 |
| 回滚备份 | `package.json.bak-before-fork-<时间戳` | 可还原为 npm 版 |

---

## 9. 五条使用铁律（修正版）

1. **少动**：少导航、少开标签、少截图。**能 `evaluate` 精准取数就不 `read(text)`，
   能 `read(text)` 就不 `read(html)`（实测差 200–1400 倍），能读 DOM 就不截图。**
2. **复用**：附着命中后 evaluate 仅需 2–3ms；**长任务复用同一 tabId**，不要反复换标签。
3. **说清结果**：动作用 `expect` 声明成功条件，一次调用拿到判定，
   不要"操作完再截图看一眼"。`matched:false` 是"没观察到"，不是"调用失败"。
4. **交人**：扩展页、验证码、浏览器内置页 —— 直接交给用户，并给 2–3 条备选路径。
   **但"调试器脱离"不再属于此类** —— 修复后它会自动恢复，先重试一次再考虑换标签。
5. **验证生效而非验证构建**：改插件后必须确认它**真的被加载**（见 7.2）。
   typecheck/build/push 通过不等于运行时生效。
