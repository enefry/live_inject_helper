// 监听 DOM 变化，检测 #portal 弹出并查找关闭按钮
const CLOSE_BTN_SELECTOR = 'button.group.relative.flex.items-center.justify-center.transition-colors.duration-150.focus\\:outline-none.active\\:outline-none.active\\:ring-0.text-baseFg.w-auto.whitespace-nowrap.px-\\[20px\\].rounded-\\[14px\\].h-full.font-medium.text-\\[15px\\][type="button"]';
const BASE_BG_STYLE_ID = 'live-inject-helper-base-bg';

function forceTransparentBaseBg() {
  document.documentElement.style.setProperty('--baseBg', 'transparent', 'important');
  document.body?.style.setProperty('--baseBg', 'transparent', 'important');
  document.getElementById('content-area')?.style.setProperty('background-color', 'transparent', 'important');

  if (!document.getElementById(BASE_BG_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = BASE_BG_STYLE_ID;
    style.textContent = ':root, html, body { --baseBg: transparent !important; } #content-area { background-color: transparent !important; }';
    document.head.appendChild(style);
  }
}

forceTransparentBaseBg();

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

observer.observe(document.body, { childList: true, subtree: true });

// 页面加载时检查已存在的元素
const existingPortal = document.getElementById('portal');
if (existingPortal) {
  handlePortal(existingPortal);
}
checkVideoElement(document.body);
