// content.js - runs in ALL frames including smart-curriculum iframe

// Get course ID from current URL or page context
function getCourseId() {
  const patterns = [
    /[?&]ou=(\d+)/,
    /\/d2l\/le\/[^/]+\/(\d+)/,
    /\/d2l\/home\/(\d+)/,
    /\/d2l\/lp\/[^/]+\/(\d+)/,
  ];
  for (const p of patterns) {
    const m = window.location.href.match(p);
    if (m) return m[1];
  }
  // Try global context injected by Brightspace
  try {
    const ctx = JSON.parse(document.documentElement.dataset.globalContext || '{}');
    if (ctx.orgUnitId) return ctx.orgUnitId;
  } catch (_) {}
  return null;
}

// Fetch module list via ToC API — works from any frame on cascade.myunfc.ca
async function getModulesViaApi(courseId) {
  const res = await fetch(`/d2l/api/le/1.0/${courseId}/content/toc`);
  if (!res.ok) throw new Error(`ToC API ${res.status}`);
  const toc = await res.json();
  const modules = [];
  function collect(mod) {
    modules.push({ moduleId: mod.ModuleId, title: mod.Title });
    for (const sub of (mod.Modules || [])) collect(sub);
  }
  for (const mod of (toc.Modules || [])) collect(mod);
  return modules;
}

// Click the download button, piercing shadow DOM
function clickDownloadButton() {
  const host = document.querySelector('d2l-button-icon.download-content-button');
  if (!host) return { clicked: false, error: 'host not found' };
  const btn = host.shadowRoot?.querySelector('button');
  if (!btn) return { clicked: false, error: 'no button in shadowRoot' };
  btn.click();
  return { clicked: true };
}

function hasDownloadButton() {
  const host = document.querySelector('d2l-button-icon.download-content-button');
  return !!(host && host.shadowRoot?.querySelector('button'));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === 'getModules') {
    // Call from whichever frame responds first — all frames are same-domain
    const cid = msg.courseId || getCourseId();
    if (!cid) { sendResponse({ error: 'no courseId' }); return false; }
    getModulesViaApi(cid)
      .then(modules => sendResponse({ modules, frameUrl: window.location.href }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.action === 'clickDownload') {
    sendResponse(clickDownloadButton());
    return false;
  }

  if (msg.action === 'hasDownloadButton') {
    sendResponse({ found: hasDownloadButton(), url: window.location.href });
    return false;
  }

  if (msg.action === 'ping') {
    sendResponse({ pong: true, url: window.location.href });
    return false;
  }

  return false;
});
