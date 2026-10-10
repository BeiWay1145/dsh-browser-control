# 更新日志

## v1.0.8 (2026-10-10)

- 发布资产修了两处（自查）：v1.0.7 的 `dsh-browser-control-plugin-v1.0.7.zip` 和扩展包一样带 multipart 前言（实测头 4 字节 `2d2d2d2d`，不是 `PK\x03\x04`，资源管理器拒展开——#2 里「压缩包还是有问题」的另一半原因），并且**缺 `cordis.patch.yml`**，而 `package.json` 的 `dsh.bundle.patch` 正指向它，从这份离线包安装等于没挂载插件。本版两份资产都重新打包并附 `.sha256`。
- 兼容提示（**行为变更，升级前先看**）：`/api/command`、`/api/cleanup` 现在必须带 Token，任何脚本化调用都要改；`Access-Control-Allow-Origin: *` 全部移除。

- 修复 #5：文档不再承诺 npm bundle 一定有「设置 → 插件」卡片。README（中英）与 `dsh-config/README.md` 改为按宿主版本分述：dsh 0.1.7+/0.2.x（dsh-settings 0.1.7-rc.2 起）由宿主按插件自身 `Config` schema 自动投影出设置节，看得到也改得动；0.1.2 及更早没有客户端半区认领命名空间，卡片不渲染，配置只能走 profile 覆盖层。桥接未启用时工具报错的文案也不再指向可能不存在的设置入口（`src/index.ts`）。
- 新增 `verify/`：五个纯 node 实测台（配置解析、三种宿主形状的 `apply()`、HTTP 鉴权与升级来源、发布产物行为、README 资产死链），`npm run verify` 一条命令跑完，用法与副作用记在 `verify/README.md`。顺带纠正 README「已验证」里那条早已不存在的「单元测试 29/29」（`tests/` 在 v1.0.4 就删了），并把历史浏览器场景与本版实测分开标注。
- 文档：`llms.txt` 里的路径还停在 v1.0.2 的 `plugin/src/...` 布局、工具数写的 11，已改为当前 `src/` + `lib/` + `verify/` 结构与 16 个工具，并补上「Token 才是边界」一节。`CONTRIBUTING.md` / `docs/en/CONTRIBUTING.en.md` 整体重写（旧内容让贡献者去 clone deepseek-harness、复制并不存在的 `plugin/`、跑已被删除的 29 个 vitest 用例），换成 `npm run check` / `npm run verify` 的真实流程，并记下扩展 zip 必须是 `PK` 头 + 正斜杠条目（issue #2 的教训）与宿主 API 的版本坑。
- 扩展：`extension/popup.js` 未连接时的提示不再指向「dsh 设置 → 插件」（老宿主没这个入口）。**副作用**：仓库 `extension/` 与已发布的 v1.0.7 扩展资产不再逐字节一致，下次发布必须重新打一份扩展 zip。
- chore：`.gitignore` 增加 `dsh-browser-shots/`（实测台会在仓库根建它）。

- 修复 #3 / #6 第二步（鉴权，**行为变更**）：`/api/command`、`/api/cleanup` 现在要求 Token，形式与 WS 同一个凭据——`Authorization: Bearer <token>`、`X-Token: <token>` 或 `?token=<token>`，缺失或不对一律 401；比较改成常数时间（`timingSafeEqual`）。WebSocket 升级另加 `Host` 必须是回环地址（挡 DNS 重绑定，403）与 `Origin` 校验：拒绝任何网页来源，放行 `*-extension://` 与不发 Origin 的本机客户端。`/` 与 `/api/status` 保持免鉴权只读（状态页要用）。实测 19 项全过：无 token 的命令面从「200 且真的驱动扩展」变为 401，带 token 的 `nav` 仍然正常执行，`evil.example` Host 与 `https://evil.example` Origin 均 403，扩展来源与常规握手仍 101。
- 状态页：清理按钮改为索取 Token（只存 sessionStorage，不写盘），并新增「令牌强度」一行；Token 仍是默认的 `dsh-local` 或短于 16 字符时，桥接启动即在日志里告警。**这里刻意没有采纳报告者「拒绝启动」的建议**——那会让所有现存配对当场断连，改成告警 + 页面标红；要硬拒绝可以再说。
- 文档纠偏：`SECURITY.md` / `docs/en/SECURITY.en.md` 重写「安全边界 / 已知限制」，明确回环绑定不是隔离边界、Token 才是，同机任意知道 Token 的进程仍可驱动浏览器；并撤回 v1.0.6 里那句「`allowEval` 默认 false」——全仓库从未实现过该开关（grep 只在 CHANGELOG 出现），`eval` 一直可用。README 增加脚本直连 HTTP 的 Token 用法与 401 说明。

- 修复 #3 / #6 第一步（CORS）：HTTP 面不再出现任何 `Access-Control-Allow-Origin`。原先 `handleHttp()` 的 OPTIONS 预检与 `respondJson()`（所有 JSON 响应的公共出口）都回 `*`，等于把「本机任意网页可读走桥响应」变成默认。状态页与自身 `fetch` 同源、扩展只走 WebSocket，因此直接去掉通配而不是换成白名单。实测（起真实 `BridgeServer` + 假扩展客户端）：`/api/status`、`/api/command`、`OPTIONS` 三类响应头均无 ACAO/Allow-Methods，状态页 200 正常，且同一请求确实驱动扩展执行了 `nav`（证明这是真实可达面，不是空转）。

- 修复 #8：settings 接线改为特性探测。`sctx.settings.register` 只存在于 dsh-settings 0.1.2-rc.1 及更早（实测 `0.1.2-rc.1` 的 `lib/index.js:281` 有 `register`，`0.1.7-rc.2` 与 `0.2.0-rc.2` 只导出 `SettingsForms`，方法为 `configure/describe/update/replace/mutate`）。原代码在注入回调里直接调用它，新宿主上抛 `TypeError`，回调后半段的 `controller.reconcile()` 与 `scope.watch()` 一起被跳过。现在：没有 `register` 就走 profile 配置并把设置页交给宿主的自动投影（`configure({auto:true})`），`register` 抛错也有兜底，两条路径都保证桥接收敛。三种宿主形状实测（假 settings 服务）：legacy / register-throws / no-register 全部「回调不抛、9777 监听、16 个工具注册」，且 legacy 路径的实时开关回归仍成立（改 false 端口关闭、改回 true 重开）。
- 兼容：`package.json` 的 peer/devDependencies 上界从 `<0.2.0-0` 放宽到 `<0.3.0-0`。dsh 的 `latest` 已经是 `0.2.0-rc.2`，旧上界会让新宿主装插件时 peer 解析不到；实测 `@deepseek-ai/dsh-tools@0.2.0-rc.2` 的导出面与 0.1.0-rc.8 完全一致（含 `defineTool`），放宽无运行时风险。
- 修复（无人报告，自查发现）：`lib/` 构建产物落后于 `src/`。`0e0696c` 加完 v1.0.7 的 4 类新工具后没有重新打包，仓库里提交的 bundle 与 **npm 已发布的 `@caob23/dsh-browser-control@1.0.7` 都只注册 11 个 `browser_*` 工具**，而 README 工具表写的是 16 个——npm 安装的用户实际缺 `browser_console_log`、`browser_network_log`、`browser_network_clear`、`browser_pdf`、`browser_emulate`。已按 `src/` 重新构建，实测 `apply()` 注册满 16 个。
- 修复 #2 收尾：README（中英）的扩展下载链接指向 release 上真实存在的 `DSH-Browser-Control-v1.0.7.zip`。原链接 `DSH-Browser-Control-1.0.7.zip` 已不存在（实测 404），用户只能拿到那份带 multipart 前缀的坏资产（头 4 字节 `2d2d2d2d`，`PK` 在第 162 字节），资源管理器因此拒绝展开。现链接的包实测：头 `504b0304`、全正斜杠条目、CRC 全过、sha256 `1836b20ea9b5d85291606fde2b3a809d87f88c60edd27922cc9c92e243694ad7`，内容与仓库 `extension/` 逐字节一致。
- 修复 #4：`cordis.patch.yml` 里写死的 `enabled: false` 覆盖了 v1.0.6 的 schema 默认值 `true`，导致 `dsh plugin add` 装完后 9777 无人监听、扩展报 `ERR_CONNECTION_REFUSED`。包内 patch 改为 `enabled: true`，实测（`Config({enabled:false,…}) → false`、`Config({enabled:true,…}) → true`）确认显式值优先于默认值，即该字段就是根因。
- 文档：`README.md` / `README.en.md` / `SECURITY.md` / `docs/en/SECURITY.en.md` / `dsh-config/README.md` 里「默认关闭、设置页手动开启」的旧口径统一为「默认开启」；关开关的正确写法改为 profile 覆盖层按 `id` 覆盖 config（原文的 `~/.dsh/settings.yml` 与 `- merge:` 均非实际生效路径）。

## v1.0.7 (2026-09-04)

- 新增：`browser_console_log` — 抓取页面 console.log/info/warn/error/debug；可按 level + regex 过滤，可 `clear:true` 清空。CDP 域 `Runtime.enable` 已在 attach 时常驻，不再 lazy。
- 新增：`browser_network_log` — 抓取 HTTP 请求/响应完整生命周期（`requestWillBeSent` → `responseReceived` → `loadingFinished`/`loadingFailed`）。可按 methodPattern/urlPattern/status 过滤；`includeStatic:true` 包含图片/字体/样式/脚本（默认过滤掉）。`browser_network_clear` 单独清空。
- 新增：`browser_pdf` — 调用 `Page.printToPDF` 导出 PDF 到 `path`（绝对路径）或 shotsDir（默认）。可选 landscape / paperWidth / paperHeight / scale / pageRanges / printBackground。PDF 文字可选中可搜索，比 screenshot 更适合长文 article。
- 新增：`browser_emulate` — 切换视口到 `desktop` / `mobile-iphone-13` / `mobile-pixel-7` / `tablet-ipad` 预设，或自定义 width/height/deviceScaleFactor/isMobile/hasTouch/userAgent。`device:"reset"` 还原。
- 内部：extension/background.js 增强 `chrome.debugger.onEvent` 监听器同时处理 `Page.javascriptDialogOpening` + `Runtime.consoleAPICalled` + 4 个 `Network.*` 事件，按 `tabId` 隔离缓冲；attach 时常驻 `Runtime.enable` + `Network.enable`。
- 资源：每 tab console 缓冲上限 500 条，network 上限 500 条（LRU）；POST body 截断 64KB；请求过滤默认排除 `Image/Font/Stylesheet/Script/Favicon/Manifest`。
- 文档：README 工具清单加入 4 个新工具

## v1.0.6 (2026-09-03)

- 变更：`Config.enabled` schema 默认值从 `false` 改为 `true`，装上即默认启动桥接（issue #1 反馈：之前需要手动在 setting 文件加 `enabled: true` 才能用）
- 安全：`allowEval` 默认仍为 `false`，启用 eval 仍需显式配置 —— **此条有误，该开关从未实现过**，更正见 Unreleased
- 配套：CHANGELOG/README 同步更新启用行为说明

## v1.0.5 (2026-09-03)

- 修复：在新版 `@deepseek-ai/dsh-settings`（0.1.2-alpha.* 起）下插件加载失败（issue #1）
  - 原因：旧版源码对 dsh-settings 的 `installSettingsSection` 与 `settingsNamespace` 两个 helper 有静态 import；新版本里这两个 helper 已被改造成 `SettingsProvider.installSection` 方法 + 字符串字面量类型，对应能力保留但 helper 移除 → 旧插件 ESM 解析时找不到 export，整个插件加载 throw
  - 修复：绕开 helper，直接调底层 `sctx.settings.register(ns, schema, { base, validate })` API（该方法在 dsh-settings 所有发布版本上都存在），`BROWSER_BRIDGE_SETTINGS_NAMESPACE` 改为普通字符串字面量
  - 升级：`pnpm update @caob23/dsh-browser-control` 或重装 `@caob23/dsh-browser-control@^1.0.5`

## v1.0.4 (2026-08-23)

- 变更：许可证 MIT → **AGPL-3.0**。个人/学术/非商业免费；企业闭源商用需商业许可（联系：GitHub Issues 或 caob2333@outlook.com）
- 文档：SECURITY.md 允许非可利用问题直接提 Issue（中英双语）
- 文档：dsh-config/README.md 重写为配置项参考（patch 字段、默认值、用户层覆盖示例）
- 清理：移除 tests/、fixtures/ 与未使用的 icon-svg.ts；英文文档归档到 docs/en/
- 安装方式与 v1.0.3 一致：npm / GitHub / 本地 file: 三种来源

## v1.0.3 (2026-08-23)

- 新增：插件按 dsh Profile Bundle 规范打包，一条命令安装
  `dsh plugin --profile web add github:caob23/dsh-browser-control#v1.0.3`
  （npm 发布后也可 `dsh plugin --profile web add @caob23/dsh-browser-control`）
- 变更：npm 包名从 in-tree 的 `@deepseek-ai/dsh-browser-bridge` 改为用户 scope 的 `@caob23/dsh-browser-control`
- 变更：插件源码上移到仓库根，独立于 harness 工作区构建（tsc + tsdown），构建产物 `lib/` 随仓库提交，GitHub 安装零编译
- 旧「复制进 harness 源码树」方式保留在 v1.0.2 tag；迁移时删除旧副本避免 browser-bridge id 重复挂载

## v1.0.2 (2026-08-23)

16 项验收意见修复，另加饱和回归中新发现并修复的 10 个缺陷。

弹窗与交互：

- 新增 `dialog` 命令：全局自动应答策略（accept / dismiss / manual）读取与切换，含最近 50 条弹窗日志
- MV3 service worker 常驻监听 `Page.javascriptDialogOpening`，alert/confirm/prompt/beforeunload 全类型自动应答，prompt 支持自定义应答文本
- 连续链式弹窗（一次点击多个 prompt）逐个依次应答
- 输入新增 `mode:'type'` 真实键盘通道：逐字符 keyDown/keyUp，回车映射 Enter；默认 fill 模式保持直写

键盘与焦点健壮性：

- 键盘/鼠标事件前自动聚焦目标窗口并激活标签页；**绝不修改窗口尺寸、位置或状态**（含最大化状态），最小化窗口返回结构化 `window_minimized` 错误而非擅自还原
- 非 ASCII 字符（中文/emoji）改走 `Input.insertText` 真实插入通道，不再被协议损坏成 `?`
- 移除多余的 char 事件，修复 ASCII 字符被插入两次
- Enter 事件携带 `text:'\r'`，表单隐式提交恢复正常

求值与序列化：

- 页面导航中断求值时返回结构化 `context_destroyed` 错误（覆盖 -32000 "Inspected target navigated or closed" 变体），不再挂满超时
- 序列化重写为两步架构：先取 RemoteObject 元数据分类，再经 `callFunctionOn` 按值转移；DOM 节点、函数、Map/Set 等不可转移值诚实报错，杜绝静默 `{}`（新版 Chrome returnByValue 行为变更）
- `eval` 支持 `timeoutMs` 竞速超时，慢 Promise 不再拖满桥接默认 60s
- `eval` 支持 `frameSelector` 同源 iframe 求值，document/window 经参数影子化重绑定（修复 TDZ 报错）；`argNames`+`args` 参数化注入

导航与等待：

- 死站点导航返回结构化 `siteUnreachable:{reason:dns|unreachable}`，经页面内 location.href 探测 chrome-error 页，中英文错误文案均可分类
- 新增 `wait` 命令：selector / text / fn 三种条件 50ms 轮询等待，fn 同时接受谓词函数与布尔表达式，timeoutMs 上限 120s

工具输出：

- `click` 返回命中校验（hitVerified）、点击坐标、元素信息及连带应答的弹窗数
- `screenshot` 支持 selector 元素裁剪截图并返回 elementRect
- `tabs.list` 精简为紧凑结构（id/url/title/active 等）
- snapshot 增加 total 计数与每项 type/value/rect 字段

## v1.0.1 (2026-08-23)

- 修复：已连接时圆点显示为绿色呼吸动画（此前因 CSS 类名错位误显示红色）
- 新增：弹窗一键「断开连接」；断开后不再自动重连，点「立即连接」恢复
- 文档：新增鲸鱼插画横幅，README / CONTRIBUTING / SECURITY 中英双语（中文默认）
- 文档：版本号和 License 徽章改为动态读取，徽章换成经典塑料风格

## v1.0.0 (2026-08-22)

- 扩展、弹窗、状态页统一鲸鱼图标
- 状态页内嵌 SVG logo
- 持久 debugger 附着（控制期间 Chrome 横幅稳定显示）
- 配置简化为端口模式（替代完整 URL）
- 状态页暗色卡片样式 + 连接信息展示

## v0.2.0 (2026-08-22)

- 持久 debugger 附着
- 桥接端口配置输入
- 状态页美化
- 29/29 单元测试通过

## v0.1.0 (2026-08-22)

- 首个发布版本
