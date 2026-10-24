// popup.js

const btnScan      = document.getElementById('btnScan');
const btnExport    = document.getElementById('btnExport');
const statusEl     = document.getElementById('status');
const resultsEl    = document.getElementById('results');
const progressWrap = document.getElementById('progress-wrap');
const progressFill = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');
const searchTermEl  = document.getElementById('searchTerm');
const recordCountEl = document.getElementById('recordCount');

let matchedListings = [];

const BADGE_LABELS = {
  100: '🏫 In Front of School',
  80:  '🏫 Next to School',
  60:  '🚶 Steps from School',
  40:  '🗺 Near School',
  20:  '📍 School Mentioned',
  10:  '📝 School in Description'
};

function setStatus(msg) { statusEl.textContent = msg; }

function setProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressFill.style.width = pct + '%';
  progressLabel.textContent = `${done} / ${total} listings scanned`;
}

function scoreClass(score) {
  const tiers = [100, 80, 60, 40, 20, 10];
  for (const t of tiers) if (score >= t) return `score-${t}`;
  return 'score-10';
}

function badgeClass(score) {
  const tiers = [100, 80, 60, 40, 20, 10];
  for (const t of tiers) if (score >= t) return `badge-${t}`;
  return 'badge-10';
}

function renderResults(listings) {
  resultsEl.innerHTML = '';

  if (listings.length === 0) {
    resultsEl.innerHTML = '<div class="no-results">No school-facing rentals found in these listings.<br>Try increasing the scan limit or broadening your search.</div>';
    return;
  }

  listings.forEach(item => {
    const card = document.createElement('div');
    card.className = `card ${scoreClass(item.score)}`;
    card.innerHTML = `
      <div class="card-title">${escHtml(item.title || 'Rental Listing')}</div>
      <div class="card-meta">
        <span class="card-price">${escHtml(item.price || 'Price N/A')}</span>
        <span>${escHtml(item.location || '')}</span>
      </div>
      <span class="card-badge ${badgeClass(item.score)}">${BADGE_LABELS[nearestTier(item.score)] || 'School Nearby'}</span>
      ${item.snippet ? `<div class="card-snippet">${escHtml(item.snippet)}</div>` : ''}
    `;
    card.addEventListener('click', () => chrome.tabs.create({ url: item.url }));
    resultsEl.appendChild(card);
  });
}

function nearestTier(score) {
  const tiers = [100, 80, 60, 40, 20, 10];
  for (const t of tiers) if (score >= t) return t;
  return 10;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSearchUrl(query) {
  const encoded = encodeURIComponent(query.trim());
  return `https://www.facebook.com/marketplace/search/?query=${encoded}&category_id=propertyrentals`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch (e) {}
}

async function sendMessage(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, response => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(response);
    });
  });
}

async function navigateAndWait(tabId, url) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, { url }, () => {
      const listener = (id, info) => {
        if (id !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

async function openAndScan(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, async (tab) => {
      const listener = async (tabId, info) => {
        if (tabId !== tab.id || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);
        await new Promise(r => setTimeout(r, 1800));
        try {
          await injectContentScript(tab.id);
          await new Promise(r => setTimeout(r, 300));
          const data = await sendMessage(tab.id, { action: 'SCAN_LISTING' });
          chrome.tabs.remove(tab.id);
          resolve(data);
        } catch (e) {
          chrome.tabs.remove(tab.id);
          resolve(null);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

btnScan.addEventListener('click', async () => {
  const searchTerm = searchTermEl.value.trim();
  const recordLimit = parseInt(recordCountEl.value, 10); // 0 = no limit

  if (!searchTerm) {
    setStatus('Please enter a search term.');
    searchTermEl.focus();
    return;
  }

  btnScan.disabled = true;
  btnExport.disabled = true;
  matchedListings = [];
  resultsEl.innerHTML = '';
  progressWrap.style.display = 'block';
  setProgress(0, 0);

  const tab = await getActiveTab();
  const searchUrl = buildSearchUrl(searchTerm);

  setStatus('Navigating to Marketplace search...');
  await navigateAndWait(tab.id, searchUrl);
  await new Promise(r => setTimeout(r, 2500)); // let FB render results

  setStatus('Scrolling to collect listings...');
  await injectContentScript(tab.id);

  let urls;
  try {
    const resp = await sendMessage(tab.id, { action: 'COLLECT_URLS', limit: recordLimit });
    urls = resp.urls || [];
  } catch (e) {
    setStatus('Could not collect listings. Try reloading the page.');
    btnScan.disabled = false;
    return;
  }

  if (urls.length === 0) {
    setStatus('No listings found. Try a different search term.');
    btnScan.disabled = false;
    return;
  }

  // Apply record limit
  const toScan = recordLimit > 0 ? urls.slice(0, recordLimit) : urls;

  setStatus(`Found ${urls.length} listings. Scanning ${toScan.length}...`);
  setProgress(0, toScan.length);

  const CONCURRENCY = 2;
  let done = 0;

  for (let i = 0; i < toScan.length; i += CONCURRENCY) {
    const batch = toScan.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(url => openAndScan(url)));

    results.forEach(data => {
      if (data && data.matched) matchedListings.push(data);
    });

    done += batch.length;
    setProgress(done, toScan.length);
    setStatus(`Scanned ${done}/${toScan.length} — found ${matchedListings.length} school-facing rentals so far...`);
  }

  matchedListings.sort((a, b) => b.score - a.score);

  setStatus(`Done. Found ${matchedListings.length} school-facing rental${matchedListings.length !== 1 ? 's' : ''} out of ${toScan.length} scanned.`);
  renderResults(matchedListings);

  btnScan.disabled = false;
  btnExport.disabled = matchedListings.length === 0;
});

btnExport.addEventListener('click', () => {
  if (matchedListings.length === 0) return;

  const header = 'Title,Price,Location,Score,Badge,Snippet,URL';
  const rows = matchedListings.map(item => [
    `"${(item.title || '').replace(/"/g, '""')}"`,
    `"${(item.price || '').replace(/"/g, '""')}"`,
    `"${(item.location || '').replace(/"/g, '""')}"`,
    item.score,
    `"${(BADGE_LABELS[nearestTier(item.score)] || '').replace(/"/g, '""')}"`,
    `"${(item.snippet || '').replace(/"/g, '""')}"`,
    `"${item.url}"`
  ].join(','));

  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'school_rentals.csv';
  a.click();
  URL.revokeObjectURL(url);
});

const statusEl  = document.getElementById('status');
const resultsEl = document.getElementById('results');
const progressWrap = document.getElementById('progress-wrap');
const progressFill = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');

let matchedListings = [];

const BADGE_LABELS = {
  100: '🏫 In Front of School',
  80:  '🏫 Next to School',
  60:  '🚶 Steps from School',
  40:  '🗺 Near School',
  20:  '📍 School Mentioned',
  10:  '📝 School in Description'
};

function setStatus(msg) { statusEl.textContent = msg; }

function setProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressFill.style.width = pct + '%';
  progressLabel.textContent = `${done} / ${total} listings scanned`;
}

function scoreClass(score) {
  const tiers = [100, 80, 60, 40, 20, 10];
  for (const t of tiers) if (score >= t) return `score-${t}`;
  return 'score-10';
}

function badgeClass(score) {
  const tiers = [100, 80, 60, 40, 20, 10];
  for (const t of tiers) if (score >= t) return `badge-${t}`;
  return 'badge-10';
}

function renderResults(listings) {
  resultsEl.innerHTML = '';

  if (listings.length === 0) {
    resultsEl.innerHTML = '<div class="no-results">No school-facing rentals found in these listings.<br>Try scrolling further or broadening your search.</div>';
    return;
  }

  listings.forEach(item => {
    const card = document.createElement('div');
    card.className = `card ${scoreClass(item.score)}`;
    card.innerHTML = `
      <div class="card-title">${escHtml(item.title || 'Rental Listing')}</div>
      <div class="card-meta">
        <span class="card-price">${escHtml(item.price || 'Price N/A')}</span>
        <span>${escHtml(item.location || '')}</span>
      </div>
      <span class="card-badge ${badgeClass(item.score)}">${BADGE_LABELS[nearestTier(item.score)] || 'School Nearby'}</span>
      ${item.snippet ? `<div class="card-snippet">${escHtml(item.snippet)}</div>` : ''}
    `;
    card.addEventListener('click', () => chrome.tabs.create({ url: item.url }));
    resultsEl.appendChild(card);
  });
}

function nearestTier(score) {
  const tiers = [100, 80, 60, 40, 20, 10];
  for (const t of tiers) if (score >= t) return t;
  return 10;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch (e) {
    // already injected
  }
}

async function sendMessage(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, response => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(response);
    });
  });
}

async function openAndScan(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, async (tab) => {
      // Wait for the tab to finish loading
      const listener = async (tabId, info) => {
        if (tabId !== tab.id || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);

        // Give FB a moment to render
        await new Promise(r => setTimeout(r, 1800));

        try {
          await injectContentScript(tab.id);
          await new Promise(r => setTimeout(r, 300));
          const data = await sendMessage(tab.id, { action: 'SCAN_LISTING' });
          chrome.tabs.remove(tab.id);
          resolve(data);
        } catch (e) {
          chrome.tabs.remove(tab.id);
          resolve(null);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

btnScan.addEventListener('click', async () => {
  btnScan.disabled = true;
  btnExport.disabled = true;
  matchedListings = [];
  resultsEl.innerHTML = '';
  progressWrap.style.display = 'block';
  setProgress(0, 0);

  const tab = await getActiveTab();

  if (!tab.url.includes('facebook.com/marketplace')) {
    setStatus('Please open Facebook Marketplace first.');
    btnScan.disabled = false;
    return;
  }

  setStatus('Scrolling to collect listings...');
  await injectContentScript(tab.id);

  let urls;
  try {
    const resp = await sendMessage(tab.id, { action: 'COLLECT_URLS' });
    urls = resp.urls || [];
  } catch (e) {
    setStatus('Could not collect listings. Make sure you are on a Marketplace search page.');
    btnScan.disabled = false;
    return;
  }

  if (urls.length === 0) {
    setStatus('No listings found on this page.');
    btnScan.disabled = false;
    return;
  }

  setStatus(`Found ${urls.length} listings. Scanning each one...`);
  setProgress(0, urls.length);

  // Scan listings with a small concurrency limit to avoid rate limiting
  const CONCURRENCY = 2;
  let done = 0;

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(url => openAndScan(url)));

    results.forEach(data => {
      if (data && data.matched) matchedListings.push(data);
    });

    done += batch.length;
    setProgress(done, urls.length);
    setStatus(`Scanned ${done}/${urls.length} — found ${matchedListings.length} school-facing rentals so far...`);
  }

  // Sort by score descending
  matchedListings.sort((a, b) => b.score - a.score);

  setStatus(`Done. Found ${matchedListings.length} school-facing rental${matchedListings.length !== 1 ? 's' : ''} out of ${urls.length} listings.`);
  renderResults(matchedListings);

  btnScan.disabled = false;
  btnExport.disabled = matchedListings.length === 0;
});

btnExport.addEventListener('click', () => {
  if (matchedListings.length === 0) return;

  const header = 'Title,Price,Location,Score,Badge,Snippet,URL';
  const rows = matchedListings.map(item => [
    `"${(item.title || '').replace(/"/g, '""')}"`,
    `"${(item.price || '').replace(/"/g, '""')}"`,
    `"${(item.location || '').replace(/"/g, '""')}"`,
    item.score,
    `"${(BADGE_LABELS[nearestTier(item.score)] || '').replace(/"/g, '""')}"`,
    `"${(item.snippet || '').replace(/"/g, '""')}"`,
    `"${item.url}"`
  ].join(','));

  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'school_rentals.csv';
  a.click();
  URL.revokeObjectURL(url);
});
