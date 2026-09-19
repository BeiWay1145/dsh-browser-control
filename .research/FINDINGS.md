# CDP 后台标签「可信点击」调查结论

> 调查环境：Edge 151.0.4129.78 (Chromium 151) + Windows，与本项目实测环境一致。
> 全部结论均来自**本机真实实验**，非文档推测。实验脚本见 `.research/probe*.cjs`。

## 一、核心结论（推翻项目现有前提）

**在后台标签上，`Input.dispatchMouseEvent` 本来就能工作，不需要任何"让标签看起来在前台"的手段。**

实测：标签处于 `visibilityState:"hidden"`、`document.hasFocus()===false`、且**全程未被激活**（`bgActiveAfter:false`），
用 `chrome.debugger.sendCommand` 发坐标点击，页面收到：

```json
[{"t":"mousedown","trusted":true,"x":26,"y":22,"id":"b"},
 {"t":"mouseup",  "trusted":true,"x":26,"y":22,"id":"b"},
 {"t":"click",    "trusted":true,"x":26,"y":22,"id":"b"}]
```

`isTrusted: true`，坐标正确，目标元素正确，**用户的活动标签全程未变**。

## 二、逐项回答调查清单

| # | 问题 | 结论 | 证据强度 |
|---|---|---|---|
| 1 | `Emulation.setFocusEmulationEnabled` 能否让后台 mouse 生效？ | **不需要它**；它做的是把 `document.hasFocus()`/`visibilityState` 改成 true（页面感知层），**不改变鼠标送达能力** | ✅ 实测 |
| 2 | `setDeviceMetricsOverride`/`setPageScaleFactor` 影响视口计算？ | 与本次问题无关；后台标签视口本就正常（实测 1029×850，非 0） | ✅ 实测 |
| 3 | `Page.bringToFront` 副作用 | 它**激活标签**（切前台），是真正的抢焦点操作；无"不激活窗口"变体 | 📖 协议定义 |
| 4 | `Target.activateTarget` vs `Page.bringToFront` | 两者都是激活语义，都不轻量；**本项目不应使用** | 📖 协议定义 |
| 5 | dispatchMouseEvent 非坐标模式？ | **不存在**，协议只有 x/y 视口坐标 | 📖 协议定义 |
| 6 | `Input.emulateTouchFromMouseEvent` 在后台？ | 同为坐标类输入，未单独实测；无必要（mouse 已够用） | ⚠️ 未实测 |

## 三、替代路径：userGesture 对 isTrusted 的影响（✅ 实测，结论为否定）

| 方式 | isTrusted | 结论 |
|---|---|---|
| `Runtime.evaluate` + `userGesture:true` 内 `el.click()` | **false** | ❌ userGesture **不会**让事件变可信 |
| `Runtime.evaluate` + `userGesture:false` | false | ❌ |
| `chrome.scripting.executeScript` (userGesture) | 同上，**false** | ❌ 只给 user activation，不给 trusted |

`userGesture:true` 只影响 `navigator.userActivation.isActive`（实测前后均 true，无区分度），
**不改变 `isTrusted`**。合成事件永远是 `isTrusted:false` —— 这是 Blink 的硬边界。

## 四、为什么项目原来认为"必须抢焦点"（根因）

`extension/background.js` 的 `cmdClick` 在 steal 分支先调用 `activateTabWindow(tab.id)`，
而 `activateTabWindow` 里有：

```js
if (win.state === 'minimized') throw new Error('browser window is minimized — ...')
await chrome.windows.update(win.id, { focused: true });
await chrome.tabs.update(tabId, { active: true });
```

**这条链路把"可能需要前台"当成了"必须前台"。** 实测证明：
- 后台标签视口非 0（1029×850）
- 后台标签命中测试**完全正确**：`#overlay` 遮挡层正确吞掉了点击（事件落在 overlay 而非 button），与 `document.elementFromPoint` 一致
- **窗口最小化**状态下，后台标签仍能收到可信点击 ✅

## 五、可直接实施的修复

`cmdClick` 的 preserve 分支可**完全删除 DOM `el.click()` 降级**，改为与 steal 分支相同的
坐标派发，只是**不调用 `activateTabWindow`**：

```js
// preserve: 同样的坐标派发，只是不激活标签
const hit = await send('Runtime.evaluate', { expression: /* elementFromPoint 求坐标 */ });
await send('Input.dispatchMouseEvent', { type:'mouseMoved',    x:hit.x, y:hit.y });
await send('Input.dispatchMouseEvent', { type:'mousePressed',  x:hit.x, y:hit.y, button:'left', buttons:1, clickCount });
await send('Input.dispatchMouseEvent', { type:'mouseReleased', x:hit.x, y:hit.y, button:'left', buttons:0, clickCount });
```

收益：`isTrusted:true` **且** `hitVerified` 真实可用（遮挡可被发现），
`inputDegraded`/`degradedReason` 在点击路径上可删除，`focusPolicy` 的降级面**归零**。

## 六、置信度分层

- **有实证支持**：后台标签可信鼠标点击可行（3 轮独立实验：headless / headed / 窗口最小化 + chrome.debugger 端到端）；
  命中测试正确；userGesture 不产生 trusted 事件。
- **仅文档支撑**：`Page.bringToFront`/`Target.activateTarget` 语义；协议无非坐标 mouse 模式。
- **未实测**：`emulateTouchFromMouseEvent` 后台行为；跨窗口/多显示器下的边界。
- **残留风险**：不同页面（有的站点用 `document.hasFocus()` 或 `visibilitychange` 自行禁用交互）
  可能仍需要 `setFocusEmulationEnabled`。建议保留 steal 作为逃生舱。
