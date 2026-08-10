# Maps Dentist Top 10 Finder (Chrome Extension)

This extension analyzes Google Maps listings and returns the top 10 dentists based on a ranking score that balances:

- Star rating
- Number of reviews

## What it does

1. Opens/uses your current Google Maps tab
2. Runs a search query (default: `Dentists in Surrey BC and nearby towns`)
3. Scrolls and collects listing data from the left results panel
4. Computes a weighted ranking score (Wilson lower bound)
5. Shows top 10 results in the extension popup
6. Lets you export the top 10 to CSV

## Install (Unpacked)

1. Open Chrome and go to `chrome://extensions/`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this folder:
   - `cascade-extension/maps-dentist-top10`

## How to use

1. Open `https://www.google.com/maps`
2. Click the extension icon
3. Adjust query/min reviews/max scan if needed
4. Click **Find Top 10**
5. Optionally click **Export CSV**

## Notes

- Google Maps UI classes may change over time; if Google updates layout, selectors might need a small update.
- Rankings are heuristic-based and not a medical recommendation.
