# live_inject_helper

直播平台网页注入体验优化。

## PandaLive

`pandalive/pandalive.json` 是 Web Widget v1 的订阅 Manifest。应用只需要订阅
这个 JSON 地址，名称、图标、Main/Config 地址以及各自的 JS/CSS 会自动解析。

- `pandalive.js` / `pandalive.css` 只注入 Main 页面。
- `pandalive_broadcast.js` / `pandalive_broadcast.css` 只注入 Config 页面。
- `pandalive_check.js` 是独立的 `checkJS` 资源，不会作为普通页面脚本注入。

`checkJS` 会被应用下载后按函数体执行，因此必须返回协议状态对象：

```js
return { status: 'ready' };
return { status: 'needsConfiguration', reason: 'loginRequired' };
return { status: 'error', retryable: true };
```

Config helper 只注册显式调用的接口，不会自动操作页面：

```js
PandaLiveConfig.getContext();
PandaLiveConfig.waitFor('input[name="title"]');
PandaLiveConfig.setValue('input[name="title"]', '直播标题');
PandaLiveConfig.click('button[type="submit"]');
PandaLiveConfig.complete({ reason: 'broadcastSettingsSaved' });
```

具体选择器和调用时机由后续 PandaLive 配置流程补充。

## Manifest SHA-256

远程 JS/CSS 和独立 `checkJS` 资源会在提交前自动计算 SHA-256 并回写到
`pandalive/pandalive.json`。首次在本地 clone 后执行一次：

```sh
scripts/install_precommit.sh
```

Hook 以暂存区版本计算资源摘要，并自动把更新后的 Manifest 加入暂存区，避免
未暂存的脚本修改污染当前提交。资源 URL 需要能通过路径后缀对应到仓库内文件；
无法对应的外部资源会保留原配置并输出提示。
