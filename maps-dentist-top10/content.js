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

  await ensureSearch(query, skipSearchInput);
  await delay(1500);

  const listings = await collectListings(maxResults);
  const ranked = rankListings(listings, minReviews).slice(0, 10);

  return {
    query,
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
