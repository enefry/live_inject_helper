/*
 * Config-page helper for PandaLive.
 *
 * The manifest injects this file into the Config WebView at documentEnd. It
 * deliberately registers functions only; it does not navigate, fill fields,
 * click buttons, or call complete() automatically. The product flow can add
 * the timing and page-specific selectors later without changing the bridge
 * contract.
 */
(function () {
  const api = window.PandaLiveConfig = window.PandaLiveConfig || {};

  function widget() {
    if (!window.YCPWidget) {
      throw new Error('YCPWidget is unavailable on this page');
    }
    return window.YCPWidget;
  }

  function resolveElement(target, root) {
    if (target && typeof target === 'object' && target.nodeType === 1) {
      return target;
    }
    if (typeof target !== 'string') {
      return null;
    }
    return (root || document).querySelector(target);
  }

  api.version = 1;

  // Native bridge wrappers. These are explicit calls so the caller controls
  // when the Config page is considered complete or should be dismissed.
  api.getContext = function () {
    return widget().getContext();
  };
  api.complete = function (options) {
    return widget().complete(options || {});
  };
  api.close = function () {
    return widget().close();
  };
  api.on = function (name, handler) {
    return widget().on(name, handler);
  };

  // DOM helpers keep page-specific selectors outside the native app. They do
  // not run until called by a future PandaLive-specific flow.
  api.find = function (selector, root) {
    return resolveElement(selector, root);
  };
  api.waitFor = function (selector, options) {
    const settings = options || {};
    const root = settings.root || document;
    const timeout = Number.isFinite(settings.timeout) ? settings.timeout : 10000;
    const existing = resolveElement(selector, root);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise(function (resolve, reject) {
      let settled = false;
      const observer = new MutationObserver(function () {
        const element = resolveElement(selector, root);
        if (!element || settled) {
          return;
        }
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(element);
      });
      const timer = setTimeout(function () {
        if (settled) {
          return;
        }
        settled = true;
        observer.disconnect();
        reject(new Error('Timed out waiting for ' + selector));
      }, timeout);

      observer.observe(root === document ? document.documentElement : root, {
        childList: true,
        subtree: true
      });
    });
  };
  api.setValue = function (target, value, options) {
    const settings = options || {};
    const element = resolveElement(target, settings.root);
    if (!element) {
      return false;
    }

    const prototype = Object.getPrototypeOf(element);
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value == null ? '' : String(value));
    } else {
      element.value = value == null ? '' : String(value);
    }
    if (settings.dispatch !== false) {
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  };
  api.click = function (target, options) {
    const element = resolveElement(target, options && options.root);
    if (!element) {
      return false;
    }
    element.click();
    return true;
  };
}());
