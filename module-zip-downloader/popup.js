// popup.js

let currentTab = null;
let modules = [];
let courseId = null;

const logEl        = document.getElementById('log');
const startBtn     = document.getElementById('startBtn');
const stopBtn      = document.getElementById('stopBtn');
const courseBadge  = document.getElementById('courseBadge');
const moduleCount  = document.getElementById('moduleCount');
const progressBar  = document.getElementById('progressBar');
const progressWrap = document.getElementById('progressWrap');
const progressText = document.getElementById('progressText');
const moduleSec    = document.getElementById('modulesSection');

function log(msg, type = '') {
  const el = document.createElement('div');
  el.className = `log-entry ${type}`;
  el.textContent = `> ${msg}`;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = pct + '%';
  progressText.textContent = `${done} / ${total} (${pct}%)`;
}

function setRunningUI(running) {
  startBtn.style.display = running ? 'none' : 'block';
  stopBtn.style.display  = running ? 'block' : 'none';
}

// ── SCAN ──────────────────────────────────────────────────────────────────────

async function scanModules() {
  log('Fetching module list...', 'info');
  startBtn.disabled = true;

  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id, allFrames: true },
    func: (cid) => {
      async function go() {
        const id = cid ||
          window.location.href.match(/[?&]ou=(\d+)/)?.[1] ||
          window.location.href.match(/\/d2l\/le\/[^/]+\/(\d+)/)?.[1] ||
          window.location.href.match(/\/d2l\/home\/(\d+)/)?.[1];
        if (!id) return null;
        try {
          const res = await fetch(`/d2l/api/le/1.0/${id}/content/toc`);
          if (!res.ok) return null;
          const toc = await res.json();
          const mods = [];
          function collect(m) {
            mods.push({ moduleId: m.ModuleId, title: m.Title });
            for (const s of (m.Modules || [])) collect(s);
          }
          for (const m of (toc.Modules || [])) collect(m);
          return mods.length > 0 ? { modules: mods, courseId: id } : null;
        } catch (_) { return null; }
      }
      return go();
    },
    args: [courseId],
  });

  const success = results?.find(r => r?.result?.modules?.length > 0);
  if (!success) {
    log('Could not fetch modules. Make sure you are logged in.', 'err');
    startBtn.disabled = false;
    startBtn.onclick = scanModules;
    return;
  }

  modules = success.result.modules;
  if (!courseId) courseId = success.result.courseId;

  log(`Found ${modules.length} modules:`, 'ok');
  modules.forEach((m, i) => log(`  [${i+1}] ${m.title}`, 'info'));

  moduleSec.style.display = 'block';
  progressWrap.style.display = 'block';
  moduleCount.textContent = `${modules.length} modules ready`;
  setProgress(0, modules.length);

  startBtn.textContent = 'Download All ZIPs';
  startBtn.disabled = false;
  startBtn.onclick = startDownloads;
}

// ── START / STOP ──────────────────────────────────────────────────────────────

function startDownloads() {
  setRunningUI(true);
  log('Starting download loop (runs in background)...', 'info');
  chrome.runtime.sendMessage({
    action: 'startDownloads',
    tabId: currentTab.id,
    modules,
  });
}

function stopDownloads() {
  chrome.runtime.sendMessage({ action: 'stopDownloads' });
  setRunningUI(false);
}

// ── LISTEN FOR BACKGROUND PROGRESS ───────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'log') {
    log(msg.msg, msg.type || '');
  } else if (msg.action === 'progress') {
    setProgress(msg.done, msg.total);
  } else if (msg.action === 'done') {
    setRunningUI(false);
    log(`All done! ${msg.total} modules processed.`, 'ok');
    setProgress(msg.total, msg.total);
  }
});

// ── INIT ──────────────────────────────────────────────────────────────────────

stopBtn.onclick = stopDownloads;

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  currentTab = tabs[0];

  if (!currentTab?.url?.includes('cascade.myunfc.ca')) {
    document.getElementById('notCascade').style.display = 'block';
    document.getElementById('mainContent').style.display = 'none';
    return;
  }

  courseId = currentTab.url.match(/[?&]ou=(\d+)/)?.[1] ||
             currentTab.url.match(/\/d2l\/le\/[^/]+\/(\d+)/)?.[1] ||
             currentTab.url.match(/\/d2l\/home\/(\d+)/)?.[1];

  if (courseId) {
    courseBadge.textContent = `Course ${courseId}`;
    courseBadge.classList.remove('unknown');
  }

  // Check if background loop is already running
  chrome.runtime.sendMessage({ action: 'getLoopState' }, (resp) => {
    if (resp?.state?.running) {
      setRunningUI(true);
      log(`Loop running: module ${resp.state.index + 1}/${resp.state.total}`, 'info');
    } else {
      log('Click "Scan Modules" to fetch the module list.', 'ok');
      startBtn.disabled = false;
      startBtn.onclick = scanModules;
    }
  });
});
