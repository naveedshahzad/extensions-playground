# School-Facing Rental Finder (Chrome Extension)

Scans Facebook Marketplace rental listings and surfaces units that are in front of, next to, or near elementary schools. Results are ranked by proximity score.

## How it ranks

| Badge | Score | Triggered by |
|-------|-------|--------------|
| 🏫 In Front of School | 100 | "in front of school", "across from school", "facing school" |
| 🏫 Next to School | 80 | "next to school", "beside school", "adjacent to school" |
| 🚶 Steps from School | 60 | "steps from school", "steps away from school" |
| 🗺 Near School | 40 | "walking distance to school", "close to school", "near school" |
| 📍 School Mentioned | 20 | "school zone", "school nearby", "school across" |
| 📝 School in Description | 10 | any mention of "elementary" or "school" |

## Install

1. Open Chrome and go to `chrome://extensions/`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this folder: `extensions-playground/maps-school-rental`

## How to use

1. Open `https://www.facebook.com/marketplace/` and search for rentals in your area
2. Click the extension icon
3. Click **Scan Listings**
4. The extension will scroll the page to collect listings, then visit each one and scan the description
5. Results appear ranked from closest to farthest from a school
6. Click any card to open the listing
7. Click **Export CSV** to save results

## Notes

- Scanning opens each listing in a background tab and closes it after reading. This takes time depending on how many listings are found.
- The extension relies entirely on what sellers write in their descriptions. If a seller does not mention a school, the listing will not appear even if it is physically close to one.
- Works best when sellers include location details in the description.
