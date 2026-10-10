# 实测台（verify/）

仓库里没有单测框架，这一批脚本就是「改完到底有没有修好」的唯一依据。每条 issue 的结论都来自它们的实际输出，不是读代码读出来的推断。

跑法：

```bash
npm run verify        # 依次跑完下面全部
node verify/verify_plugin.mjs new     # 单独跑一个
```

前提：`127.0.0.1:9777` 空闲（脚本会真的占用这个端口），依赖已 `npm install`。

| 脚本 | 证明什么 | 关联 |
|---|---|---|
| `verify_config_patch.mjs` | `Config({enabled:false})` 得到的是 `false`——即包内 `cordis.patch.yml` 的显式值压过 v1.0.6 的 schema 默认 `true`，这就是「装上后 9777 无人监听」的根因 | #4 |
| `verify_plugin.mjs [legacy\|conflict\|new]` | 用假 cordis 上下文跑真 `apply()`，三种宿主形状（有 `register` / `register` 抛错 / 根本没有 `register`）下都必须「回调不抛、端口监听、16 个工具注册」；legacy 模式还额外回归「改 `enabled` 能实时关/开端口」 | #8、#4 |
| `verify_http.mjs` | 起真实 `BridgeServer` + 假扩展 WebSocket 客户端：所有响应无 `Access-Control-Allow-*`；无 token / 错 token 的 `/api/command`、`/api/cleanup` 一律 401；带 token 仍能真正驱动扩展；`Host` 非回环与网页 `Origin` 的升级握手被 403，扩展来源与无 Origin 的 101 | #3、#6 |
| `verify_bundle_http.mjs` | 同样的鉴权，但跑的是 **发布产物 `lib/index.js`**（npm 用户实际拿到的那份），并确认默认 token 会在日志告警、`/api/status` 报 `insecureToken` | #3、#6、#8 |
| `verify_release_links.mjs` | README 里每个 `releases/download/...` 都对应一个真实存在的资产，防「文档指向 404 的包」复发（需先抓一份 releases JSON，脚本头部有命令） | #2 |

两处已知副作用：`verify_http.mjs` 会带 token 调一次 `/api/cleanup`，因此会在仓库根的 `dsh-browser-shots/` 建目录并清空它（该目录已进 `.gitignore`）；`verify_plugin.mjs legacy` 会短时关开一次 9777。

写这些脚本时踩到的坑，记在这里免得重来：

- `dsh-settings` 的导出面按版本不同：`0.1.2-rc.1` 有 `register`，`0.1.7-rc.2`/`0.2.0-rc.2` 只有 `SettingsForms`（`configure/describe/update/replace/mutate`）。想验证兼容性，不必装宿主，`npm pack @deepseek-ai/dsh-settings@<ver>` 解包 grep 就够了。
- schemastery 的 schema 本身就是校验函数：`Config(data)` 直接返回补齐默认值后的对象，没有 `.parse()`。
- cordis 的 `ctx.effect(execute, label)` 里，`execute` 的返回值才是 teardown 函数，所以注册 disposer 要写 `ctx.effect(() => dispose, 'label')`。
- 宿主 `latest` 已经是 dsh `0.2.0-rc.2`，插件 peer 上限写 `<0.2.0-0` 会让新宿主装不上；放宽前先把 0.2 的 `dsh-tools` 抓下来对比导出面（结论：`defineTool` 等完全一致）。
- 构建产物 `lib/` 是提交进仓库的，改完 `src/` 必须 `npm run build`，否则发布出去的包和源码不一致（1.0.7 已经栽过一次：npm 包只有 11 个工具，源码有 16 个）。
