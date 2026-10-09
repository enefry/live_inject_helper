# live_inject_helper

直播平台网页注入体验优化，以及 YYCam Web Widget v1 的 Web 侧协议样例。

面向 Web 作者的接入说明见 [docs/WEB_WIDGET_V1.md](docs/WEB_WIDGET_V1.md)。
正式 Manifest Schema、Web SDK TypeScript 声明和可注入 SDK 分别位于：

- `schema/web-widget-manifest-v1.schema.json`
- `schema/web-widget-manifest-v1.d.ts`
- `sdk/yycamwidget.d.ts`
- `sdk/yycamwidget.js`

## PandaLive

`pandalive/pandalive.json` 是 Web Widget v1 的订阅 Manifest。应用只需要
订阅这个 JSON URL，名称、图标、Main/Config 地址以及各自的 JS/CSS 会自动解析。

- `pandalive.js` / `pandalive.css` 只注入 Main 页面。
- `pandalive_broadcast.js` / `pandalive_broadcast.css` 只注入
  `configs.default` Config 页面。
- `pandalive.js` 注册 `configuration.status` Runtime；Manifest 不再引用
  `checkJS`。
- Main 和 `configs.default` 均声明 `contentMode: "mobile"`；作者可在各页面
  独立配置为 `desktop` 或 `mobile`，省略时使用 WebKit 推荐模式。
- Config 页面自动切换到登录 tab。DOM 变化和相关 `storage` 事件立即检查
  `localStorage.xDeviceInfo.ui`，并以 250 毫秒轮询补充静默状态变化。
  登录弹窗关闭且检测到有效用户 ID 后，通过 `YYCamWidget.host.completeConfig()`
  请求 Native 重载 Main 并验证状态；仅返回 `ready` 时停止监听。
  同一 Config 仍为 `needsConfiguration` 或发生可重试错误时，串行重试，
  首次返回同一 Config 的 `needsConfiguration` 时等待 500 毫秒再试；
  可重试错误和后续重试保留原退避策略，间隔逐步增加至 10 秒，每次登录最多尝试 6 次。
  达到上限后继续监听；用户 ID 改变或登录弹窗重新打开并关闭后可重新验证。

`pandalive_check.js` 已不属于 v1 运行路径；保留它仅用于迁移时对照，Native
不得下载、执行或从 Manifest 引用该文件。

## Manifest SHA-256

Manifest 的 `main.inject.js/css` 和所有 `configs.<configKey>.inject.js/css`
资源必须使用 `integrity: "sha256-<Base64 digest>"`。在资源修改后可以运行：

```sh
pandalive/update_sha256.sh
```

首次在本地 clone 后安装 pre-commit hook：

```sh
scripts/install_precommit.sh
```

Hook 以暂存区版本计算资源摘要，并自动把更新后的 Manifest 加入暂存区，避免
未暂存的脚本修改污染当前提交。资源 URL 需要能通过路径后缀对应到仓库内文件；
无法对应的外部资源会保留原配置并输出提示。

## Tests

本仓库不依赖第三方包，使用 Node.js、Python 和 POSIX shell 执行检查：

```sh
node tests/web_widget_test.js
python3 tests/manifest_test.py
sh tests/run_native_origin_policy_test.sh /path/to/YYCamTool-ios
```

PandaLive 的 Main 和 Config 已分别声明 `allowedOrigins`。默认仍是精确同源授权，
规则、公共后缀限制和安全边界见 `docs/WEB_WIDGET_V1.md` 的“显式来源白名单”。
Native 检查在 macOS 上使用真实 Swift 模型与 SDK wrapper 编译，并让 Node 验证
同一组来源的 JS/CSS guard、Main/Config SDK 和导航离开白名单后的拒绝行为。
