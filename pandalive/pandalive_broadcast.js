(function () {
  // 完整模拟点击（Radix 监听 mousedown，不是 click）
  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window, button: 0, ctrlKey: false };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  function loggedInUserID() {
    try {
      const uid = (JSON.parse(localStorage.getItem("xDeviceInfo")) || {}).ui;
      if (typeof uid !== "string" && typeof uid !== "number") return null;
      const value = String(uid).trim();
      return value !== "" && value !== "0" ? value : null;
    } catch (e) {
      return null;
    }
  }

  // ---- 每次弹出都自动切到登录 tab，登录成功后停止 ----
  const SEL = '[data-testid="auth-tab-login"]';
  const handled = new WeakSet();
  let tabObserver = null;

  function ensureLoginTab(tab) {
    let tries = 0;
    (function attempt() {
      // 每次都重新查询，避免拿着被 React 替换掉的旧节点
      const el = document.querySelector(SEL);
      if (!el) return;                                   // 弹窗已关闭
      if (el.getAttribute("data-state") === "active") return;
      realClick(el);
      if (++tries < 10) setTimeout(attempt, 100);
    })();
  }

  function startTabWatcher() {
    if (window.__autoLoginTabInstalled) return;
    window.__autoLoginTabInstalled = true;

    const check = () => {
      const tab = document.querySelector(SEL);
      if (tab && !handled.has(tab)) {
        handled.add(tab);
        setTimeout(() => ensureLoginTab(tab), 0);
      }
      // Login replaces/removes the dialog. Check in this DOM event instead
      // of waiting for the next polling tick.
      checkLogin();
    };
    tabObserver = new MutationObserver(check);
    tabObserver.observe(document.documentElement, { childList: true, subtree: true });
    check();
  }

  // ---- 登录状态轮询；只有 Main 验证 ready 后才结束 ----
  const MAX_COMPLETION_ATTEMPTS = 6;
  let observedUID = null;
  let loginEpoch = 0;
  let completionAttempts = 0;
  let nextAttemptAt = 0;
  let stopped = false;

  function stopWatching() {
    stopped = true;
    clearInterval(window.__loginWatcherTimer);
    window.__loginWatcherTimer = null;
    if (tabObserver) tabObserver.disconnect();
    window.removeEventListener("storage", onStorageChanged);
  }

  async function onLoggedIn() {
    if (stopped || window.__loginCompletionRequested) return;
    window.__loginCompletionRequested = true;
    const requestEpoch = loginEpoch;
    completionAttempts++;
    let retryDelay = Math.min(2000 * Math.pow(2, completionAttempts - 1), 10000);
    console.log("[login-watcher] 检测到登录信息，确认主页面状态");
    try {
      const result = await window.YYCamWidget.host.completeConfig({ reason: "authenticated" });
      if (result && result.state === "ready") {
        console.log("[login-watcher] 设置验证完成");
        stopWatching();
        return;
      }
      if (!result || result.state !== "needsConfiguration") {
        throw new Error("Invalid completeConfig result");
      }
      const required = result.requiredConfig;
      if (!required || !required.available || required.configKey !== result.currentConfigKey) {
        // Native retires this page when the required Config is unavailable or
        // changes. Do not keep sending completion requests from the old page.
        stopWatching();
        return;
      }
      console.log("[login-watcher] 主页面仍需配置，稍后重试验证");
      // Give freshly saved cookies a quick first recheck. Transport errors
      // and later attempts retain the existing bounded backoff.
      if (completionAttempts === 1) retryDelay = 500;
    } catch (error) {
      console.error("[login-watcher] 通知设置完成失败", error);
      // The JS timeout can expire while Native is still verifying the earlier
      // request. ALREADY_IN_PROGRESS means wait, even if marked non-retryable.
      if (error && error.retryable === false && error.code !== "ALREADY_IN_PROGRESS") stopWatching();
    } finally {
      if (!stopped) {
        window.__loginCompletionRequested = false;
        if (requestEpoch === loginEpoch) {
          nextAttemptAt = Date.now() + retryDelay;
          if (completionAttempts >= MAX_COMPLETION_ATTEMPTS) {
            console.warn("[login-watcher] 验证重试已达上限，继续等待新的登录状态");
          }
        }
      }
    }
  }

  function onStorageChanged(event) {
    if (event.key === "xDeviceInfo" || event.key === null) checkLogin();
  }

  function checkLogin() {
    if (stopped) return;
    // xDeviceInfo can contain a cached UID while the login dialog is open.
    const uid = document.querySelector(SEL) ? null : loggedInUserID();
    if (uid !== observedUID) {
      observedUID = uid;
      loginEpoch++;
      completionAttempts = 0;
      nextAttemptAt = 0;
    }
    if (uid !== null && completionAttempts < MAX_COMPLETION_ATTEMPTS && Date.now() >= nextAttemptAt) {
      onLoggedIn();
    }
  }

  if (!window.__loginWatcherInstalled) {
    window.__loginWatcherInstalled = true;
    window.addEventListener("storage", onStorageChanged);
    window.__loginWatcherTimer = setInterval(checkLogin, 250);
    startTabWatcher();
  }

  // 暴露给 PandaLiveConfig 的 click 也换成完整点击
  // api.click = function (target, options) {
  //   const el = resolveElement(target, options && options.root);
  //   if (!el) return false;
  //   realClick(el);
  //   return true;
  // };
  window.__realClick = realClick;
})();
