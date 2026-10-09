# YYCam Web Widget v1 接入说明

本文面向发布 Web Widget 的前端开发者。应用只接收一个 Manifest URL；页面地址、
注入脚本、样式和设置页均由 Manifest 描述。接入时只依赖
`window.YYCamWidget`，不要依赖 Native 的 `WKWebView`、`YYApiCore` 或
`window.webkit.messageHandlers` 细节。

正式约束见：

- `schema/web-widget-manifest-v1.schema.json`：Manifest JSON Schema
- `schema/web-widget-manifest-v1.d.ts`：Manifest TypeScript 类型
- `sdk/yycamwidget.d.ts`：运行时 SDK 类型
- `sdk/yycamwidget.js`：Native 在 `documentStart` 注入的基础 SDK

## 1. 发布结构

一个 v1 Manifest 至少包含 `schemaVersion`、`apiVersion`、`id`、`revision`、
`name` 和 `main`。需要设置页时增加 `configs`，且必须有
`configs.default`；命名 Config 的 key 使用小写字母开头的稳定标识。

```json
{
  "schemaVersion": 1,
  "apiVersion": 1,
  "id": "com.example.widget",
  "revision": "2026.09.21.1",
  "name": "Example Widget",
  "icon": {
    "url": "https://cdn.example.com/widget/icon.png"
  },
  "main": {
    "url": "https://example.com/live",
    "contentMode": "desktop",
    "inject": {
      "js": [
        {
          "id": "main-script",
          "url": "https://cdn.example.com/widget/main.js",
          "integrity": "sha256-BASE64_SHA256",
          "injectionTime": "documentEnd"
        }
      ],
      "css": []
    },
    "runtime": {
      "methods": ["configuration.status"]
    }
  },
  "configs": {
    "default": {
      "title": "Account",
      "description": "Sign in to the service",
      "url": "https://example.com/settings",
      "contentMode": "mobile",
      "inject": {
        "js": [],
        "css": []
      }
    },
    "stream": {
      "title": "Stream settings",
      "url": "https://example.com/stream"
    }
  }
}
```

`main` 和每一个 Config 是独立页面定义。它们分别拥有 URL、可选 User-Agent、
JS 和 CSS，不能从 Main 读取或继承 Config 的注入资源。Config 中即使出现
`runtime` 字段也会被 Native 忽略，这样未来扩展 Manifest 不会让旧版本错误执行
Config Runtime。

### 网页加载模式

`main.contentMode` 和 `configs.<key>.contentMode` 可分别配置为 `desktop` 或
`mobile`，互不继承。省略时使用 WebKit 推荐模式；显式 `null`、其他值或类型
均拒绝。初次加载、重定向、后续导航及 Manifest 刷新后的重载都使用该页面的配置。

声明模式且未声明 `userAgent` 时，使用 WebKit 对应模式的系统 UA；显式
`userAgent` 是完整自定义 UA，会覆盖系统 UA，因此应与加载模式一致。
加载模式变化会更新 Snapshot 摘要和 Config 执行指纹。

### URL 和资源规则

- 生产环境 Manifest、页面和 JS/CSS 必须使用 HTTPS；Debug 版本只可由应用显式
  白名单 `localhost`、`127.0.0.1` 或 `[::1]` 的 HTTP。
- 页面 URL 可以有 query/fragment，但页面获得的 Context URL 会移除 query/fragment
  和 userinfo。
- JS/CSS 必须是独立 URL，不能内联；每个可执行资源都必须有
  `integrity: "sha256-<Base64 digest>"`。
- 单个 JS/CSS 最大 1 MiB，整个 Snapshot 中 Main 和所有 Config 的 JS/CSS 总量
  最大 4 MiB；每类资源最多 32 项。
- 数组顺序是同一注入时机内的执行顺序。`injectionTime` 省略时为
  `documentEnd`。
- Native SDK 先于 Main/Config 的所有 Manifest `documentStart` JS 安装；不要假定
  JS 与 CSS 之间存在交错顺序。

未知字段会被忽略；已知字段类型错误、版本不支持、Config 缺少 `default`、key
不合法或 integrity 校验失败会使当前 Manifest/Snapshot 不生效。旧 Snapshot 存在
时应用继续使用旧版本。

## 2. Main 页面接入

Native 在 Main 页安装 SDK 后加载 Manifest 中的 JS/CSS。SDK 立即提供：

```ts
window.YYCamWidget.apiVersion; // 1
window.YYCamWidget.role;       // "main"
window.YYCamWidget.ready;      // Promise<WidgetContext>
```

所有 Host API 都返回 Promise；`ready` resolve 前的 Host 调用会等待 Native Context。
建议在脚本最外层处理异常，页面即使没有可用 Runtime 也应能正常渲染。

### 2.1 判断是否需要设置

需要设置页的 Main 在 Manifest 声明 `configuration.status`，并在页面脚本中同步
注册 handler：

```js
(function () {
  YYCamWidget.runtime.register("configuration.status", function () {
    var loggedIn = Boolean(document.querySelector("[data-user-id]"));
    if (loggedIn) {
      return { state: "ready", reason: "authenticated" };
    }
    return {
      state: "needsConfiguration",
      configKey: "default",
      reason: "loginRequired",
      message: "Please sign in before using this widget"
    };
  });
}());
```

返回规则：

- `{ state: "ready" }`：Widget 不需要打开设置页。
- `{ state: "needsConfiguration" }`：等同于要求 `configs.default`。
- `{ state: "needsConfiguration", configKey: "stream" }`：精确要求该命名
  Config；不存在时 Native 显示诊断，不会回退到 `default`。
- handler 缺失、超时、抛异常或返回非法结构时，Native 不自动打开设置页，Main
  保持可见并记录去敏诊断。

一个状态检查只返回一个 Config key；多阶段设置通过 Config 完成后让 Native 重新
加载 Main，再次调用 `configuration.status` 串联。

### 2.2 Main Host API

Main 可以调用以下 Host API：

| API | 作用 | 成功结果 |
| --- | --- | --- |
| `host.getContext()` | 获取当前 Main Context | `WidgetContext` |
| `host.openConfig(options?)` | 展示 `default` 或指定命名 Config | `{ configKey, status }` |
| `host.setCaptureMode(options)` | 修改 Main 捕获模式 | `void`（JSON `null`） |

```js
YYCamWidget.host.getContext().then(function (context) {
  console.log(context.page.origin);
});

YYCamWidget.host.openConfig({
  configKey: "stream",
  reason: "streamSettingsRequested"
}).then(function (result) {
  // presented | queued | alreadyPresented
});

YYCamWidget.host.setCaptureMode({ mode: "automatic" });
```

`openConfig()` 省略 key 时选择 `default`。语法合法但 Manifest 没有该 key 时返回
`CONFIG_PAGE_UNAVAILABLE`。直接获得全局展示位的请求会等 Config top-level navigation
成功后才以 `presented` resolve；首次加载失败以 `NAVIGATION_FAILED` reject，并释放展示
位。`queued` 只表示请求已进入全局 Config 展示队列，稍后通过
`configurationPresentationChanged` Event 得到展示、失败或取消通知。

## 3. Config 页面接入

Config 只能调用 Config Host API，不能注册 Runtime，也不能直接访问 Main 的结果。
`YYCamWidget.role` 为 `"config"`，`YYCamWidget.runtime.register()` 会同步抛出
`METHOD_NOT_ALLOWED`。

Config 可以调用以下 Host API：

| API | 作用 | 成功结果 |
| --- | --- | --- |
| `host.getContext()` | 获取当前 Config Context（含绑定的 `configKey`） | `WidgetContext` |
| `host.completeConfig(options?)` | 提交当前 Config，刷新 Snapshot、重载 Main 并复查状态 | `CompleteConfigResult` |
| `host.closeConfig(options?)` | 用户取消当前 Config，不刷新 Main | `void`（JSON `null`） |

Config 不能调用 `openConfig()` 或 `setCaptureMode()`；Main 不能调用
`completeConfig()` 或 `closeConfig()`。角色不允许的调用会以
`METHOD_NOT_ALLOWED` reject。

设置完成后调用：

```js
YYCamWidget.host.completeConfig({ reason: "loginSucceeded" })
  .then(function (result) {
    if (result.state === "ready") {
      // Main 已重新加载并确认完成，Native 随后关闭当前 Config。
      return;
    }
    // result.requiredConfig 可以要求当前或另一个命名 Config。
  })
  .catch(function (error) {
    // Main 导航或 Runtime 验证失败时 Config 保持打开。
    console.error(error.code);
  });
```

`completeConfig()` 的 Native 链路固定为：

```text
Config completeConfig()
→ 条件刷新 Manifest/资源
→ 刷新失败时继续使用当前 last-known-good Snapshot
→ 按 Snapshot 的 main.url 重载 Main
→ 调用 Main configuration.status
→ ready：resolve completeConfig，再关闭 Config
→ needsConfiguration：返回 requiredConfig，按需保持或切换 Config
```

支持提前验证的 Native 在新 Main 文档提交、当前 generation 的 Runtime 注册后即可
检查状态。仅 `ready` 可提前完成，不必等待图片、媒体等资源全部加载；其他结果继续
走导航加载完成后的正常复查。旧 generation、未授权 Origin 或用户取消后的响应无效。

返回结果的关键字段：

- `state: "ready"`：Main 已确认完成；`verification` 是 `passed` 或
  `notSupported`。
- `state: "needsConfiguration"`：仍需要设置；`requiredConfig.available` 表示
  key 是否存在，缺失时为 `false`。Native 会关闭当前不可继续的 Config、向 Main 发送
  `CONFIG_PAGE_UNAVAILABLE` 展示事件并释放全局展示位，不静默回退或自动重试缺失 key。
- `subscriptionRefresh` 为 `updated`、`notModified` 或
  `failedUsingCurrentSnapshot`。

`verification` 只表示 Main Runtime 校验结果：`passed` 表示 Manifest 声明了
`configuration.status` 且当前 Main generation 注册并返回了合法结构；`notSupported`
表示该 handler 没有声明或没有注册。`notSupported` 不是错误，Native 会按“不需要
自动配置”处理。Config 页面不执行 `configuration.status`，也不会看到 Main 的
Runtime 结果。

每个 Main/Config 页面都有自己的 Snapshot revision、generation 和 requestId。
Config 打开时固定绑定当时的 `configKey`、Origin、User-Agent、注入资源和
`executionFingerprint`；订阅刷新不会热切换正在展示的 Config。`completeConfig()`
刷新成功会激活新 Snapshot，刷新失败但旧 Snapshot 可用时使用旧 Snapshot 并返回
`subscriptionRefresh: "failedUsingCurrentSnapshot"`。只有当前 generation 的 Main
文档提交和 Runtime 复查都完成后，`state: "ready"` 才会 resolve；迟到的旧 generation
响应会被丢弃。

用户取消设置时调用：

```js
YYCamWidget.host.closeConfig({ reason: "userCancelled" });
```

这不会刷新 Main，也不会改变它在打开 Config 前的 ready/needs 状态。完成进行中
调用 `closeConfig()` 会返回 `ALREADY_IN_PROGRESS`。

## 4. Runtime、事件与 Context

### Runtime

Native 只调用同时满足以下条件的 Runtime：Manifest 声明、当前 Native 版本认识、
Main 当前 generation 已注册。未知方法可以注册以便未来 Native 版本使用，但当前
版本不会调用。

v1 约定方法：

| 方法 | 用途 |
| --- | --- |
| `configuration.status` | 判断是否需要设置页 |
| `stream.publishInfo` | 预留获取推流地址/stream key |
| `user.profile` | 预留获取有限用户信息 |

Runtime handler 必须只返回 JSON 值；单次 Runtime 调用固定超时：
`configuration.status` 为 3 秒，其他 Runtime 为 10 秒。不要返回 Cookie、密码、
access token、refresh token 或完整 RTMP 密钥；`streamKey` 只在用户主动触发能力时
短暂返回，Native 不写日志、不传给 Config。

### Event

```js
var off = YYCamWidget.events.on("visibilityChanged", function (payload) {
  console.log(payload.visible);
});
```

v1 Event 名称包括 `nativeReady`、`visibilityChanged`、`lifecycleChanged`、
`captureModeChanged`、`configurationChanged` 和
`configurationPresentationChanged`。Event 是当前页面 generation 的瞬时通知，
不跨导航重放；晚注册代码只能依赖 `ready` Promise，不能等待重放
`nativeReady`。未知 Event 会被 SDK 忽略，单个监听器抛错不影响其他监听器。

### Context

```js
YYCamWidget.ready.then(function (context) {
  // context.widget.id / revision / subscriptionId
  // context.page.url / origin / configKey
  // context.capabilities.host / runtime
});
```

Context 不包含 Cookie、token、密码、RTMP 密钥或完整用户资料。Config Context 的
`configKey` 是 Native 当前 Session 绑定的 key，页面不能自行修改。

## 5. 错误和取消

业务分支只能判断 `error.code`，不要匹配 `message`。标准错误码包括：

`UNSUPPORTED_API_VERSION`、`METHOD_NOT_ALLOWED`、`INVALID_ARGUMENT`、`ORIGIN_NOT_ALLOWED`、
`CONFIG_PAGE_UNAVAILABLE`、`ALREADY_IN_PROGRESS`、`NAVIGATION_FAILED`、
`RUNTIME_METHOD_UNAVAILABLE`、`RUNTIME_INVALID_RESULT`、`TIMEOUT`、
`DUPLICATE_RUNTIME_HANDLER`、`CANCELLED` 和 `INTERNAL_ERROR`。

页面关闭、Widget 删除、Main Frame 离开授权 Origin 或 generation 被替换时，未完成
的 Host/Runtime Promise 以 `CANCELLED` 结束。单个 Host/Runtime/Event JSON envelope
最大 64 KiB；`reason` 最长 128 字符，`message` 最长 500 字符。

## 6. 安全边界

- 默认只授权 Manifest 页面 URL 的精确 Origin。Main 和每个 Config 可独立声明
  `allowedOrigins`，Native 验证后才允许对应页面注入 JS/CSS、安装 SDK、调用 Bridge
  或接收 Native 回调。iframe 和未授权 Origin 没有这些权限。
- Manifest 的 integrity 只证明资源匹配当前 Manifest，不能防止 Manifest 源站本身
  被攻破。v1 信任根是用户确认的 HTTPS Manifest URL。
- Main 和 Config 共享持久化站点数据以复用登录 Cookie，但每个页面使用独立的
  `WKUserContentController`、User-Agent、Origin 绑定和权限角色。
- `YYCamWidget.__native`、`__YYCamWidgetBootstrap`、
  `__YYCamWidgetReceiveResponse` 等是 Native/SDK 私有实现，Web 业务代码不得依赖。
- 资源、日志和 Context 中不得携带密码、Cookie、token 或完整用户隐私。

### 显式来源白名单

```json
{
  "url": "https://www.pandalive.co.kr/",
  "allowedOrigins": ["https://pandalive.co.kr", "https://*.pandalive.co.kr"]
}
```

`allowedOrigins` 是页面级可选字段，最多 16 项；省略时保留精确匹配。
页面自身 Origin 始终授权，附加条目只能是同一可注册域名、同协议和端口的
HTTPS Origin，不能包含路径、查询、fragment、账号密码或任意位置通配。
`https://*.pandalive.co.kr` 允许所有层级的子域，但不包括根域；需要根域时单独声明。
此授权意味着所有被匹配的子域都可以调用当前页面角色的 Native Bridge，发布者必须
保证它们可控；只需要一个登录子域时，优先声明精确 Origin。

Native 使用随代码固定的 Public Suffix List（包含 PRIVATE 部分）校验可注册域名，
拒绝 `*.co.kr`、`*.github.io` 和不同租户/站点之间的授权；不运行时下载 PSL。
规则格式错误、null、空列表、重复规则（大小写与默认端口归一化后）都会拒绝整个
Manifest，刷新失败沿用最近有效 Snapshot，不能忽略非法字段后扩大权限。

Native 来源授权、SDK 安装、Manifest JS/CSS 注入和 JS 内部检查共享 Native 编译后的
规则。每次导航依然推进 generation，Main/Config 权限互不继承；Bridge 还校验
调用 frame 的实际 securityOrigin 与当前主页面一致。`context.page.origin` 表示当前
页面实际 Origin。白名单不会改变 WebKit 的 Cookie/localStorage 隔离规则，也不复制登录数据。
第三方 OAuth/SSO 页面可继续导航，但在白名单之外时不开放 Widget 能力。

维护数据位于 `security/public-suffix-rules.json`，来源为官方 PSL，版本与原始数据
SHA-256 记录在文件中；域名规则数据依照 MPL-2.0 使用。更新时保留 ICANN、PRIVATE、
wildcard 和 exception 规则，并用 IDNA ASCII 域名生成数据，不能只截取域名最后两段。
修改 SDK 或 PSL 数据后运行 `python3 scripts/sync_native_security.py --native-root <iOS仓库>`，
再执行 `sh tests/run_native_origin_policy_test.sh <iOS仓库>` 校验 Native 与 JS 一致性。

### Native-only transport contract

Web 作者不应直接调用以下名称；它们只是 SDK 与 Native Router 的私有互操作协议。
当前 canonical transport handler 只有一个：`yyCamWidget`。三类 JS→Native
消息统一通过它发送：

```json
{
  "type": "yycamwidget.host.request",
  "request": {
    "apiVersion": 1,
    "requestId": "UUID",
    "action": "context.get",
    "params": {}
  }
}
```

Runtime registry 和 Runtime response 分别使用同一 handler 的
`yycamwidget.runtime.registry.changed`、`yycamwidget.runtime.response` wrapper。
Native→JS 使用 `YYCamWidget.__native.__deliver()`、
`__deliverEvent()`、`__receiveRuntimeRequest()` 和 `__cancel()`；这些入口不构成
Web 作者 API。不要再新增同义 handler 或拆分 transport。

## 7. 本地验证和发布

将 Manifest 放在可访问的 HTTPS 地址，或者在 Debug 白名单下使用 localhost。资源
修改后先更新摘要：

```sh
pandalive/update_sha256.sh
```

提交前安装 Hook：

```sh
scripts/install_precommit.sh
```

Hook 会按暂存区实际内容生成 `integrity`，只修改并暂存 Manifest，不把工作区中
未暂存的脚本修改混进当前提交。发布前执行仓库测试：

```sh
node tests/web_widget_test.js
python3 tests/manifest_test.py
```

PandaLive 的 Main 使用 `configuration.status`，`configs.default` 使用
`completeConfig()`/`closeConfig()`；`pandalive_check.js` 仅作为迁移对照保留，不能
在 v1 Manifest 中出现或由 Native 执行。
