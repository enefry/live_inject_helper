(function () {
    console.log(`version:20260430-21:46`)
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

    function fullCheck() {
        // 页面加载时检查已存在的元素
        const existingPortal = document.getElementById('portal');
        if (existingPortal) {
            handlePortal(existingPortal);
        }
    }

    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node instanceof HTMLElement) {
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
