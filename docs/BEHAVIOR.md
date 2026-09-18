# 行为契约（Behavior Contract）

Agent 和上层脚本可以依赖的确定性语义。违反这些契约视为 bug。

## 窗口几何不可侵犯

- 自动化**绝不**修改窗口尺寸、位置或状态（最大化/还原/最小化一律不动）。真实输入所需的窗口聚焦（`focused: true`）与标签页激活不改变任何几何属性。
- 浏览器窗口处于**最小化**状态时，视口为 0×0，真实键鼠事件无法送达。此时 `type` 模式 / `press` / `click` 返回结构化错误 `window_minimized`，提示用户手动还原窗口——绝不自动还原（自动还原会把最大化窗口压成小窗）。
- `fill` 模式、`eval`、`content`、`wait` 不需要窗口前台，最小化下照常工作。

## 自动等待

- `browser_navigate` / `tabs.open` 等待 `document.readyState === 'complete'`（上限 15s，`timeoutMs` 可调）后才返回。
- **不保证** SPA 路由或懒渲染内容就绪——导航返回后再用 `browser_wait` 显式等目标元素。

## 原生弹窗（alert / confirm / prompt）

- v1.0.2+ 默认策略 `accept`：弹窗打开即自动按 OK，prompt 以 `defaultPrompt` 作为输入。
- 每次点击/输入结果带 `dialogsAnswered`（近 5 秒内该标签页被应答的弹窗数），可据此断言弹窗出现过。
- 全局策略可通过 `dialog` 命令改为 `dismiss` 或 `manual`；`manual` 下弹窗会阻塞页面线程直到工具超时。
- 近 10 条弹窗记录（类型、文本、应答方式）通过 `dialog {action:'get'}` 读取。

## 输入模式

- `browser_type` 默认 `fill`：直接设值 + input/change 事件。快，但绕过按键级逻辑。
- `mode: "type"`：逐字符真实键盘事件（keyDown→char→keyUp）。用于 React 受控组件、带联想状态的搜索框、反爬表单。速度约每字符一次 CDP 往返，长文本慎用。
- 合成赋值对百度/B站搜索框无效是已知案例（DOM 值正确但组件状态未同步）——这类站点用 `type` 模式。

## evaluate

- 返回值经 CDP `returnByValue` 序列化；不可序列化对象（DOM 节点、函数、代理）返回 `[type: not serializable — …]` 占位串而非空 `{}`。
- 页面在 Promise 挂起期间跳转 → 结构化错误 `context_destroyed: page navigated while evaluate was pending`，不会耗尽整个超时预算。
- `frameSelector` 参数支持同源 iframe（contentDocument 穿透）；跨源帧明确报错，不做静默降级。

## 截图与坐标

- 视口截图坐标为 CSS 像素；元素截图用 CDP `clip`，DPR 由 Chrome 内部处理，无需外部换算。
- 点击结果包含实际命中点 `clicked.x/y` 与 `hitVerified`（命中元素是否等于目标元素）。`hitVerified: false` 时附 `hitInstead` 字段指明实际命中的元素——典型场景是 sticky 头部/广告遮挡。

## 超时

- 所有涉及页面交互的命令接受 `timeoutMs`（毫秒）：navigate/tabs.open 默认 15000，wait 默认 15000 上限 120000。
- `browser_evaluate` 的 `timeoutMs` 可选，范围 100–120000，**省略时没有客户端超时**（内部走 `|| null`，不会强加一个默认值）。桥接层上限 300000。
  注意：早前文档写成「evaluate 默认 60000」是错的，且 `100` 只是非法输入的下限兜底，不是默认值——曾因此产生「为什么报 eval timeout after 100ms」的困惑。

## 后台标签页节流

Chrome 对非前台标签页的 `setTimeout` 强制钳制到 ≥1s。长任务注入在后台标签会显著变慢甚至超时——需要精确计时的注入先 `browser_tabs activate` 切到前台。

## 死站点检测

导航落到 `chrome-error://` 时，`browser_navigate` 结果携带 `siteUnreachable: {reason}`（dns/unreachable），且 `url` 回报为请求的目标 URL 而非内部协议地址。

## 目标受限：哪些页面永远无法自动化

Chrome 在 attach 时按 scheme 做白名单校验，**两类目标永久拒绝对其启动调试协议**。这不是插件的缺陷，也不是可绕过的：`debugger` 权限若能读取同级扩展的上下文，任何扩展都能窥探密码管理器或钱包的内部状态。

| 目标 | 报错 code | Chrome 原始文案 |
|---|---|---|
| 其他扩展的页面 `chrome-extension://<其他ID>/` | `restricted_other_extension` | `Cannot access a chrome-extension:// URL of different extension` |
| 浏览器内置页 `chrome://` `edge://` | `restricted_browser_internal` | `Cannot access chrome:// and edge:// URLs` |

**受限 ≠ 完全不可用。** 实测边界如下：

| 操作 | 受限目标上是否可用 |
|---|---|
| `browser_tabs list` 读取 url / title | ✅ 可用（并标注 `restricted` 字段） |
| `browser_tabs open` / `close` / `activate` | ✅ 可用 |
| `browser_navigate` 导航到该页 | ✅ 可用 |
| 任何需要 CDP 的读写（read/snapshot/evaluate/click/type/screenshot） | ❌ 永久拒绝 |

对比参考（均为实测）：`file://`、`about:blank` **可以**正常 attach；本扩展自己的页面也不在受限之列（受限的只有「其他」扩展）。因此受限名单是**显式枚举**而非"凡非 http(s) 即拒"——误判会白白放弃本可完成的工作。

**调用方应遵循：**

- 在盘点阶段就读 `browser_tabs list` 的 `restricted` 标记，不要在受限标签上安排工作。
- 收到 `restricted_*` 错误时**不要重试**——条件是永久的，重试只是浪费轮次。这与 `window_minimized`（需用户手动还原窗口）属于同类：应交给用户。
- 需要用户在该页操作时，给出**一条具体指令**（如「请在 Tampermonkey 页面点『安装』」），然后继续推进其余步骤。

**已评估且不成立的绕过路径**（不必再试）：`chrome.scripting.executeScript` 注入（同样受 host 限制，且无法注入其他扩展页）；`chrome.debugger` 先 attach `chrome://extensions` 再间接操作（该页本身即被拒）。
