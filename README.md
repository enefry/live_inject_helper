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
- Config helper 只注册显式调用的接口，不会自动操作页面。业务流程可以在
  确定登录完成时调用 `PandaLiveConfig.completeConfig()`，用户取消时调用
  `PandaLiveConfig.closeConfig()`。

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
```
