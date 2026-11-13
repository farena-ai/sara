# Product finder fixtures (E2)

Fetched live once on 2026-11-13 and trimmed; tests never use the network.

- `nominatim-kansas-city.json`: Nominatim search for "Kansas City, MO" (trimmed fields).
- `overpass-kansas-city.json`: Overpass answer around downtown Kansas City, 10 of 80 elements kept; phone numbers replaced with invented 555 numbers.
- `walmart-search-next-data.html`: walmart.com search page (plain fetch), its `__NEXT_DATA__` cut to 4 items and the fields the reader uses.
- `harborfreight-search-itemlist.html`: harborfreight.com search page's JSON-LD ItemList (3 of 8 items).
- `duckduckgo-results.html`: html.duckduckgo.com results (3 organic results kept).
- `walmart-robot-or-human.html`, `cloudflare-just-a-moment.html`, `homedepot-error-403.html`, `duckduckgo-anomaly.html`: the real bot-check / refusal pages these sites showed (headless Chrome or plain fetch), markup trimmed.
- `amazon-product.html`: an amazon.com product page in her browser (headless Edge), cut to the title, availability and price box.
- `amazon-search.html`: the structure of amazon.com's search results (headless Chrome) with the live titles and prices, rebuilt small; one sponsored result added.
- `product-jsonld.html`, `product-jsonld-graph-oos.html`: schema.org Product/Offer JSON-LD in the shape retailers publish, with the live Walmart listing's values (the big retailers' product pages refused automated access on the day, so no live JSON-LD Product block could be saved).
