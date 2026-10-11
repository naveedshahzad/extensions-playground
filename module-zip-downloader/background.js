// background.js

let loopState = null;

function notifyPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getFrames(tabId) {
  return new Promise(resolve => {
    chrome.webNavigation.getAllFrames({ tabId }, f => resolve(f || []));
  });
}

async function execInFrame(tabId, frameId, func, args = []) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func, args,
    });
    return r?.[0]?.result ?? null;
  } catch (_) { return null; }
}

async function findSmartCurriculumFrame(tabId) {
  const frames = await getFrames(tabId);
  for (const frame of frames) {
    if (frame.url && frame.url.includes('smart-curriculum')) return frame.frameId;
  }
  return null;
}

async function waitForSmartCurriculumFrame(tabId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frameId = await findSmartCurriculumFrame(tabId);
    if (frameId !== null) return frameId;
    await sleep(500);
  }
  return null;
}

async function waitForDownloadButton(tabId, frameId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await execInFrame(tabId, frameId, () => {
      const host = document.querySelector('d2l-button-icon.download-content-button');
      return !!(host && host.shadowRoot?.querySelector('button'));
    });
    if (found) return true;
    await sleep(600);
  }
  return false;
}

function watchForZip(timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const listener = (delta) => {
      if (delta.state?.current !== 'complete') return;
      chrome.downloads.search({ id: delta.id }, (results) => {
        const item = results?.[0];
        if (!item?.filename?.toLowerCase().endsWith('.zip')) return;
        chrome.downloads.onChanged.removeListener(listener);
        resolve(item.filename);
      });
    };
    chrome.downloads.onChanged.addListener(listener);
    setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      reject(new Error('ZIP timed out'));
    }, timeoutMs);
  });
}

async function runDownloadLoop(tabId, modules) {
  loopState = { running: true, tabId, modules, index: 0 };

  notifyPopup({ action: 'log', msg: 'Finding smart-curriculum iframe...', type: 'info' });
  const frameId = await waitForSmartCurriculumFrame(tabId, 15000);
  if (frameId === null) {
    notifyPopup({ action: 'log', msg: 'Could not find smart-curriculum iframe.', type: 'err' });
    loopState = null;
    notifyPopup({ action: 'done', total: 0 });
    return;
  }
  notifyPopup({ action: 'log', msg: `Found iframe (frameId: ${frameId})`, type: 'ok' });

  // d2l-list-item-nav elements are inside d2l-lessons-toc shadow root
  // Each has key=moduleId, label=title, action-href=/d2l/le/lessons/{courseId}/units/{moduleId}
  // We click by matching key to moduleId

  // Main loop
  for (let i = 0; i < modules.length; i++) {
    if (!loopState.running) {
      notifyPopup({ action: 'log', msg: 'Stopped.', type: 'skip' });
      break;
    }

    loopState.index = i;
    const mod = modules[i];
    notifyPopup({ action: 'log', msg: `[${i+1}/${modules.length}] ${mod.title}`, type: 'info' });
    notifyPopup({ action: 'progress', done: i, total: modules.length });

    try {
      // Click the d2l-list-item-nav with matching key inside d2l-lessons-toc shadow root
      // Navigate via action-href to ensure the content panel actually changes
      notifyPopup({ action: 'log', msg: `  Clicking nav item...` });
      const clickResp = await execInFrame(tabId, frameId, (moduleId) => {
        const toc = document.querySelector('d2l-lessons-toc');
        if (!toc?.shadowRoot) return { clicked: false, error: 'no toc shadow root' };
        const item = toc.shadowRoot.querySelector(`d2l-list-item-nav[key="${moduleId}"]`);
        if (!item) return { clicked: false, error: `no item with key=${moduleId}` };

        // Try clicking the inner anchor in the item's shadow root first
        const innerBtn = item.shadowRoot?.querySelector('a, [role="link"], button');
        if (innerBtn) {
          innerBtn.click();
          return { clicked: true, method: 'inner', label: item.getAttribute('label') };
        }

        // Fallback: navigate via action-href
        const href = item.getAttribute('action-href');
        if (href) {
          window.location.href = href;
          return { clicked: true, method: 'href', label: item.getAttribute('label') };
        }

        // Last resort: dispatch click
        item.click();
        return { clicked: true, method: 'click', label: item.getAttribute('label') };
      }, [String(mod.moduleId)]);

      if (!clickResp?.clicked) {
        notifyPopup({ action: 'log', msg: `  Click failed: ${clickResp?.error}`, type: 'err' });
        continue;
      }
      notifyPopup({ action: 'log', msg: `  Clicked (${clickResp.method}): ${clickResp.label}` });

      // If we navigated via href, wait for the iframe to reload
      if (clickResp.method === 'href') {
        await sleep(4000); // iframe reload takes a moment
      } else {
        await sleep(2000); // content panel update
      }

      // Wait for download button
      notifyPopup({ action: 'log', msg: `  Waiting for download button...` });
      const found = await waitForDownloadButton(tabId, frameId, 20000);
      if (!found) {
        notifyPopup({ action: 'log', msg: `  Download button not found — skipping`, type: 'err' });
        continue;
      }

      // Click download and wait for ZIP
      const zipPromise = watchForZip(90000);
      const dlResp = await execInFrame(tabId, frameId, () => {
        const host = document.querySelector('d2l-button-icon.download-content-button');
        if (!host) return { clicked: false, error: 'host not found' };
        const btn = host.shadowRoot?.querySelector('button');
        if (!btn) return { clicked: false, error: 'no button in shadowRoot' };
        btn.click();
        return { clicked: true };
      });

      if (!dlResp?.clicked) {
        notifyPopup({ action: 'log', msg: `  Download click failed: ${dlResp?.error}`, type: 'err' });
        continue;
      }
      notifyPopup({ action: 'log', msg: `  Waiting for ZIP...` });

      const filePath = await zipPromise;
      notifyPopup({ action: 'log', msg: `  ✓ ${mod.title}`, type: 'ok' });
      notifyPopup({ action: 'log', msg: `  ${filePath}`, type: 'path' });
      notifyPopup({ action: 'progress', done: i + 1, total: modules.length });

      await sleep(1500);

    } catch (err) {
      notifyPopup({ action: 'log', msg: `  Error: ${err.message}`, type: 'err' });
    }
  }

  // Main loop
  for (let i = 0; i < modules.length; i++) {
    if (!loopState.running) {
      notifyPopup({ action: 'log', msg: 'Stopped.', type: 'skip' });
      break;
    }

    loopState.index = i;
    const mod = modules[i];
    notifyPopup({ action: 'log', msg: `[${i+1}/${modules.length}] ${mod.title}`, type: 'info' });
    notifyPopup({ action: 'progress', done: i, total: modules.length });

    try {
      // Click the nav item
      notifyPopup({ action: 'log', msg: `  Clicking left nav item...` });
      const clickResp = await execInFrame(tabId, frameId, (idx) => {
        const items = document.querySelectorAll('d2l-list-item-content');
        const el = items[idx];
        if (!el) return { clicked: false, error: `no item at index ${idx} (total: ${items.length})` };
        el.click();
        const inner = el.querySelector('[role="button"], button, a');
        if (inner) inner.click();
        return { clicked: true };
      }, [i]);

      if (!clickResp?.clicked) {
        notifyPopup({ action: 'log', msg: `  Click failed: ${clickResp?.error}`, type: 'err' });
        continue;
      }

      // Wait for download button
      notifyPopup({ action: 'log', msg: `  Waiting for download button...` });
      const found = await waitForDownloadButton(tabId, frameId, 20000);
      if (!found) {
        notifyPopup({ action: 'log', msg: `  Download button not found — skipping`, type: 'err' });
        continue;
      }

      // Click download and wait for ZIP
      const zipPromise = watchForZip(90000);
      const dlResp = await execInFrame(tabId, frameId, () => {
        const host = document.querySelector('d2l-button-icon.download-content-button');
        if (!host) return { clicked: false, error: 'host not found' };
        const btn = host.shadowRoot?.querySelector('button');
        if (!btn) return { clicked: false, error: 'no button in shadowRoot' };
        btn.click();
        return { clicked: true };
      });

      if (!dlResp?.clicked) {
        notifyPopup({ action: 'log', msg: `  Download click failed: ${dlResp?.error}`, type: 'err' });
        continue;
      }
      notifyPopup({ action: 'log', msg: `  Waiting for ZIP...` });

      const filePath = await zipPromise;
      notifyPopup({ action: 'log', msg: `  ✓ ${mod.title}`, type: 'ok' });
      notifyPopup({ action: 'log', msg: `  ${filePath}`, type: 'path' });
      notifyPopup({ action: 'progress', done: i + 1, total: modules.length });

      await sleep(1500);

    } catch (err) {
      notifyPopup({ action: 'log', msg: `  Error: ${err.message}`, type: 'err' });
    }
  }

  loopState = null;
  notifyPopup({ action: 'done', total: modules.length });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startDownloads') {
    runDownloadLoop(msg.tabId, msg.modules);
    sendResponse({ started: true });
    return false;
  }
  if (msg.action === 'stopDownloads') {
    if (loopState) loopState.running = false;
    sendResponse({ stopped: true });
    return false;
  }
  if (msg.action === 'getLoopState') {
    sendResponse({ state: loopState ? { running: loopState.running, index: loopState.index, total: loopState.modules.length } : null });
    return false;
  }
});
