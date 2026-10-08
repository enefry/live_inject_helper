#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const rootDir = path.resolve(__dirname, "..");
const sdkSource = fs.readFileSync(path.join(rootDir, "sdk/yycamwidget.js"), "utf8");
const invalidPandaLiveDeviceInfo = [
  null, "invalid-json", "null", "{}", "[]", '"guest"', "false",
  ...[null, "", " ", 0, "0", " 0 ", false, true, {}, []].map(ui => JSON.stringify({ ui }))
];

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

async function testPandaLiveConfigHelper() {
  const source = fs.readFileSync(path.join(rootDir, "pandalive/pandalive_broadcast.js"), "utf8");
  function createPage(storageValue, responses = [{ state: "ready" }]) {
    const calls = [];
    const errors = [];
    const warnings = [];
    const intervals = new Map();
    let now = 0;
    let responseIndex = 0;
    let authTab = null;
    let disconnected = false;
    const sandbox = {
      console: { log() {}, error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) },
      Date: class extends Date { static now() { return now; } },
      localStorage: { value: storageValue, getItem() { return this.value; } },
      YYCamWidget: {
        host: {
          completeConfig(options) {
            calls.push(plain(options));
            const response = responses[Math.min(responseIndex++, responses.length - 1)];
            if (response instanceof Error) return Promise.reject(response);
            return typeof response === "function" ? response() : Promise.resolve(response);
          }
        }
      },
      document: { documentElement: {}, querySelector: () => authTab },
      MutationObserver: function () {
        this.observe = () => { disconnected = false; };
        this.disconnect = () => { disconnected = true; };
      },
      setInterval(callback) { intervals.set(1, callback); return 1; },
      clearInterval(timer) { intervals.delete(timer); },
      setTimeout(callback) { callback(); }
    };
    sandbox.window = sandbox;
    const run = () => vm.runInNewContext(source, sandbox, { filename: "pandalive_broadcast.js" });
    run();
    return {
      calls, errors, warnings, intervals, sandbox, run,
      isDisconnected: () => disconnected,
      showLoginTab(visible) { authTab = visible ? { getAttribute: () => "active" } : null; },
      async poll(elapsed = 1000) {
        now += elapsed;
        for (const callback of Array.from(intervals.values())) callback();
        await new Promise(resolve => setImmediate(resolve));
      }
    };
  }

  const needsConfiguration = {
    state: "needsConfiguration",
    currentConfigKey: "default",
    requiredConfig: { configKey: "default", available: true }
  };

  for (const ui of [123, "123", " 123 "]) {
    const loggedIn = createPage(JSON.stringify({ ui }));
    loggedIn.run();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(loggedIn.calls, [{ reason: "authenticated" }]);
    assert.strictEqual(loggedIn.intervals.size, 0);
    assert.deepStrictEqual(loggedIn.errors, []);
  }

  for (const storageValue of invalidPandaLiveDeviceInfo) {
    const page = createPage(storageValue);
    page.run();
    assert.strictEqual(page.calls.length, 0, `must wait for login for xDeviceInfo=${storageValue}`);
    assert.strictEqual(page.intervals.size, 1);
    const poll = page.intervals.get(1);
    poll();
    assert.strictEqual(page.calls.length, 0);
    page.sandbox.localStorage.value = JSON.stringify({ ui: 123 });
    poll();
    poll();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(page.calls, [{ reason: "authenticated" }]);
    assert.strictEqual(page.intervals.size, 0);
    assert.strictEqual(page.isDisconnected(), true);
  }

  // A successful bridge response can still require the same Config. Keep
  // polling and retry verification instead of treating it as completion.
  const delayed = createPage(JSON.stringify({ ui: "123" }), [needsConfiguration, { state: "ready" }]);
  await delayed.poll(0);
  assert.strictEqual(delayed.calls.length, 1);
  assert.strictEqual(delayed.intervals.size, 1);
  assert.strictEqual(delayed.isDisconnected(), false);
  delayed.run();
  await delayed.poll(1000);
  assert.strictEqual(delayed.calls.length, 1);
  await delayed.poll(1000);
  assert.strictEqual(delayed.calls.length, 2);
  assert.strictEqual(delayed.intervals.size, 0);
  assert.strictEqual(delayed.isDisconnected(), true);

  const completionError = Object.assign(new Error("Native completion failed"), { retryable: true });
  const failed = createPage(JSON.stringify({ ui: "123" }), [completionError, { state: "ready" }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(failed.errors.length, 1);
  assert.strictEqual(failed.errors[0][1], completionError);
  assert.strictEqual(failed.sandbox.window.__loginCompletionRequested, false);
  assert.strictEqual(failed.intervals.size, 1);
  await failed.poll(2000);
  assert.strictEqual(failed.calls.length, 2);
  assert.strictEqual(failed.intervals.size, 0);

  const busyAfterTimeout = createPage('{"ui":"123"}', [
    Object.assign(new Error("Native request timed out"), { code: "TIMEOUT", retryable: true }),
    Object.assign(new Error("Configuration is already completing"), { code: "ALREADY_IN_PROGRESS", retryable: false }),
    needsConfiguration,
    { state: "ready" }
  ]);
  await busyAfterTimeout.poll(0);
  await busyAfterTimeout.poll(2000);
  assert.strictEqual(busyAfterTimeout.intervals.size, 1);
  await busyAfterTimeout.poll(4000);
  await busyAfterTimeout.poll(8000);
  assert.strictEqual(busyAfterTimeout.calls.length, 4);
  assert.strictEqual(busyAfterTimeout.intervals.size, 0);

  let resolvePending;
  const pending = createPage(JSON.stringify({ ui: "123" }), [
    () => new Promise(resolve => { resolvePending = resolve; }),
    { state: "ready" }
  ]);
  pending.run();
  await pending.poll(60000);
  await pending.poll(60000);
  assert.strictEqual(pending.calls.length, 1, "only one completion may be in flight");
  resolvePending(needsConfiguration);
  await pending.poll(0);
  await pending.poll(2000);
  assert.strictEqual(pending.calls.length, 2);
  assert.strictEqual(pending.intervals.size, 0);

  // A cached UID must not complete Config while the login dialog is open.
  const cached = createPage('{"ui":"0"}');
  cached.showLoginTab(true);
  cached.sandbox.localStorage.value = '{"ui":"123"}';
  await cached.poll();
  assert.strictEqual(cached.calls.length, 0);
  cached.showLoginTab(false);
  await cached.poll();
  assert.strictEqual(cached.calls.length, 1);
  assert.strictEqual(cached.intervals.size, 0);

  // Bound reloads for one login episode, but keep watching so a later real
  // login (even with the same cached UID) can start a fresh verification.
  const exhausted = createPage('{"ui":"123"}', [
    ...Array(6).fill(needsConfiguration), { state: "ready" }
  ]);
  for (let attempt = 0; attempt < 8; attempt++) await exhausted.poll(60000);
  assert.strictEqual(exhausted.calls.length, 6);
  assert.strictEqual(exhausted.warnings.length, 1);
  exhausted.showLoginTab(true);
  await exhausted.poll();
  exhausted.showLoginTab(false);
  await exhausted.poll();
  assert.strictEqual(exhausted.calls.length, 7);
  assert.strictEqual(exhausted.intervals.size, 0);

  const changedUser = createPage('{"ui":"123"}', [
    ...Array(6).fill(needsConfiguration), { state: "ready" }
  ]);
  for (let attempt = 0; attempt < 8; attempt++) await changedUser.poll(60000);
  changedUser.sandbox.localStorage.value = '{"ui":"456"}';
  await changedUser.poll();
  assert.strictEqual(changedUser.calls.length, 7);
  assert.strictEqual(changedUser.intervals.size, 0);

  const cancelled = createPage('{"ui":"123"}', [
    Object.assign(new Error("Config was closed"), { code: "CANCELLED", retryable: false })
  ]);
  await cancelled.poll();
  assert.strictEqual(cancelled.calls.length, 1);
  assert.strictEqual(cancelled.intervals.size, 0);

  const switched = createPage('{"ui":"123"}', [{
    ...needsConfiguration, requiredConfig: { configKey: "profile", available: true }
  }]);
  await switched.poll();
  assert.strictEqual(switched.calls.length, 1);
  assert.strictEqual(switched.intervals.size, 0);

  const unavailable = createPage('{"ui":"123"}', [{
    ...needsConfiguration, requiredConfig: { configKey: "default", available: false }
  }]);
  await unavailable.poll();
  assert.strictEqual(unavailable.calls.length, 1);
  assert.strictEqual(unavailable.intervals.size, 0);
}

function testPandaLiveMainRuntime() {
  let handler;
  let authTab = null;
  const localStorage = {
    value: JSON.stringify({ ui: "0" }),
    getItem() {
      if (this.unavailable) throw new Error("Storage unavailable");
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
      querySelector(selector) {
        assert.strictEqual(selector, '[data-testid="auth-tab-login"]');
        return authTab;
      },
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
  const needsConfiguration = {
    state: "needsConfiguration",
    configKey: "default",
    reason: "loginRequired",
    message: "PandaLive login is required"
  };
  const ready = {
    state: "ready",
    reason: "authenticated"
  };
  for (const storageValue of invalidPandaLiveDeviceInfo) {
    localStorage.value = storageValue;
    for (const trigger of ["initialLoad", "configCompleted"]) {
      assert.deepStrictEqual(plain(handler({ trigger })), needsConfiguration,
        `must require login for xDeviceInfo=${storageValue}, trigger=${trigger}`);
    }
  }
  for (const ui of [123, "123", " 123 "]) {
    localStorage.value = JSON.stringify({ ui });
    assert.deepStrictEqual(plain(handler({ trigger: "configCompleted" })), ready);
  }

  // A cached UID must not suppress automatic Config presentation while the
  // site is asking the user to sign in again.
  authTab = {};
  assert.deepStrictEqual(plain(handler({ trigger: "initialLoad" })), needsConfiguration);
  authTab = null;
  assert.deepStrictEqual(plain(handler({ trigger: "manualRefresh" })), ready);
  localStorage.unavailable = true;
  assert.deepStrictEqual(plain(handler({ trigger: "initialLoad" })), needsConfiguration);
  localStorage.unavailable = false;
  localStorage.value = '{"ui":"0"}';
  assert.deepStrictEqual(plain(handler({ trigger: "manualRefresh" })), needsConfiguration);
}

(async () => {
  await testMainSDK();
  await testNativeHandlerContract();
  await testConfigSDK();
  await testPandaLiveConfigHelper();
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
