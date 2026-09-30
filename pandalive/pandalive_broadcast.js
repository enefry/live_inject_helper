(function () {
  // 完整模拟点击（Radix 监听 mousedown，不是 click）
  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window, button: 0, ctrlKey: false };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  function isLoggedIn() {
    try {
      const uid = (JSON.parse(localStorage.getItem("xDeviceInfo")) || {}).ui;
      return uid != null && String(uid) !== "" && String(uid) !== "0";
    } catch (e) {
      return false;
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
    };
    tabObserver = new MutationObserver(check);
    tabObserver.observe(document.documentElement, { childList: true, subtree: true });
    check();
  }

  // ---- 登录状态轮询 ----
  async function onLoggedIn() {
    if (window.__loginCompletionRequested) return;
    window.__loginCompletionRequested = true;
    console.log("[login-watcher] 登录成功");
    if (tabObserver) tabObserver.disconnect();
    try {
      await window.YYCamWidget.host.completeConfig({ reason: "authenticated" });
    } catch (error) {
      window.__loginCompletionRequested = false;
      console.error("[login-watcher] 通知设置完成失败", error);
    }
  }

  if (isLoggedIn()) {
    onLoggedIn();
  } else if (!window.__loginWatcherInstalled) {
    window.__loginWatcherInstalled = true;
    startTabWatcher();
    window.__loginWatcherTimer = setInterval(() => {
      if (isLoggedIn()) {
        clearInterval(window.__loginWatcherTimer);
        onLoggedIn();
      }
    }, 1000);
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
