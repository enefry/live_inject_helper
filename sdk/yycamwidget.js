/*
 * YYCamWidget Web SDK v1.
 *
 * This file is deliberately dependency-free and is intended to be installed
 * by Native at documentStart. The transport and bootstrap objects are private
 * implementation details; Web authors should only use window.YYCamWidget.
 */
(function (root) {
  "use strict";

  if (root.YYCamWidget && root.YYCamWidget.__yycamWidgetSDK) {
    return;
  }

  var API_VERSION = 1;
  var MAX_ENVELOPE_BYTES = 64 * 1024;
  var MAX_JSON_DEPTH = 8;
  var HOST_TIMEOUT_MS = 10000;
  var KNOWN_EVENTS = {
    nativeReady: true,
    visibilityChanged: true,
    lifecycleChanged: true,
    captureModeChanged: true,
    configurationChanged: true,
    configurationPresentationChanged: true
  };
  var VALID_ERROR_CODES = {
    UNSUPPORTED_API_VERSION: true,
    METHOD_NOT_ALLOWED: true,
    INVALID_ARGUMENT: true,
    ORIGIN_NOT_ALLOWED: true,
    CONFIG_PAGE_UNAVAILABLE: true,
    ALREADY_IN_PROGRESS: true,
    NAVIGATION_FAILED: true,
    RUNTIME_METHOD_UNAVAILABLE: true,
    RUNTIME_INVALID_RESULT: true,
    DUPLICATE_RUNTIME_HANDLER: true,
    TIMEOUT: true,
    CANCELLED: true,
    INTERNAL_ERROR: true
  };

  var bootstrap = root.__YYCamWidgetBootstrap || {};
  var role = bootstrap.role === "config" ? "config" : "main";
  var expectedOrigin = typeof bootstrap.origin === "string"
    ? bootstrap.origin
    : (typeof root.__YYCamWidgetTargetOrigin === "string"
      ? root.__YYCamWidgetTargetOrigin
      : currentOrigin());
  var contextValue;
  var readySettled = false;
  var readyResolve;
  var readyReject;
  var pendingRequests = Object.create(null);
  var runtimeHandlers = Object.create(null);
  var eventHandlers = Object.create(null);
  var lastEventSequence = 0;
  var eventQueue = [];
  var eventFlushScheduled = false;
  var nativeReadySent = false;

  function currentOrigin() {
    try {
      return root.location && root.location.origin
        ? String(root.location.origin)
        : "";
    } catch (error) {
      return "";
    }
  }

  function isOriginAllowed() {
    if (!expectedOrigin) {
      return true;
    }
    return currentOrigin() === expectedOrigin;
  }

  function makeError(code, message, retryable, requestId) {
    var error = new Error(message || code);
    error.name = "WidgetAPIError";
    error.code = VALID_ERROR_CODES[code] ? code : "INTERNAL_ERROR";
    error.retryable = Boolean(retryable);
    if (requestId) {
      error.requestId = requestId;
    }
    return error;
  }

  function payloadError(payload, requestId) {
    if (!payload || typeof payload !== "object") {
      return makeError("INTERNAL_ERROR", "Malformed Native error", false, requestId);
    }
    return makeError(
      payload.code,
      typeof payload.message === "string" ? payload.message : payload.code,
      payload.retryable,
      requestId
    );
  }

  function byteLength(value) {
    var text = String(value);
    if (typeof root.TextEncoder === "function") {
      return new root.TextEncoder().encode(text).length;
    }
    try {
      return unescape(encodeURIComponent(text)).length;
    } catch (error) {
      return text.length;
    }
  }

  function jsonDepth(value, depth) {
    if (depth > MAX_JSON_DEPTH) {
      return depth;
    }
    if (!value || typeof value !== "object") {
      return depth;
    }
    var nextDepth = depth + 1;
    var maxDepth = nextDepth;
    var keys;
    try {
      keys = Object.keys(value);
    } catch (error) {
      return MAX_JSON_DEPTH + 1;
    }
    for (var i = 0; i < keys.length; i += 1) {
      maxDepth = Math.max(maxDepth, jsonDepth(value[keys[i]], nextDepth));
    }
    return maxDepth;
  }

  function isJSONValue(value, depth) {
    var level = depth || 0;
    if (level > MAX_JSON_DEPTH) {
      return false;
    }
    if (value === null || typeof value === "string" ||
        typeof value === "boolean" || typeof value === "number") {
      return typeof value !== "number" || isFinite(value);
    }
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i += 1) {
        if (!isJSONValue(value[i], level + 1)) {
          return false;
        }
      }
      return true;
    }
    if (typeof value !== "object") {
      return false;
    }
    var keys = Object.keys(value);
    for (var j = 0; j < keys.length; j += 1) {
      if (byteLength(keys[j]) > 128 ||
          !isJSONValue(value[keys[j]], level + 1)) {
        return false;
      }
    }
    return true;
  }

  function encodeEnvelope(value, errorCode) {
    if (!isJSONValue(value) || jsonDepth(value, 0) > MAX_JSON_DEPTH) {
      throw makeError(errorCode || "INVALID_ARGUMENT", "JSON value is invalid", false);
    }
    var encoded;
    try {
      encoded = JSON.stringify(value);
    } catch (error) {
      throw makeError(errorCode || "INVALID_ARGUMENT", "JSON value is not serializable", false);
    }
    if (byteLength(encoded) > MAX_ENVELOPE_BYTES) {
      throw makeError(errorCode || "INVALID_ARGUMENT", "JSON envelope is too large", false);
    }
    return encoded;
  }

  function requestId() {
    try {
      if (root.crypto && typeof root.crypto.randomUUID === "function") {
        return root.crypto.randomUUID();
      }
    } catch (error) {
      // Fall through to the portable implementation.
    }
    return "yycam-" + Date.now().toString(36) + "-" +
      Math.random().toString(36).slice(2) + "-" +
      Math.random().toString(36).slice(2);
  }

  function normalizeTransport(candidate) {
    if (typeof candidate === "function") {
      return { request: candidate };
    }
    if (candidate && typeof candidate.request === "function") {
      return candidate;
    }
    return createWebKitTransport();
  }

  function createWebKitTransport() {
    function handler() {
      try {
        return root.webkit && root.webkit.messageHandlers &&
          root.webkit.messageHandlers.yyCamWidget;
      } catch (error) {
        return null;
      }
    }
    return {
      request: function (request) {
        var nativeHandler = handler();
        if (!nativeHandler || typeof nativeHandler.postMessage !== "function") {
          throw makeError("INTERNAL_ERROR", "YYCamWidget Native transport is unavailable", true);
        }
        // Native receives every private Widget message on the single
        // yyCamWidget handler. The type/request wrapper is transport-only.
        nativeHandler.postMessage({
          type: "yycamwidget.host.request",
          request: request
        });
        // The response is delivered through __YYCamWidgetReceiveResponse.
        return undefined;
      },
      notify: function (message) {
        var nativeHandler = handler();
        if (!nativeHandler || typeof nativeHandler.postMessage !== "function") {
          return;
        }
        nativeHandler.postMessage({
          type: "yycamwidget.runtime.registry.changed",
          message: message
        });
      }
    };
  }

  var injectedTransport = bootstrap.transport || root.__YYCamWidgetTransport;
  var transport = normalizeTransport(injectedTransport);

  function settleResponse(response) {
    if (!response || typeof response !== "object" ||
        typeof response.requestId !== "string") {
      return;
    }
    var pending = pendingRequests[response.requestId];
    if (!pending) {
      return;
    }
    delete pendingRequests[response.requestId];
    clearTimeout(pending.timer);
    if (response.ok === true) {
      if (!Object.prototype.hasOwnProperty.call(response, "data") ||
          !isJSONValue(response.data) ||
          jsonDepth(response.data, 0) > MAX_JSON_DEPTH ||
          byteLength(JSON.stringify(response.data)) > MAX_ENVELOPE_BYTES) {
        pending.reject(makeError(
          pending.errorCode || "RUNTIME_INVALID_RESULT",
          "Native response data is invalid",
          false,
          response.requestId
        ));
        return;
      }
      pending.resolve(response.data);
      return;
    }
    if (response.ok === false) {
      pending.reject(payloadError(response.error, response.requestId));
      return;
    }
    pending.reject(makeError(
      pending.errorCode || "INTERNAL_ERROR",
      "Malformed Native response",
      false,
      response.requestId
    ));
  }

  function sendRequest(action, params, errorCode) {
    var request = {
      apiVersion: API_VERSION,
      requestId: requestId(),
      action: action,
      params: params || {}
    };
    try {
      encodeEnvelope(request, "INVALID_ARGUMENT");
    } catch (error) {
      return Promise.reject(error);
    }
    if (!isOriginAllowed()) {
      return Promise.reject(makeError(
        "ORIGIN_NOT_ALLOWED",
        "The current page Origin is not authorized",
        false,
        request.requestId
      ));
    }
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (!pendingRequests[request.requestId]) {
          return;
        }
        delete pendingRequests[request.requestId];
        reject(makeError("TIMEOUT", "Native request timed out", true, request.requestId));
      }, HOST_TIMEOUT_MS);
      pendingRequests[request.requestId] = {
        resolve: resolve,
        reject: reject,
        timer: timer,
        errorCode: errorCode
      };
      var result;
      try {
        result = transport.request(request);
      } catch (error) {
        delete pendingRequests[request.requestId];
        clearTimeout(timer);
        reject(error && error.name === "WidgetAPIError"
          ? error
          : makeError("INTERNAL_ERROR", "Native request could not be sent", true,
            request.requestId));
        return;
      }
      if (result !== undefined) {
        Promise.resolve(result).then(function (response) {
          settleResponse(response);
        }, function (error) {
          if (!pendingRequests[request.requestId]) {
            return;
          }
          delete pendingRequests[request.requestId];
          clearTimeout(timer);
          reject(error && error.name === "WidgetAPIError"
            ? error
            : makeError("INTERNAL_ERROR", "Native request failed", true,
              request.requestId));
        });
      }
    });
  }

  function cancelPending() {
    var error = makeError("CANCELLED", "Widget page is no longer active", true);
    var ids = Object.keys(pendingRequests);
    for (var i = 0; i < ids.length; i += 1) {
      var pending = pendingRequests[ids[i]];
      delete pendingRequests[ids[i]];
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  function validateContext(value) {
    if (!value || typeof value !== "object" || value.apiVersion !== API_VERSION ||
        value.role !== role || !value.widget || !value.page ||
        !value.capabilities) {
      throw makeError("INTERNAL_ERROR", "Native context is invalid", false);
    }
    if (!isJSONValue(value) || jsonDepth(value, 0) > MAX_JSON_DEPTH ||
        byteLength(JSON.stringify(value)) > MAX_ENVELOPE_BYTES) {
      throw makeError("INTERNAL_ERROR", "Native context is too large", false);
    }
    return value;
  }

  function dispatchEvent(envelope) {
    if (!KNOWN_EVENTS[envelope.name]) {
      return;
    }
    var listeners = eventHandlers[envelope.name] || [];
    var payload = envelope.payload;
    for (var i = 0; i < listeners.length; i += 1) {
      try {
        listeners[i](payload);
      } catch (error) {
        // A listener is isolated from the other listeners by design.
      }
    }
    try {
      if (typeof root.CustomEvent === "function" &&
          typeof root.dispatchEvent === "function") {
        root.dispatchEvent(new root.CustomEvent("yycamwidget:event", {
          detail: envelope
        }));
      }
    } catch (error) {
      // DOM event support is optional in test and embedded environments.
    }
  }

  function flushEvents() {
    eventFlushScheduled = false;
    eventQueue.sort(function (left, right) {
      return left.sequence - right.sequence;
    });
    while (eventQueue.length) {
      var envelope = eventQueue.shift();
      if (envelope.sequence <= lastEventSequence) {
        continue;
      }
      lastEventSequence = envelope.sequence;
      dispatchEvent(envelope);
    }
  }

  function receiveEvent(envelope) {
    if (!envelope || typeof envelope !== "object" ||
        envelope.apiVersion !== API_VERSION ||
        typeof envelope.sequence !== "number" ||
        typeof envelope.name !== "string" || !KNOWN_EVENTS[envelope.name]) {
      return;
    }
    if (envelope.name === "nativeReady" && !readySettled) {
      // NativeReady is generated after ready resolves. If a transport sends a
      // duplicate early event, ignore it rather than dispatching it twice.
      return;
    }
    eventQueue.push(envelope);
    if (!eventFlushScheduled) {
      eventFlushScheduled = true;
      Promise.resolve().then(flushEvents);
    }
  }

  function emitNativeReady(context) {
    if (nativeReadySent) {
      return;
    }
    nativeReadySent = true;
    receiveEvent({
      apiVersion: API_VERSION,
      sequence: lastEventSequence + 1,
      name: "nativeReady",
      timestamp: new Date().toISOString(),
      payload: context
    });
  }

  function onEvent(name, handler) {
    if (!KNOWN_EVENTS[name] || typeof handler !== "function") {
      return function () {};
    }
    if (!eventHandlers[name]) {
      eventHandlers[name] = [];
    }
    eventHandlers[name].push(handler);
    var active = true;
    return function () {
      if (!active) {
        return;
      }
      active = false;
      var listeners = eventHandlers[name] || [];
      var index = listeners.indexOf(handler);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    };
  }

  function notifyRegistryChanged() {
    var methods = Object.keys(runtimeHandlers).sort();
    var message = {
      apiVersion: API_VERSION,
      action: "runtime.registry.changed",
      methods: methods
    };
    try {
      encodeEnvelope(message, "INVALID_ARGUMENT");
    } catch (error) {
      return;
    }
    if (transport && typeof transport.notify === "function") {
      try {
      transport.notify(message);
      } catch (error) {
        // Registry changes are best effort; Native obtains an authoritative
        // snapshot with __native.listMethods() after didFinish.
      }
    }
  }

  function postRuntimeResponse(response) {
    try {
      var handler = root.webkit && root.webkit.messageHandlers &&
        root.webkit.messageHandlers.yyCamWidget;
      if (handler && typeof handler.postMessage === "function") {
        handler.postMessage({
          type: "yycamwidget.runtime.response",
          response: response
        });
      }
    } catch (error) {
      // Native will time out the Runtime request if the response cannot be sent.
    }
  }

  function receiveRuntimeRequest(request) {
    return invokeRuntime(request).then(function (response) {
      postRuntimeResponse(response);
      return response;
    });
  }

  function registerRuntime(method, handler) {
    if (role !== "main") {
      throw makeError("METHOD_NOT_ALLOWED", "Config pages cannot register Runtime methods", false);
    }
    if (typeof method !== "string" || !method || method.length > 128 ||
        typeof handler !== "function") {
      throw makeError("INVALID_ARGUMENT", "Runtime method and handler are required", false);
    }
    if (Object.prototype.hasOwnProperty.call(runtimeHandlers, method)) {
      throw makeError("DUPLICATE_RUNTIME_HANDLER", "Runtime method is already registered", false);
    }
    runtimeHandlers[method] = handler;
    notifyRegistryChanged();
    var active = true;
    return function () {
      if (!active) {
        return;
      }
      active = false;
      delete runtimeHandlers[method];
      notifyRegistryChanged();
    };
  }

  function runtimeResponse(requestId, response) {
    var result = {
      requestId: requestId,
      ok: response.ok
    };
    if (response.ok) {
      result.data = response.data;
    } else {
      result.error = response.error;
    }
    return result;
  }

  function invokeRuntime(request) {
    var id = request && typeof request.requestId === "string"
      ? request.requestId
      : "";
    if (!request || request.apiVersion !== API_VERSION ||
        typeof request.method !== "string" || !isJSONValue(request.params)) {
      return Promise.resolve(runtimeResponse(id, {
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Runtime request is invalid",
          retryable: false
        }
      }));
    }
    if (role !== "main") {
      return Promise.resolve(runtimeResponse(id, {
        ok: false,
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Config pages cannot receive Runtime calls",
          retryable: false
        }
      }));
    }
    var handler = runtimeHandlers[request.method];
    if (typeof handler !== "function") {
      return Promise.resolve(runtimeResponse(id, {
        ok: false,
        error: {
          code: "RUNTIME_METHOD_UNAVAILABLE",
          message: "Runtime method is not registered",
          retryable: false
        }
      }));
    }
    return Promise.resolve().then(function () {
      return handler(request.params);
    }).then(function (data) {
      if (!isJSONValue(data) || jsonDepth(data, 0) > MAX_JSON_DEPTH) {
        return runtimeResponse(id, {
          ok: false,
          error: {
            code: "RUNTIME_INVALID_RESULT",
            message: "Runtime returned an invalid JSON value",
            retryable: false
          }
        });
      }
      try {
        encodeEnvelope(runtimeResponse(id, { ok: true, data: data }), "RUNTIME_INVALID_RESULT");
      } catch (error) {
        return runtimeResponse(id, {
          ok: false,
          error: {
            code: "RUNTIME_INVALID_RESULT",
            message: "Runtime result is too large",
            retryable: false
          }
        });
      }
      return runtimeResponse(id, { ok: true, data: data });
    }, function () {
      return runtimeResponse(id, {
        ok: false,
        error: {
          code: "RUNTIME_INVALID_RESULT",
          message: "Runtime handler failed",
          retryable: false
        }
      });
    });
  }

  function allowedRole(action) {
    if (action === "context.get") {
      return true;
    }
    if ((action === "configuration.open" || action === "capture.setMode") && role === "main") {
      return true;
    }
    if ((action === "configuration.complete" || action === "configuration.close") && role === "config") {
      return true;
    }
    return false;
  }

  function hostCall(action, params) {
    if (!allowedRole(action)) {
      return Promise.reject(makeError("METHOD_NOT_ALLOWED", "This Host method is unavailable for the current role", false));
    }
    if (!isOriginAllowed()) {
      return Promise.reject(makeError("ORIGIN_NOT_ALLOWED", "The current page Origin is not authorized", false));
    }
    if (action === "context.get") {
      return ready;
    }
    return ready.then(function () {
      return sendRequest(action, params || {}, "INVALID_ARGUMENT");
    });
  }

  function requireOptions(options) {
    if (options === undefined || options === null) {
      return {};
    }
    if (typeof options !== "object" || Array.isArray(options)) {
      throw makeError("INVALID_ARGUMENT", "Options must be an object", false);
    }
    return options;
  }

  function optionalReason(options) {
    if (options.reason === undefined) {
      return undefined;
    }
    if (typeof options.reason !== "string" || options.reason.length > 128) {
      throw makeError("INVALID_ARGUMENT", "reason must be at most 128 characters", false);
    }
    return options.reason;
  }

  function initialReady() {
    sendRequest("context.get", {}, "INTERNAL_ERROR").then(function (value) {
      try {
        contextValue = validateContext(value);
        readySettled = true;
        readyResolve(contextValue);
        emitNativeReady(contextValue);
        if (eventQueue.length && !eventFlushScheduled) {
          eventFlushScheduled = true;
          Promise.resolve().then(flushEvents);
        }
      } catch (error) {
        readySettled = true;
        readyReject(error);
      }
    }, function (error) {
      readySettled = true;
      readyReject(error);
    });
  }

  var ready = new Promise(function (resolve, reject) {
    readyResolve = resolve;
    readyReject = reject;
  });

  var host = {
    getContext: function () {
      return hostCall("context.get", {});
    },
    openConfig: function (options) {
      try {
        var settings = requireOptions(options);
        var key = settings.configKey;
        if (key !== undefined && (typeof key !== "string" ||
            !/^(?:default|[a-z][a-z0-9._-]{0,63})$/.test(key))) {
          throw makeError("INVALID_ARGUMENT", "configKey is invalid", false);
        }
        var reason = optionalReason(settings);
        var params = {
          configKey: key === undefined ? "default" : key
        };
        if (reason !== undefined) {
          params.reason = reason;
        }
        return hostCall("configuration.open", params);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    setCaptureMode: function (options) {
      try {
        var settings = requireOptions(options);
        if (["automatic", "captureAnimation", "alwaysCapture"].indexOf(settings.mode) < 0) {
          throw makeError("INVALID_ARGUMENT", "mode is invalid", false);
        }
        return hostCall("capture.setMode", { mode: settings.mode });
      } catch (error) {
        return Promise.reject(error);
      }
    },
    completeConfig: function (options) {
      try {
        var settings = requireOptions(options);
        var reason = optionalReason(settings);
        return hostCall("configuration.complete", reason === undefined ? {} : { reason: reason });
      } catch (error) {
        return Promise.reject(error);
      }
    },
    closeConfig: function (options) {
      try {
        var settings = requireOptions(options);
        var reason = optionalReason(settings);
        return hostCall("configuration.close", reason === undefined ? {} : { reason: reason });
      } catch (error) {
        return Promise.reject(error);
      }
    }
  };

  var runtime = {
    register: registerRuntime,
    has: function (method) {
      return typeof method === "string" &&
        Object.prototype.hasOwnProperty.call(runtimeHandlers, method);
    }
  };

  var events = {
    on: onEvent
  };

  var nativeAPI = {
    invoke: invokeRuntime,
    listMethods: function () {
      return Object.keys(runtimeHandlers).sort();
    },
    // The following names are private Native-to-JS transport entry points.
    // They are invoked by WidgetWebBridgeRouter through the single private
    // transport and are not part of the Web author API.
    __deliver: settleResponse,
    __deliverEvent: receiveEvent,
    __receiveRuntimeRequest: receiveRuntimeRequest,
    __cancel: cancelPending
  };

  var api = {
    apiVersion: API_VERSION,
    role: role,
    ready: ready,
    host: host,
    runtime: runtime,
    events: events,
    __native: nativeAPI,
    __yycamWidgetSDK: true
  };

  root.YYCamWidget = api;
  root.__YYCamWidgetReceiveResponse = settleResponse;
  root.__YYCamWidgetReceiveEvent = receiveEvent;
  root.__YYCamWidgetCancel = cancelPending;

  if (root.addEventListener) {
    root.addEventListener("pagehide", cancelPending);
    root.addEventListener("popstate", function () {
      if (!isOriginAllowed()) {
        cancelPending();
      }
    });
  }

  initialReady();
}(typeof window !== "undefined" ? window : globalThis));
