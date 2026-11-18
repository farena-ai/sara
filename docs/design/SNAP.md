# V2.5 Snap and file (D4)

ROADMAP_V V2.5 · audit row D4 in [VAUDIT.md](VAUDIT.md). One page.

## What existed (reused, not rebuilt)

- `src/phone-helper.ts` + `web/phone-helper.js` (EC24): **one** camera picture that *she* asks for,
  approved on the phone each time. Right for "show me the fridge", wrong for scanning 8 pages.
- `src/library/*`: uploads, `lib.add`, the PDF page-by-page reader (`bigread.ts`) that sends every
  scanned page to the picture model (`readPageImage`), local first, a cloud model only after the
  owner says yes (`ocr-approval`), plus de-duplication by hash (`findKept`).
- `src/documents/images.ts`: JPEG/PNG → PDF image objects (`measure`, `pdfImage`).
- `src/facts.ts` (`scanDocs`, `extractFacts`, `suggestions`, `accept`): dates from any ready Library
  document with reminders at `DAYS_BEFORE`. Owned by V2.1 this wave; **not edited**.
- `src/picture-reader.ts`: which model may see a picture in a chat. Not needed here: Library
  reading already picks the "Looking at pictures" model.

## What was built

| Piece | File | Notes |
|---|---|---|
| Page math | `web/scan-math.js` | No DOM, tested in Node: Otsu threshold → bright region round the middle → four corners (extreme points), perspective warp (homography + bilinear), text-line tilt when the page fills the photo (projection profile, ±15°), quarter turns, light levels. |
| Scan view | `web/scan.js`, `#lib-scan` in `web/index.html` | Library → **Scan pages…** (and `#view=scan`). Live camera (`getUserMedia`, back camera; works in the Android app's web view, phone browsers over https and webcams) or **Add photos** (phone offers camera and gallery). Each page: auto crop + straighten (switch, remembered on the device), drag the four corners (or keys 1-4 + arrows), turn, move earlier, remove. Pages are sent as JPEG at most 2000 px. |
| One PDF | `src/scan.ts` `scanPdf` | A page per picture at the picture's shape, no dates inside (same pages = same file = kept once). |
| Keep + read | `src/scan.ts` `takeScan`, `POST /api/library/scan` | Checks type + bytes (JPEG/PNG only, 3 MB a page, 30 pages), `lib.add({origin:'scan', keep:true})`, `libraryNudge`. The normal reader does the rest. Name: "Scan 2026-11-18 09.00.pdf" in the owner's time zone, or the name given. |
| Result | `GET /api/library/scan/:id`, `scanView` | Reading status (the Library's own `jobText`), the read text per page, the dates `facts.ts` suggests (Remind me / Not needed through the existing `/api/facts/suggestions/:n/*`), other facts. A cloud-reading question sends the person to the Library's existing card. |

Wiring: `src/routes/library.ts` one line (`b === 'scan'`), `DocOrigin` gains `'scan'`, `web/app.js`
import + `VIEWS.scan` + `initScan()`, `web/library.js` hides the view on Home.

## How V2.1 / V2.2 pick it up

Nothing to wire: a scan is an ordinary kept, ready Library document. `facts.ts` reads its passages
(page numbers from the reader) like for any upload, so Renewals (V2.1) and Purchases (V2.2, receipt
photos) see its dates. A V2.2 "photo a receipt" button can call `openScan()` and filter by
`doc.origin === 'scan'` if it wants only scans.

## Limits / later

- No text layer inside the PDF (the read text lives in the Library index; search works). A later
  step could write it back as invisible text for other PDF readers.
- Edge finding needs paper on a darker surface; on a light table it keeps the frame and only
  straightens text lines. Corners can always be fixed by hand.
- Heic photos open only where the browser decodes them (Safari); others say so.
