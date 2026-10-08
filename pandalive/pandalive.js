(function () {
    console.log('version:2026.10.08.3');

    function loggedInUserID() {
        try {
            const uid = (JSON.parse(window.localStorage.getItem('xDeviceInfo')) || {}).ui;
            if (typeof uid !== 'string' && typeof uid !== 'number') return null;
            const value = String(uid).trim();
            return value !== '' && value !== '0' ? value : null;
        } catch (error) {
            return null;
        }
    }

    // Main Runtime replacement for the old checkJS resource. Native invokes
    // this handler after Main navigation and uses the returned state to
    // decide whether configs.default should be presented.
    function configurationStatus() {
        // Guest device info can exist without a UID. A cached UID can also
        // remain while the site is asking the user to sign in again.
        if (loggedInUserID() !== null && !document.querySelector('[data-testid="auth-tab-login"]')) {
            return {
                state: 'ready',
                reason: 'authenticated'
            };
        }

        return {
            state: 'needsConfiguration',
            configKey: 'default',
            reason: 'loginRequired',
            message: 'PandaLive login is required'
        };
    }

    if (window.YYCamWidget && window.YYCamWidget.runtime) {
        window.YYCamWidget.runtime.register('configuration.status', configurationStatus);
    }

    // 监听 DOM 变化，检测 #portal 弹出并查找关闭按钮
    const CLOSE_BTN_SELECTOR = 'button';
    function findCloseButton(portal) {
        const btn = portal.querySelector(CLOSE_BTN_SELECTOR);
        if (btn && btn.textContent.trim() === '닫기') {
            return btn;
        }
        return null;
    }

    function handlePortal(portal) {
        const btn = findCloseButton(portal);
        if (btn) {
            console.log('[live_inject_helper] 找到关闭按钮:', btn);
            btn.click();
        }
    }

    // 移除视频布局
    function removeVideoLayout(el) {
        console.log('[live_inject_helper] 移除视频布局:', el);
        el.remove();
    }

    function checkVideoElement(node) {
        if (node instanceof HTMLElement) {
            console.log(`remove check: ${node.tagName}, id=${node.id}, dataset=${JSON.stringify(node.dataset)},class=${node.className}`);
            if (node.dataset?.testid === 'play-player' || node.id === 'video-section') {
                removeVideoLayout(node);
                return true;
            }
            const player = node.querySelector?.('[data-testid="play-player"]');
            if (player) {
                removeVideoLayout(player);
                return true;
            }
            const videoSection = node.querySelector?.('#video-section');
            if (videoSection) {
                removeVideoLayout(videoSection);
                return true;
            }
        }

        return false;
    }

    function fullCheck() {
        // 页面加载时检查已存在的元素
        const existingPortal = document.getElementById('portal');
        if (existingPortal) {
            handlePortal(existingPortal);
        }
        checkVideoElement(document.body);
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node instanceof HTMLElement) {
                    // 检查视频布局
                    checkVideoElement(node);
                    // 检查 #portal
                    if (node.id === 'portal') {
                        handlePortal(node);
                    } else {
                        const portal = node.querySelector?.('#portal');
                        if (portal) {
                            handlePortal(portal);
                        }
                    }
                }
            }
        }
    });

    function startObserver() {
        observer.observe(document.body, { childList: true, subtree: true });
        fullCheck();
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        startObserver();
    } else {
        document.addEventListener('DOMContentLoaded', startObserver, { once: true });
    }

})()
