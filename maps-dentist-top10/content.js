chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "RUN_ANALYSIS") {
    return;
  }

  runAnalysis(message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function runAnalysis(payload) {
  const query = payload?.query || "Dentists in Surrey BC and nearby towns";
  const minReviews = Number(payload?.minReviews ?? 25);
  const maxResults = clamp(Number(payload?.maxResults ?? 120), 10, 300);
  const skipSearchInput = !!payload?.skipSearchInput;
  const mode = payload?.mode === "deep" ? "deep" : "fast";

  await ensureSearch(query, skipSearchInput);
  await delay(1500);

  const listings = await collectListings(maxResults);
  const fastRanked = rankListings(listings, minReviews);
  const ranked = mode === "deep"
    ? await rankListingsDeep(fastRanked)
    : fastRanked.slice(0, 10);

  return {
    query,
    mode,
    minReviews,
    maxResults,
    totalCollected: listings.length,
    ranked,
    generatedAt: new Date().toISOString()
  };
}

async function ensureSearch(query, skipSearchInput = false) {
  if (skipSearchInput) {
    await waitForResultsContainer(25000);
    return;
  }

  const input = await waitFor(() => document.querySelector("input#searchboxinput"), 15000).catch(() => null);
  if (!input) {
    if (/\/maps\/search\//i.test(location.href)) {
      await waitForResultsContainer(25000);
      return;
    }
    throw new Error("Search box was not found. Open Google Maps search results (not plain map view) and try again.");
  }

  const current = (input.value || "").trim().toLowerCase();
  const desired = query.trim().toLowerCase();

  if (current !== desired) {
    input.focus();
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const searchButton = document.querySelector("button#searchbox-searchbutton");
    if (searchButton) {
      searchButton.click();
    } else {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
    }
  }

  await waitForResultsContainer(25000);
}

async function collectListings(maxResults) {
  let feed = await waitForResultsContainer(20000);
  const byId = new Map();

  let stableRounds = 0;
  let previousSize = 0;

  for (let i = 0; i < 55; i += 1) {
    extractVisibleListings(feed, byId);

    if (byId.size >= maxResults) {
      break;
    }

    feed.scrollTop = feed.scrollHeight;
    await delay(1000);

    const refreshed = getResultsContainer();
    if (refreshed && refreshed !== feed) {
      feed = refreshed;
    }

    if (byId.size === previousSize) {
      stableRounds += 1;
      if (stableRounds >= 6) {
        break;
      }
    } else {
      stableRounds = 0;
      previousSize = byId.size;
    }
  }

  return Array.from(byId.values());
}

function extractVisibleListings(feed, byId) {
  const cardSelector = 'div[role="article"], div.Nv2PK, div.THOPZb, div.UaQhfb';
  const cards = feed.querySelectorAll(cardSelector).length
    ? feed.querySelectorAll(cardSelector)
    : document.querySelectorAll(cardSelector);

  cards.forEach((card) => {
    const anchor = card.querySelector('a[href*="/maps/place/"], a[href*="/place/"], a.hfpxzc');
    if (!anchor || !anchor.href) {
      return;
    }

    const name = getNameFromCard(card, anchor);
    const { rating, reviewCount } = parseRatingAndReviews(card);

    if (!name || !rating || !reviewCount) {
      return;
    }

    const url = anchor.href.split("?")[0];
    const id = getPlaceKey(url, name);

    byId.set(id, {
      name,
      rating,
      reviewCount,
      url
    });
  });
}

function getNameFromCard(card, anchor) {
  const fromAria = anchor.getAttribute("aria-label");
  if (fromAria && fromAria.trim()) {
    return fromAria.trim();
  }

  const heading = card.querySelector("h3, h4, .fontHeadlineSmall");
  if (heading?.textContent?.trim()) {
    return heading.textContent.trim();
  }

  return anchor.textContent?.trim() || "";
}

function parseRatingAndReviews(card) {
  const ariaCandidate = card.querySelector('[aria-label*="stars"]')?.getAttribute("aria-label") || "";
  const textCandidate = card.innerText || "";

  const fromAria = parseRatingText(ariaCandidate);
  if (fromAria) {
    return fromAria;
  }

  const fromText = parseRatingText(textCandidate);
  if (fromText) {
    return fromText;
  }

  return { rating: null, reviewCount: null };
}

function parseRatingText(text) {
  if (!text) {
    return null;
  }

  const normalized = text.replace(/\u202f/g, " ");

  let match = normalized.match(/([0-5](?:\.\d)?)\s*stars?[^\d]+([\d,]+)\s*reviews?/i);
  if (!match) {
    match = normalized.match(/([0-5](?:\.\d)?)\s*\(?\s*([\d,]+)\s*\)?/);
  }

  if (!match) {
    return null;
  }

  const rating = Number(match[1]);
  const reviewCount = Number(match[2].replace(/,/g, ""));

  if (!Number.isFinite(rating) || !Number.isFinite(reviewCount)) {
    return null;
  }

  return {
    rating,
    reviewCount
  };
}

function rankListings(listings, minReviews) {
  return listings
    .filter((item) => item.reviewCount >= minReviews)
    .map((item) => ({
      ...item,
      score: Number(wilsonLowerBound(item.rating / 5, item.reviewCount).toFixed(6))
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (b.reviewCount !== a.reviewCount) {
        return b.reviewCount - a.reviewCount;
      }
      return b.rating - a.rating;
    });
}

async function rankListingsDeep(fastRanked) {
  const candidates = fastRanked.slice(0, Math.min(18, fastRanked.length));
  const enriched = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const item = candidates[i];
    const snippets = await collectReviewSnippetsForPlace(item, 8).catch(() => []);
    const quality = analyzeReviewQuality(snippets);
    const deepScore = Number((item.score * 0.7 + quality.overall * 0.3).toFixed(6));

    enriched.push({
      ...item,
      deepScore,
      reviewSnippets: snippets.slice(0, 3),
      reviewQuality: quality
    });
  }

  return enriched
    .sort((a, b) => {
      if (b.deepScore !== a.deepScore) {
        return b.deepScore - a.deepScore;
      }
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.reviewCount - a.reviewCount;
    })
    .slice(0, 10);
}

async function collectReviewSnippetsForPlace(item, limit) {
  const anchor = findListingAnchor(item);
  if (!anchor) {
    return [];
  }

  anchor.click();
  await delay(1600);

  let snippets = collectVisibleReviewText();
  if (snippets.length < 3) {
    const modalSnippets = await openReviewPanelAndCollect(limit).catch(() => []);
    snippets = snippets.concat(modalSnippets);
  }

  return dedupeNonEmpty(snippets).slice(0, limit);
}

function findListingAnchor(item) {
  const anchors = Array.from(document.querySelectorAll('a[href*="/maps/place/"], a[href*="/place/"], a.hfpxzc'));
  if (!anchors.length) {
    return null;
  }

  const normalizedTarget = normalizeUrlForCompare(item.url);
  const byUrl = anchors.find((a) => normalizeUrlForCompare(a.href).startsWith(normalizedTarget));
  if (byUrl) {
    return byUrl;
  }

  const targetName = (item.name || "").trim().toLowerCase();
  const byName = anchors.find((a) => (a.getAttribute("aria-label") || a.textContent || "").trim().toLowerCase() === targetName);
  return byName || null;
}

function normalizeUrlForCompare(url) {
  return String(url || "").split("?")[0].replace(/\/$/, "");
}

function collectVisibleReviewText() {
  const selectors = [
    ".MyEned .wiI7pd",
    ".jftiEf .wiI7pd",
    "[data-review-id] .wiI7pd",
    "span.wiI7pd",
    "div.fontBodyMedium"
  ];

  const text = [];
  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((el) => {
      const value = (el.textContent || "").trim();
      if (value && value.length > 20) {
        text.push(value);
      }
    });
  }
  return dedupeNonEmpty(text);
}

async function openReviewPanelAndCollect(limit) {
  const reviewButton = findReviewsButton();
  if (!reviewButton) {
    return [];
  }

  reviewButton.click();

  await delay(1200);
  const panel = await waitFor(() => getReviewsScrollContainer(), 7000).catch(() => null);
  if (!panel) {
    return [];
  }

  const snippets = [];
  for (let i = 0; i < 6 && snippets.length < limit; i += 1) {
    snippets.push(...collectVisibleReviewText());
    panel.scrollTop = panel.scrollHeight;
    await delay(700);
  }

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await delay(250);

  return dedupeNonEmpty(snippets).slice(0, limit);
}

function findReviewsButton() {
  const candidates = Array.from(document.querySelectorAll("button, a"));
  return candidates.find((el) => {
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    const text = (el.textContent || "").toLowerCase();
    const itemId = (el.getAttribute("data-item-id") || "").toLowerCase();
    return aria.includes("review") || text.includes("review") || itemId.includes("review");
  }) || null;
}

function getReviewsScrollContainer() {
  const dialog = document.querySelector('div[role="dialog"]');
  if (dialog) {
    const scrollers = Array.from(dialog.querySelectorAll('div[tabindex="0"], div[tabindex="-1"], div.m6QErb'))
      .filter((el) => el.scrollHeight > el.clientHeight + 30)
      .sort((a, b) => b.scrollHeight - a.scrollHeight);
    if (scrollers[0]) {
      return scrollers[0];
    }
  }

  return null;
}

function analyzeReviewQuality(snippets) {
  const positiveWords = [
    "professional", "friendly", "clean", "gentle", "helpful", "thorough", "efficient", "excellent",
    "amazing", "recommend", "kind", "caring", "painless", "comfortable", "great"
  ];
  const negativeWords = [
    "rude", "wait", "painful", "overpriced", "expensive", "unprofessional", "dirty", "bad", "terrible",
    "scam", "billing", "cancel", "late", "ignored", "rushed"
  ];
  const trustSignals = [
    "treatment", "explained", "procedure", "follow up", "staff", "hygienist", "dentist", "appointment",
    "insurance", "billing", "clinic", "service", "care"
  ];

  const combined = snippets.join(" ").toLowerCase();
  const pos = countKeywordHits(combined, positiveWords);
  const neg = countKeywordHits(combined, negativeWords);
  const trust = countKeywordHits(combined, trustSignals);

  const tokenCount = Math.max(1, combined.split(/\s+/).length);
  const sentimentRaw = clamp((pos - neg) / 12, -1, 1);
  const sentiment01 = (sentimentRaw + 1) / 2;
  const trust01 = clamp(trust / Math.max(6, snippets.length * 2), 0, 1);
  const coverage01 = clamp(snippets.length / 6, 0, 1);

  const overall = Number((sentiment01 * 0.6 + trust01 * 0.25 + coverage01 * 0.15).toFixed(6));

  return {
    snippetCount: snippets.length,
    tokenCount,
    sentiment: Number(sentiment01.toFixed(6)),
    trust: Number(trust01.toFixed(6)),
    overall
  };
}

function countKeywordHits(text, words) {
  return words.reduce((sum, word) => {
    const pattern = new RegExp(`\\b${escapeRegex(word)}\\b`, "g");
    const matches = text.match(pattern);
    return sum + (matches ? matches.length : 0);
  }, 0);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupeNonEmpty(items) {
  const seen = new Set();
  const out = [];
  items.forEach((item) => {
    const clean = String(item || "").trim();
    if (!clean) {
      return;
    }
    if (seen.has(clean)) {
      return;
    }
    seen.add(clean);
    out.push(clean);
  });
  return out;
}

function wilsonLowerBound(positiveRatio, total, z = 1.96) {
  if (total <= 0) {
    return 0;
  }

  const denominator = 1 + (z * z) / total;
  const center = positiveRatio + (z * z) / (2 * total);
  const margin = z * Math.sqrt((positiveRatio * (1 - positiveRatio) + (z * z) / (4 * total)) / total);
  return (center - margin) / denominator;
}

function getPlaceKey(url, fallback) {
  const idMatch = url.match(/!1s([^!]+)!/);
  if (idMatch?.[1]) {
    return idMatch[1];
  }
  return `${fallback}|${url}`;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(getter, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = getter();
    if (value) {
      return value;
    }
    await delay(200);
  }

  throw new Error("Timed out waiting for Google Maps elements. Make sure the left results panel is visible and you are on a search results page.");
}

async function waitForResultsContainer(timeoutMs) {
  return waitFor(() => getResultsContainer(), timeoutMs).catch(() => {
    throw new Error(buildResultsPanelError());
  });
}

function getResultsContainer() {
  const explicitFeed = document.querySelector('div[role="feed"]');
  if (explicitFeed) {
    return explicitFeed;
  }

  const main = document.querySelector('div[role="main"]') || document;
  const candidates = Array.from(main.querySelectorAll('div.m6QErb, div[jsaction*="scroll"], div[tabindex="-1"]'))
    .filter((el) => el.scrollHeight > el.clientHeight + 40)
    .map((el) => {
      const places = el.querySelectorAll('a[href*="/maps/place/"], a[href*="/place/"], a.hfpxzc').length;
      return { el, places };
    })
    .sort((a, b) => b.places - a.places);

  if (candidates[0]?.places > 0) {
    return candidates[0].el;
  }

  return null;
}

function buildResultsPanelError() {
  const searchBox = !!document.querySelector("input#searchboxinput");
  const placeAnchors = document.querySelectorAll('a[href*="/maps/place/"], a[href*="/place/"], a.hfpxzc').length;
  const feedCount = document.querySelectorAll('div[role="feed"]').length;
  const articleCount = document.querySelectorAll('div[role="article"], div.Nv2PK, div.THOPZb, div.UaQhfb').length;

  return `Could not find the Maps results panel. Diagnostics: searchBox=${searchBox}, feeds=${feedCount}, placeAnchors=${placeAnchors}, listingCards=${articleCount}. Open a search like "dentists in Surrey" so the left list is visible.`;
}
