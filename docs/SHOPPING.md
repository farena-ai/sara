# Find it near me (shopping assistant)

Ask Sara where to get something ("where can I buy WD-40 12 oz near me?", "cheapest AA batteries
24 pack", "is the Ryobi drill in stock at Home Depot?") and she checks the stores near you and the
big online retailers, then gives you a short ranked list. She never buys anything: checkout and
payment always stay with you. She can open the page for you.

## What she checks

1. **Stores near you** from OpenStreetMap (free, no key): hardware and home improvement,
   electronics, supermarkets, department stores, pharmacies, auto parts, sporting goods, variety
   stores and the big chains (Home Depot, Lowe's, Walmart, Target, Best Buy, Walgreens, CVS,
   AutoZone and more) within 10 miles by default (up to 25), with distance, address, opening hours
   and phone when they are mapped. "Near you" is the place saved in Settings → Morning briefing,
   or a city, address or ZIP code you name.
2. **The product**: a web search pins it down (model numbers, the retailers' own product pages).
   With no search set up she uses DuckDuckGo's free results page, or skips this step.
3. **The retailers' own pages**, one at a time, at most 8 pages per search, in her own browser on
   the server (or her plain page reader when the server has no browser). She reads the
   structured product data stores publish (schema.org price, currency and availability), a search
   page's own product list, or Amazon's search results.
4. **The answer**: in stock first, then the lower total (shipping added when the page shows it),
   then the nearer store. Each line has the store, price, stock, pickup or delivery when shown,
   the nearest store's distance, the link, the time it was checked and where the facts came from.

## When a site blocks her

Many big retailers show a bot check ("Robot or human?", "Just a moment…") or refuse automated
visitors. Sara never tries to get around that: the store goes on the **Couldn't check** list with
the reason, and she offers to check it in your own browser on your computer (when the Sara desktop
app is connected, with your approval there) or gives you the nearby store's phone number. A price
seen only in a search result is labelled "from search results, may be out of date". Store stock
for a specific store is only reported when the page says so.

## Watching a product

"Tell me when it's back in stock" or "…when it's under $15": she adds a **product watch**
(`product_watch_add`) for the product page: back in stock, price below a number, or any change.
Each watch is checked at most every 6 hours on her reminder schedule, with the same page reading.
You get one chat message and one notification per change (it fires again only after the item went
out of stock again, or the price went back up). A page that blocks her four times in a row pauses
the watch and she says so. Ask "list my product watches" or "stop product watch 3".

## Limits and privacy

- Free sources only: OpenStreetMap (Overpass, Nominatim; one request a second, cached a day for
  stores and a month for places) and the stores' public pages. No accounts, no sign-ins, no carts.
- Not in private chats, not in private local mode (both keep everything on this computer), and only
  in the owner's own space (household members don't get these tools).
- Opening hours and stores come from volunteers' map data and can be out of date.

Tools: `find_product`, `stores_near`, `product_watch_add`, `product_watch_list`,
`product_watch_remove`. Code: `src/shopping/` (places, extract, retailers, find, watch) and
`src/tools/shopping.ts`.
