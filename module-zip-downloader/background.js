// background.js

let loopState = null;
let downloadsDir = null;
let basePath = null;

async function resolveBasePath() {
  if (basePath) return;
  try {
    const res = await fetch('http://localhost:7734/ping');
    const data = await res.json();
    if (data.base) basePath = data.base;
  } catch (_) {}
}

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
  // Try smart-curriculum first, then fall back to other Brightspace content iframes
  for (const frame of frames) {
    if (frame.url && frame.url.includes('smart-curriculum')) return frame.frameId;
  }
  for (const frame of frames) {
    if (frame.url && (
      frame.url.includes('/d2l/le/lessons/') ||
      frame.url.includes('/d2l/lp/lessons/')
    )) return frame.frameId;
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

// Attach onCreated BEFORE clicking, returns a promise that resolves with the downloadId
function captureNextDownloadId() {
  return new Promise((resolve) => {
    const listener = (item) => {
      chrome.downloads.onCreated.removeListener(listener);
      resolve(item.id);
    };
    chrome.downloads.onCreated.addListener(listener);
  });
}

// Poll every 5s until download is complete or interrupted
async function waitForDownloadById(downloadId, timeoutMs = 300000) {
  const start = Date.now();
  let interruptedCount = 0;
  while (Date.now() - start < timeoutMs) {
    await sleep(5000);
    const results = await new Promise(resolve =>
      chrome.downloads.search({ id: downloadId }, resolve)
    );
    const item = results?.[0];
    if (!item) continue;
    if (item.state === 'complete') return { success: true, filename: item.filename };
    if (item.state === 'interrupted') {
      interruptedCount++;
      notifyPopup({ action: 'log', msg: `  Interrupted (${interruptedCount}/5) — waiting to see if it recovers...` });
      if (interruptedCount >= 5) return { success: false, error: item.error };
      continue;
    }
    // state === 'in_progress', reset interrupted counter
    interruptedCount = 0;
    const pct = item.totalBytes > 0
      ? Math.round((item.bytesReceived / item.totalBytes) * 100)
      : '?';
    notifyPopup({ action: 'log', msg: `  Downloading... ${pct}%` });
  }
  return { success: false, error: 'timed out' };
}

async function resolveDownloadsDir() {
  if (downloadsDir) return;
  // Try companion server first
  try {
    const res = await fetch('http://localhost:7734/downloads-dir');
    const data = await res.json();
    if (data.path) { downloadsDir = data.path; return; }
  } catch (_) {}
  // Fallback: derive from Chrome download history
  return new Promise((resolve) => {
    chrome.downloads.search({ limit: 1, orderBy: ['-startTime'], state: 'complete' }, (results) => {
      const f = results?.[0]?.filename;
      if (f) downloadsDir = f.substring(0, f.lastIndexOf('/'));
      resolve();
    });
  });
}

async function isAlreadyDownloaded(courseFolder, index) {
  try {
    const res = await fetch('http://localhost:7734/exists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: `${courseFolder}/modules/module${index}` }),
    });
    const data = await res.json();
    return data.exists === true;
  } catch (_) {
    return false;
  }
}

async function extractModule(fromPath, courseFolder, index) {
  const to = `${courseFolder}/modules/module${index}`;
  try {
    const res = await fetch('http://localhost:7734/unzip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromPath, to }),
    });
    const data = await res.json();
    return data.error ? null : to;
  } catch (_) {
    return null;
  }
}

async function updateState(state) {
  try {
    await fetch('http://localhost:7734/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'save_text',
        path: 'extensions-playground/module-zip-downloader/download-state.json',
        content: JSON.stringify(state, null, 2),
      }),
    });
  } catch (_) {}
}

async function runDownloadLoop(tabId, modules, courseFolder) {
  loopState = { running: true, tabId, modules, index: 0 };
  downloadsDir = null;

  await resolveBasePath();
  notifyPopup({ action: 'log', msg: `Base path: ${basePath}`, type: 'info' });
  notifyPopup({ action: 'log', msg: `Course folder: ${courseFolder}`, type: 'info' });

  notifyPopup({ action: 'log', msg: 'Finding smart-curriculum iframe...', type: 'info' });
  const frameId = await waitForSmartCurriculumFrame(tabId, 15000);
  if (frameId === null) {
    notifyPopup({ action: 'log', msg: 'Could not find smart-curriculum iframe.', type: 'err' });
    loopState = null;
    notifyPopup({ action: 'done', total: 0 });
    return;
  }
  notifyPopup({ action: 'log', msg: `Found iframe (frameId: ${frameId})`, type: 'ok' });

  await resolveDownloadsDir();
  if (downloadsDir) notifyPopup({ action: 'log', msg: `Downloads dir: ${downloadsDir}`, type: 'info' });

  const state = { total: modules.length, courseFolder, modules: modules.map(m => ({ ...m, status: 'pending' })) };
  await updateState(state);

  for (let i = 0; i < modules.length; i++) {
    if (!loopState.running) {
      notifyPopup({ action: 'log', msg: 'Stopped.', type: 'skip' });
      break;
    }

    loopState.index = i;
    const mod = modules[i];
    notifyPopup({ action: 'log', msg: `[${i+1}/${modules.length}] ${mod.title}`, type: 'info' });

    const alreadyDone = await isAlreadyDownloaded(courseFolder, i);
    if (alreadyDone) {
      notifyPopup({ action: 'log', msg: `  Already downloaded — skipping`, type: 'skip' });
      notifyPopup({ action: 'progress', done: i + 1, total: modules.length });
      state.modules[i].status = 'skipped';
      await updateState(state);
      continue;
    }

    notifyPopup({ action: 'progress', done: i, total: modules.length });

    // Re-fetch frameId — iframe may have reloaded
    const currentFrameId = await findSmartCurriculumFrame(tabId) ?? frameId;

    try {
      notifyPopup({ action: 'log', msg: `  Clicking nav item...` });
      const clickResp = await execInFrame(tabId, currentFrameId, (moduleId) => {
        const toc = document.querySelector('d2l-lessons-toc');
        if (!toc?.shadowRoot) return { clicked: false, error: 'no toc shadow root' };
        const item = toc.shadowRoot.querySelector(`d2l-list-item-nav[key="${moduleId}"]`);
        if (!item) return { clicked: false, error: `no item with key=${moduleId}` };
        const innerBtn = item.shadowRoot?.querySelector('a, [role="link"], button');
        if (innerBtn) {
          innerBtn.click();
          return { clicked: true, method: 'inner', label: item.getAttribute('label') };
        }
        const href = item.getAttribute('action-href');
        if (href) {
          window.location.href = href;
          return { clicked: true, method: 'href', label: item.getAttribute('label') };
        }
        item.click();
        return { clicked: true, method: 'click', label: item.getAttribute('label') };
      }, [String(mod.moduleId)]);

      if (!clickResp?.clicked) {
        notifyPopup({ action: 'log', msg: `  Click failed: ${clickResp?.error}`, type: 'err' });
        state.modules[i].status = 'failed';
        await updateState(state);
        continue;
      }
      notifyPopup({ action: 'log', msg: `  Clicked (${clickResp.method}): ${clickResp.label}` });

      await sleep(clickResp.method === 'href' ? 4000 : 2000);

      notifyPopup({ action: 'log', msg: `  Waiting for download button...` });
      const found = await waitForDownloadButton(tabId, currentFrameId, 20000);
      if (!found) {
        notifyPopup({ action: 'log', msg: `  Download button not found — skipping`, type: 'err' });
        state.modules[i].status = 'failed';
        await updateState(state);
        continue;
      }

      // Attach listener BEFORE clicking so we don't miss the onCreated event
      const downloadIdPromise = captureNextDownloadId();

      const dlResp = await execInFrame(tabId, currentFrameId, () => {
        const host = document.querySelector('d2l-button-icon.download-content-button');
        if (!host) return { clicked: false, error: 'host not found' };
        const btn = host.shadowRoot?.querySelector('button');
        if (!btn) return { clicked: false, error: 'no button in shadowRoot' };
        btn.click();
        return { clicked: true };
      });

      if (!dlResp?.clicked) {
        notifyPopup({ action: 'log', msg: `  Download click failed: ${dlResp?.error}`, type: 'err' });
        state.modules[i].status = 'failed';
        await updateState(state);
        continue;
      }

      const downloadId = await downloadIdPromise;
      notifyPopup({ action: 'log', msg: `  Download started (id: ${downloadId}), polling every 5s...` });
      state.modules[i].status = 'downloading';
      state.modules[i].downloadId = downloadId;
      await updateState(state);

      const result = await waitForDownloadById(downloadId, 300000);

      if (!result.success) {
        notifyPopup({ action: 'log', msg: `  Download failed: ${result.error}`, type: 'err' });
        state.modules[i].status = 'failed';
        await updateState(state);
        continue;
      }

      notifyPopup({ action: 'log', msg: `  ✓ ${mod.title}`, type: 'ok' });
      notifyPopup({ action: 'log', msg: `  Downloaded: ${result.filename}`, type: 'path' });

      const extracted = await extractModule(result.filename, courseFolder, i);
      if (extracted) {
        notifyPopup({ action: 'log', msg: `  Extracted to: ${courseFolder}/modules/module${i}`, type: 'ok' });
      } else {
        notifyPopup({ action: 'log', msg: `  (companion server not running — not extracted)`, type: 'skip' });
      }

      state.modules[i].status = 'done';
      state.modules[i].file = extracted || result.filename;
      await updateState(state);

      notifyPopup({ action: 'progress', done: i + 1, total: modules.length });
      await sleep(1500);

    } catch (err) {
      notifyPopup({ action: 'log', msg: `  Error: ${err.message}`, type: 'err' });
      state.modules[i].status = 'failed';
      await updateState(state);
    }
  }

  loopState = null;
  notifyPopup({ action: 'done', total: modules.length });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'startDownloads') {
    runDownloadLoop(msg.tabId, msg.modules, msg.courseFolder);
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
