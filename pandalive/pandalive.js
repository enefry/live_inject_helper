(function () {
    console.log(`version:20260430-20:56`)
    // 监听 DOM 变化，检测 #portal 弹出并查找关闭按钮
    const CLOSE_BTN_SELECTOR = 'button[type="button"]';
    const BASE_BG_STYLE_ID = 'live-inject-helper-base-bg';

    function forceTransparentBaseBg() {
        document.documentElement?.style.setProperty('--baseBg', 'transparent', 'important');
        document.body?.style.setProperty('--baseBg', 'transparent', 'important');
        document.getElementById('content-area')?.style.setProperty('background-color', 'transparent', 'important');

        if (!document.getElementById(BASE_BG_STYLE_ID)) {
            const styleContainer = document.head || document.body || document.documentElement;
            if (!styleContainer) {
                return;
            }

            const style = document.createElement('style');
            style.id = BASE_BG_STYLE_ID;
            style.textContent = ':root, html, body { --baseBg: transparent !important; } #content-area { background-color: transparent !important; }';
            styleContainer.appendChild(style);
        }
    }

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
        forceTransparentBaseBg();
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
        forceTransparentBaseBg();
        observer.observe(document.body, { childList: true, subtree: true });
        fullCheck();
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        startObserver();
    } else {
        document.addEventListener('DOMContentLoaded', startObserver, { once: true });
    }

})()
