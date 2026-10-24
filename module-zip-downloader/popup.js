// popup.js

let currentTab = null;
let modules = [];
let courseId = null;
let courseFolder = null;

const logEl        = document.getElementById('log');
const startBtn     = document.getElementById('startBtn');
const stopBtn      = document.getElementById('stopBtn');
const courseBadge  = document.getElementById('courseBadge');
const moduleCount  = document.getElementById('moduleCount');
const progressBar  = document.getElementById('progressBar');
const progressWrap = document.getElementById('progressWrap');
const progressText = document.getElementById('progressText');
const moduleSec    = document.getElementById('modulesSection');
const saveInfoBtn  = document.getElementById('saveInfoBtn');

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
          const tocRes = await fetch(`/d2l/api/le/1.0/${id}/content/toc`);
          if (!tocRes.ok) return null;
          const toc = await tocRes.json();
          const mods = [];
          function collect(m) {
            mods.push({ moduleId: m.ModuleId, title: m.Title });
            for (const s of (m.Modules || [])) collect(s);
          }
          for (const m of (toc.Modules || [])) collect(m);
          // Extract course code from page title e.g. "Fall 2026 Project Management (MGMT-640-100-O)" -> "mgmt-640"
          const titleMatch = document.title.match(/\(?(MGMT-\d+)/i);
          const courseFolder = titleMatch ? titleMatch[1].toLowerCase() : '';
          return mods.length > 0 ? { modules: mods, courseId: id, courseFolder } : null;
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
  courseFolder = success.result.courseFolder;

  log(`Found ${modules.length} modules (course: ${courseFolder}):`, 'ok');
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
    courseFolder,
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

// ── SAVE COURSE INFO ─────────────────────────────────────────────────────────

async function saveCourseInfo() {
  saveInfoBtn.disabled = true;
  log('Extracting course info from page...', 'info');

  const results = await chrome.scripting.executeScript({
    target: { tabId: currentTab.id },
    func: async () => {
      // Course title from nav link title attribute
      const navLink = document.querySelector('a.d2l-navigation-s-link[href*="/d2l/home/"]');
      const fullTitle = navLink?.getAttribute('title') || document.title;

      // e.g. "Fall 2026 Project Management (MGMT-640-100-O)"
      const codeMatch  = fullTitle.match(/(MGMT-\d+)/i);
      const termMatch  = fullTitle.match(/(Fall|Winter|Spring|Summer)\s+(\d{4})/i);
      const nameMatch  = fullTitle.match(/^(?:(?:Fall|Winter|Spring|Summer)\s+\d{4}\s+)?(.+?)\s*\(/i);

      const courseCode = codeMatch ? codeMatch[1].toUpperCase() : '';
      const term       = termMatch ? termMatch[0] : '';
      const courseName = nameMatch ? nameMatch[1].trim() : fullTitle;

      // Student name from nav avatar opener-label
      const avatarBtn  = document.querySelector('d2l-labs-navigation-dropdown-button-custom');
      const studentName = avatarBtn?.getAttribute('opener-label')?.replace(', avatar', '').trim() || '';

      // orgUnitId from data-global-context
      const globalCtx  = JSON.parse(document.documentElement.dataset.globalContext || '{}');
      const orgUnitId  = globalCtx.orgUnitId || '';

      // Fetch course home page to find instructor
      let instructor = 'TBD';
      let instructorEmail = '';
      if (orgUnitId) {
        try {
          const res  = await fetch(`/d2l/home/${orgUnitId}`);
          const html = await res.text();

          // Pattern 1: email mailto link e.g. href="mailto:shweta.dharia@unfc.ca"
          const emailMatch = html.match(/href="mailto:([^"]+@unfc\.ca)"/);
          if (emailMatch) instructorEmail = emailMatch[1];

          // Pattern 2: profile image filename e.g. "1234_Shweta Dharia.png"
          const imgMatch = html.match(/\d+_([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\.(?:png|jpg|jpeg)/i);
          if (imgMatch) { instructor = imgMatch[1]; }

          // Pattern 3: plain text patterns as fallback
          if (instructor === 'TBD') {
            const patterns = [
              /instructor[:\s]+([A-Z][a-z.]+(?:\s+[A-Z][a-z.]+){1,3})/i,
              /professor[:\s]+([A-Z][a-z.]+(?:\s+[A-Z][a-z.]+){1,3})/i,
              /taught\s+by[:\s]+([A-Z][a-z.]+(?:\s+[A-Z][a-z.]+){1,3})/i,
            ];
            for (const p of patterns) {
              const m = html.match(p);
              if (m) { instructor = m[1].trim(); break; }
            }
          }

          // Derive name from email as last fallback e.g. shweta.dharia@unfc.ca -> Shweta Dharia
          if (instructor === 'TBD' && instructorEmail) {
            const local = instructorEmail.split('@')[0];
            instructor = local.split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
          }
        } catch (_) {}
      }

      return { courseCode, courseName, term, studentName, orgUnitId, instructor, instructorEmail };
    },
  });

  const info = results?.[0]?.result;
  if (!info?.courseCode) {
    log('Could not extract course info.', 'err');
    saveInfoBtn.disabled = false;
    return;
  }

  log(`Course: ${info.courseCode} - ${info.courseName}`, 'ok');
  log(`Term: ${info.term}`, 'info');
  log(`Student: ${info.studentName}`, 'info');
  log(`Instructor: ${info.instructor}${info.instructorEmail ? ' (' + info.instructorEmail + ')' : ''}`, 'info');

  const folder = info.courseCode.toLowerCase();
  const md = [
    `# ${info.courseCode} Course Overview`,
    ``,
    `## Course Details`,
    `- **Course**: ${info.courseCode} (${info.courseName})`,
    `- **Term**: ${info.term}`,
    `- **Student**: ${info.studentName}`,
    `- **Program**: Master of Management`,
    `- **University**: University of Niagara Falls Canada`,
    `- **Platform**: Cascade (Brightspace/D2L)`,
    ``,
    `## Instructor`,
    `- **Name**: ${info.instructor}`,
    ...(info.instructorEmail ? [`- **Email**: ${info.instructorEmail}`] : []),
    ``,
    `## Assessments`,
    `| Assessment | Weight | Due Date | Notes |`,
    `|---|---|---|---|`,
    `| TBD | | | |`,
    ``,
    `## Modules`,
    ...(modules.length > 0
      ? modules.map((m, i) => `- Module ${i}: ${m.title}`)
      : ['- TBD']),
    ``,
    `## Notes`,
    `- Created by Cascade Module ZIP Downloader extension`,
  ].join('\n');

  try {
    const res = await fetch('http://localhost:7734/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'save_text', path: `${folder}/course-overview.md`, content: md }),
    });
    const data = await res.json();
    if (data.saved) log(`Saved to ${folder}/course-overview.md`, 'ok');
    else log(`Save failed: ${JSON.stringify(data)}`, 'err');
  } catch (_) {
    log('Companion server not running — could not save.', 'err');
  }

  saveInfoBtn.disabled = false;
}

// ── INIT ──────────────────────────────────────────────────────────────────────

stopBtn.onclick = stopDownloads;
saveInfoBtn.onclick = saveCourseInfo;

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
      saveInfoBtn.disabled = false;
    }
  });
});
