// content.js
// Injected into Facebook Marketplace pages.
// Handles two modes:
//   1. SEARCH page  – scroll to collect listing URLs, then kick off scanning
//   2. LISTING page – extract description + location, score it, report back

const SCROLL_ROUNDS = 8;
const SCROLL_DELAY = 1800;

// Proximity score tiers (higher = closer to school)
const SCHOOL_PATTERNS = [
  { score: 100, patterns: [/in front of.{0,30}(elementary|school)/i, /across (from|the street from).{0,30}(elementary|school)/i, /facing.{0,30}(elementary|school)/i, /directly.{0,20}(opposite|across).{0,20}(elementary|school)/i] },
  { score: 80,  patterns: [/next to.{0,30}(elementary|school)/i, /beside.{0,30}(elementary|school)/i, /adjacent to.{0,30}(elementary|school)/i, /backs onto.{0,30}(elementary|school)/i] },
  { score: 60,  patterns: [/steps (from|to|away).{0,30}(elementary|school)/i, /steps from school/i, /steps to school/i, /steps away from school/i] },
  { score: 40,  patterns: [/walking distance.{0,30}(elementary|school)/i, /short walk.{0,30}(elementary|school)/i, /close to.{0,30}(elementary|school)/i, /near.{0,30}(elementary|school)/i] },
  { score: 20,  patterns: [/(elementary|school) nearby/i, /school zone/i, /school across/i, /school next/i, /school behind/i, /school in front/i] },
  { score: 10,  patterns: [/elementary/i, /\bschool\b/i] }
];

function scoreDescription(text) {
  for (const tier of SCHOOL_PATTERNS) {
    for (const pattern of tier.patterns) {
      if (pattern.test(text)) {
        return { score: tier.score, matchedText: extractSnippet(text, pattern) };
      }
    }
  }
  return null;
}

function extractSnippet(text, pattern) {
  const match = text.match(pattern);
  if (!match) return '';
  const idx = match.index;
  return '...' + text.substring(Math.max(0, idx - 40), idx + 80).trim() + '...';
}

// ── LISTING PAGE MODE ──────────────────────────────────────────────────────────
function scanListingPage() {
  // Description: FB Marketplace uses a div with a long text block
  const descSelectors = [
    '[data-testid="marketplace-pdp-description"]',
    'div[class*="xz9dl7a"]',
    'div[class*="x1iorvi4"]',
    'span[class*="x193iq5w"]'
  ];

  let description = '';
  for (const sel of descSelectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText && el.innerText.length > 30) {
      description = el.innerText;
      break;
    }
  }

  // Fallback: grab all visible text from the main content area
  if (!description) {
    const main = document.querySelector('main') || document.querySelector('[role="main"]');
    if (main) description = main.innerText;
  }

  // Price
  const priceEl = document.querySelector('span[class*="x193iq5w"]');
  let price = '';
  document.querySelectorAll('span').forEach(el => {
    if (/CA\$[\d,]+/.test(el.innerText) && !price) price = el.innerText.trim();
  });

  // Title
  const titleEl = document.querySelector('h1');
  const title = titleEl ? titleEl.innerText.trim() : document.title;

  // Location
  let location = '';
  document.querySelectorAll('span, div').forEach(el => {
    if (/\b(BC|British Columbia|Surrey|Vancouver|Burnaby|Richmond|Coquitlam|Langley|Abbotsford|Delta|New Westminster)\b/.test(el.innerText) && el.innerText.length < 60 && !location) {
      location = el.innerText.trim();
    }
  });

  const result = scoreDescription(description);

  return {
    url: window.location.href,
    title,
    price,
    location,
    score: result ? result.score : 0,
    snippet: result ? result.matchedText : '',
    matched: !!result
  };
}

// ── SEARCH PAGE MODE ───────────────────────────────────────────────────────────
function collectListingUrls() {
  const links = new Set();
  document.querySelectorAll('a[href*="/marketplace/item/"]').forEach(a => {
    const url = a.href.split('?')[0];
    if (url) links.add(url);
  });
  return [...links];
}

async function scrollAndCollect(limit) {
  const allUrls = new Set();
  const maxRounds = limit > 0 ? Math.ceil(limit / 12) + 4 : 30; // ~12 listings per scroll

  for (let i = 0; i < maxRounds; i++) {
    collectListingUrls().forEach(u => allUrls.add(u));
    if (limit > 0 && allUrls.size >= limit) break;
    window.scrollBy(0, window.innerHeight * 2);
    await new Promise(r => setTimeout(r, SCROLL_DELAY));
  }
  collectListingUrls().forEach(u => allUrls.add(u));

  return [...allUrls];
}

// ── MESSAGE LISTENER ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'COLLECT_URLS') {
    scrollAndCollect(msg.limit || 0).then(urls => sendResponse({ urls }));
    return true;
  }

  if (msg.action === 'SCAN_LISTING') {
    const data = scanListingPage();
    sendResponse(data);
    return true;
  }
});
