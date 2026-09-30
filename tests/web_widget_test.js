#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const rootDir = path.resolve(__dirname, "..");
const sdkSource = fs.readFileSync(path.join(rootDir, "sdk/yycamwidget.js"), "utf8");

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createContextPayload(role) {
  return {
    apiVersion: 1,
    role,
    widget: {
      id: "com.example.widget",
      revision: "test-1",
      subscriptionId: "subscription-test"
    },
    page: {
      url: "https://widget.example/live",
      origin: "https://widget.example",
      ...(role === "config" ? { configKey: "default" } : {})
    },
    environment: {
      locale: "en-US",
      colorScheme: "light"
    },
    capabilities: {
      host: ["context.get"],
      runtime: []
    }
  };
}

function loadSDK(role, transport, webkit, overrides = {}) {
  const sandbox = {
    console,
    Promise,
    Map,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    Date,
    Math,
    JSON,
    isFinite,
    unescape,
    encodeURIComponent,
    TextEncoder,
    URL,
    setTimeout,
    clearTimeout,
    location: { origin: "https://widget.example" },
    __YYCamWidgetBootstrap: {
      role,
      origin: "https://widget.example"
    },
    __YYCamWidgetTransport: transport
  };
  if (webkit) {
    sandbox.webkit = webkit;
  }
  Object.assign(sandbox, overrides);
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(sdkSource, sandbox, { filename: "yycamwidget.js" });
  return sandbox;
}

function createTransport(role, options = {}) {
  const requests = [];
  const notifications = [];
  const context = createContextPayload(role);
  const transport = {
    requests,
    notifications,
    request(request) {
      requests.push(request);
      if (request.action === "context.get") {
        return Promise.resolve({
          requestId: request.requestId,
          ok: true,
          data: context
        });
      }
      if (options.pendingAction === request.action) {
        return undefined;
      }
      if (options.errorAction === request.action) {
        return Promise.resolve({
          requestId: request.requestId,
          ok: false,
          error: {
            code: "CONFIG_PAGE_UNAVAILABLE",
            message: "not available",
            retryable: false
          }
        });
      }
      return Promise.resolve({
        requestId: request.requestId,
        ok: true,
        data: options.responseFor
          ? options.responseFor(request)
          : null
      });
    },
    notify(message) {
      notifications.push(message);
    }
  };
  return transport;
}

async function testMainSDK() {
  const transport = createTransport("main", {
    responseFor(request) {
      if (request.action === "configuration.open") {
        return { configKey: request.params.configKey, status: "presented" };
      }
      return null;
    }
  });
  const sandbox = loadSDK("main", transport);
  const api = sandbox.YYCamWidget;
  const context = await api.ready;
  assert.strictEqual(context.role, "main");
  assert.deepStrictEqual(await api.host.getContext(), context);

  const openResult = await api.host.openConfig({
    configKey: "default",
    reason: "test"
  });
  assert.deepStrictEqual(plain(openResult), {
    configKey: "default",
    status: "presented"
  });
  assert.strictEqual(transport.requests.at(-1).action, "configuration.open");

  await api.host.setCaptureMode({ mode: "automatic" });
  assert.strictEqual(transport.requests.at(-1).action, "capture.setMode");
  await assert.rejects(
    api.host.openConfig({ configKey: "BadKey" }),
    (error) => error.code === "INVALID_ARGUMENT"
  );

  const unregister = api.runtime.register(
    "configuration.status",
    (params) => ({ state: "ready", trigger: params.trigger })
  );
  assert.strictEqual(api.runtime.has("configuration.status"), true);
  assert.deepStrictEqual(api.__native.listMethods(), ["configuration.status"]);
  const runtimeResult = await api.__native.invoke({
    apiVersion: 1,
    requestId: "runtime-1",
    method: "configuration.status",
    params: { trigger: "initialLoad" }
  });
  assert.deepStrictEqual(plain(runtimeResult), {
    requestId: "runtime-1",
    ok: true,
    data: { state: "ready", trigger: "initialLoad" }
  });
  const unregisterFailedProfile = api.runtime.register("user.profile", () => {
    throw new Error("profile unavailable");
  });
  const failedRuntime = await api.__native.invoke({
    apiVersion: 1,
    requestId: "runtime-failed",
    method: "user.profile",
    params: {}
  });
  assert.strictEqual(failedRuntime.ok, false);
  assert.strictEqual(failedRuntime.error.code, "RUNTIME_INVALID_RESULT");
  unregisterFailedProfile();

  const runtimeMessages = [];
  sandbox.webkit = {
    messageHandlers: {
      yyCamWidget: {
        postMessage: (message) => runtimeMessages.push(message)
      }
    }
  };
  const unregisterProfile = api.runtime.register("user.profile", () => ({ id: "user-1" }));
  const deliveredRuntime = await api.__native.__receiveRuntimeRequest({
    apiVersion: 1,
    requestId: "runtime-transport-1",
    method: "user.profile",
    params: {}
  });
  assert.strictEqual(runtimeMessages[0].type, "yycamwidget.runtime.response");
  assert.deepStrictEqual(plain(deliveredRuntime), plain(runtimeMessages[0].response));
  assert.strictEqual(runtimeMessages[0].response.requestId, "runtime-transport-1");
  unregister();
  assert.strictEqual(api.runtime.has("configuration.status"), false);
  assert.ok(transport.notifications.some((message) =>
    message.action === "runtime.registry.changed" &&
    message.methods.length === 1
  ));

  let eventPayload;
  api.events.on("visibilityChanged", (payload) => {
    eventPayload = payload;
  });
  sandbox.__YYCamWidgetReceiveEvent({
    apiVersion: 1,
    sequence: 20,
    name: "visibilityChanged",
    timestamp: new Date().toISOString(),
    payload: { visible: true }
  });
  sandbox.__YYCamWidgetReceiveEvent({
    apiVersion: 1,
    sequence: 21,
    name: "unknown.future.event",
    timestamp: new Date().toISOString(),
    payload: { ignored: true }
  });
  await tick();
  assert.deepStrictEqual(plain(eventPayload), { visible: true });

  const pendingSandbox = loadSDK("main", createTransport("main", {
    pendingAction: "capture.setMode"
  }));
  await pendingSandbox.YYCamWidget.ready;
  const pending = pendingSandbox.YYCamWidget.host.setCaptureMode({
    mode: "alwaysCapture"
  });
  await tick();
  pendingSandbox.__YYCamWidgetCancel();
  await assert.rejects(pending, (error) => error.code === "CANCELLED");
}

async function testNativeHandlerContract() {
  const hostMessages = [];
  const handlers = {
    messageHandlers: {
      yyCamWidget: {
        postMessage: (message) => hostMessages.push(message)
      }
    }
  };
  const sandbox = loadSDK("main", undefined, handlers);
  assert.strictEqual(hostMessages.length, 1);
  assert.strictEqual(hostMessages[0].type, "yycamwidget.host.request");
  assert.strictEqual(hostMessages[0].request.action, "context.get");
  sandbox.YYCamWidget.__native.__deliver({
    requestId: hostMessages[0].request.requestId,
    ok: true,
    data: createContextPayload("main")
  });
  await sandbox.YYCamWidget.ready;
  sandbox.YYCamWidget.runtime.register("configuration.status", () => ({ state: "ready" }));
  assert.strictEqual(hostMessages.length, 2);
  assert.strictEqual(hostMessages[1].type, "yycamwidget.runtime.registry.changed");
  assert.strictEqual(hostMessages[1].message.action, "runtime.registry.changed");
}

async function testConfigSDK() {
  const transport = createTransport("config", {
    responseFor(request) {
      if (request.action === "configuration.complete") {
        return {
          state: "ready",
          currentConfigKey: "default",
          verification: "passed",
          subscriptionRefresh: "notModified"
        };
      }
      return null;
    }
  });
  const sandbox = loadSDK("config", transport);
  const api = sandbox.YYCamWidget;
  await api.ready;
  assert.throws(
    () => api.runtime.register("configuration.status", () => ({ state: "ready" })),
    (error) => error.code === "METHOD_NOT_ALLOWED"
  );
  await api.host.completeConfig({ reason: "saved" });
  assert.strictEqual(transport.requests.at(-1).action, "configuration.complete");
  await api.host.closeConfig();
  assert.strictEqual(transport.requests.at(-1).action, "configuration.close");
  await assert.rejects(
    api.host.openConfig(),
    (error) => error.code === "METHOD_NOT_ALLOWED"
  );
  const runtimeResult = await api.__native.invoke({
    apiVersion: 1,
    requestId: "runtime-config",
    method: "configuration.status",
    params: {}
  });
  assert.strictEqual(runtimeResult.error.code, "METHOD_NOT_ALLOWED");
}

function testPandaLiveConfigHelper() {
  const calls = [];
  const sandbox = {
    console,
    Promise,
    window: {
      YYCamWidget: {
        host: {
          getContext: () => (calls.push("getContext"), "context"),
          completeConfig: (options) => (calls.push(["completeConfig", options]), "complete"),
          closeConfig: (options) => (calls.push(["closeConfig", options]), "close")
        },
        events: {
          on: (name) => (calls.push(["on", name]), "off")
        }
      }
    },
    document: {
      querySelector: () => null
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    fs.readFileSync(path.join(rootDir, "pandalive/pandalive_broadcast.js"), "utf8"),
    sandbox,
    { filename: "pandalive_broadcast.js" }
  );
  const helper = sandbox.window.PandaLiveConfig;
  assert.strictEqual(helper.getContext(), "context");
  assert.strictEqual(helper.completeConfig({ reason: "saved" }), "complete");
  assert.strictEqual(helper.closeConfig({ reason: "cancelled" }), "close");
  assert.strictEqual(helper.on("nativeReady", () => {}), "off");
  assert.deepStrictEqual(calls, [
    "getContext",
    ["completeConfig", { reason: "saved" }],
    ["closeConfig", { reason: "cancelled" }],
    ["on", "nativeReady"]
  ]);
}

function testPandaLiveMainRuntime() {
  let handler;
  const localStorage = {
    value: JSON.stringify({ ui: "0" }),
    getItem() {
      return this.value;
    }
  };
  const sandbox = {
    console,
    localStorage,
    window: null,
    document: {
      readyState: "loading",
      addEventListener() {},
      getElementById() { return null; },
      body: {}
    },
    MutationObserver: function () {},
    setTimeout,
    clearTimeout
  };
  sandbox.window = sandbox;
  sandbox.YYCamWidget = {
    runtime: {
      register(name, callback) {
        assert.strictEqual(name, "configuration.status");
        handler = callback;
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    fs.readFileSync(path.join(rootDir, "pandalive/pandalive.js"), "utf8"),
    sandbox,
    { filename: "pandalive.js" }
  );
  assert.deepStrictEqual(plain(handler({ trigger: "initialLoad" })), {
    state: "needsConfiguration",
    configKey: "default",
    reason: "loginRequired",
    message: "PandaLive login is required"
  });
  localStorage.value = JSON.stringify({ ui: "123" });
  assert.deepStrictEqual(plain(handler({ trigger: "manualRefresh" })), {
    state: "ready",
    reason: "authenticated"
  });
}

(async () => {
  await testMainSDK();
  await testNativeHandlerContract();
  await testConfigSDK();
  testPandaLiveConfigHelper();
  testPandaLiveMainRuntime();
  const missingOrigin = loadSDK("main", createTransport("main"), null, {__YYCamWidgetBootstrap: {role: "main"}});
  await assert.rejects(missingOrigin.YYCamWidget.ready, error => error.code === "ORIGIN_NOT_ALLOWED");
  const invalidRules = loadSDK("main", createTransport("main"), null, {__YYCamWidgetBootstrap: {role: "main", origin: "https://widget.example", originRules: []}});
  await assert.rejects(invalidRules.YYCamWidget.ready, error => error.code === "ORIGIN_NOT_ALLOWED");
  console.log("web_widget_test: ok");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
