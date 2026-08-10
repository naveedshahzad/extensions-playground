const runButton = document.getElementById("run");
const exportButton = document.getElementById("export");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const queryEl = document.getElementById("query");
const minReviewsEl = document.getElementById("minReviews");
const maxResultsEl = document.getElementById("maxResults");
const modeEl = document.getElementById("mode");

let lastResult = null;

runButton.addEventListener("click", runAnalysis);
exportButton.addEventListener("click", exportCsv);

async function runAnalysis() {
  setLoading(true);
  const isDeep = modeEl.value === "deep";
  statusEl.textContent = isDeep
    ? "Running deep mode... this can take 2-5 minutes because review snippets are analyzed."
    : "Running... this can take up to 30-60 seconds while Maps loads listings.";
  resultsEl.innerHTML = "";
  exportButton.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isGoogleMapsUrl(tab.url || "")) {
      throw new Error("Please open Google Maps in the active tab first.");
    }

    const mapsSearchUrl = buildMapsSearchUrl(queryEl.value.trim());
    await chrome.tabs.update(tab.id, { url: mapsSearchUrl });
    await waitForTabComplete(tab.id, 25000);

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "RUN_ANALYSIS",
      payload: {
        query: queryEl.value.trim(),
        minReviews: Number(minReviewsEl.value) || 0,
        maxResults: Number(maxResultsEl.value) || 120,
        skipSearchInput: true,
        mode: modeEl.value
      }
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Unknown error while analyzing listings.");
    }

    lastResult = response.result;
    renderResults(lastResult.ranked);
    const modeText = lastResult.mode === "deep" ? "deep" : "fast";
    statusEl.textContent = `Scanned ${lastResult.totalCollected} listings in ${modeText} mode. Showing top ${lastResult.ranked.length}.`;
    exportButton.disabled = lastResult.ranked.length === 0;
  } catch (error) {
    statusEl.textContent = error.message;
  } finally {
    setLoading(false);
  }
}

function renderResults(items) {
  if (!items.length) {
    resultsEl.innerHTML = "<li>No listings matched your filters. Try lowering Min Reviews.</li>";
    return;
  }

  resultsEl.innerHTML = items
    .map((item) => {
      const stars = item.rating.toFixed(1);
      const reviews = item.reviewCount.toLocaleString();
      const score = item.score.toFixed(3);
      const deep = Number.isFinite(item.deepScore) ? ` | Deep: ${item.deepScore.toFixed(3)}` : "";
      const snippets = Array.isArray(item.reviewSnippets) ? ` | Snippets: ${item.reviewSnippets.length}` : "";
      return `
        <li>
          <a href="${escapeHtml(item.url)}" target="_blank">${escapeHtml(item.name)}</a><br>
          Rating: ${stars} | Reviews: ${reviews} | Score: ${score}${deep}${snippets}
        </li>`;
    })
    .join("");
}

function exportCsv() {
  if (!lastResult?.ranked?.length) {
    return;
  }

  const header = ["Rank", "Name", "Rating", "ReviewCount", "Score", "DeepScore", "ReviewSnippetCount", "URL"];
  const rows = lastResult.ranked.map((item, index) => [
    index + 1,
    item.name,
    item.rating,
    item.reviewCount,
    item.score,
    item.deepScore ?? "",
    Array.isArray(item.reviewSnippets) ? item.reviewSnippets.length : "",
    item.url
  ]);

  const csv = [header, ...rows]
    .map((row) => row.map(quoteCsv).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dentist-top10-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function setLoading(loading) {
  runButton.disabled = loading;
  queryEl.disabled = loading;
  minReviewsEl.disabled = loading;
  maxResultsEl.disabled = loading;
  modeEl.disabled = loading;
}

function quoteCsv(value) {
  const str = String(value ?? "").replace(/"/g, '""');
  return `"${str}"`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isGoogleMapsUrl(url) {
  return /^https:\/\/www\.google\.[^/]+\/maps/i.test(url);
}

function buildMapsSearchUrl(query) {
  const q = (query || "Dentists in Surrey BC and nearby towns").trim();
  return `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Google Maps took too long to load. Please try again."));
    }, timeoutMs);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId !== tabId) {
        return;
      }
      if (info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}
