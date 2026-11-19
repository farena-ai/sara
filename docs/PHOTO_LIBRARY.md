# Photo library search

Sara can search one folder of your photos on the computer she runs on: by place, by the words that
are written in a photo, by who is in it and by date. Everything stays on that computer.

## Set it up

1. Settings → Skills & tools → Library → **Photo folder**.
2. Type the full path of the folder (sub-folders count too) and press **Use this folder**.
3. She looks through it at once and again every few hours. **Look through it now** does it on demand.

Search in **Our moments** → *Your photo folder*: type a place ("Lisbon"), a word written in a photo
("total 42.50", a shop name), a person you named, a month or a year ("May 2024"). Every word must
match. Before you search it shows the newest 12.

## What she knows about each photo

| What | Where it comes from |
| --- | --- |
| Date | The photo's own EXIF date; else a date in the file name; else the file's date |
| Place and country | The GPS position saved in the photo, matched against a built-in list of cities (no map service) |
| Caption, writing in the photo, a few things in it | A picture model **on this computer** (Settings → Models & usage → Which model does what → Looking at pictures) |
| People | Names you type under *Who is in it* on a photo |
| Your own places | *Name this place* on a photo with a position: every photo within ~500 m takes that name ("Home") |

With no picture model on this computer, photos are still found by place, date, file name and people.
A cloud model is never sent a photo, even if it is your Looking at pictures model.

## Made-for-you albums

Shown above the results: **trips** (3 or more photos in one country within a few days, not at a
place you named; named after the place most of them were taken), one album per **person** you named,
and **Photos with writing** (receipts, screenshots, signs).

## Privacy

- Owner only: household members and the demo can't use it (it reads the server's disk).
- The index is `<data>/photo-library/photos.db`. Your photos are never moved, changed, copied or sent.
- **Forget the index** deletes what Sara wrote about the photos; the photos stay.
- There is no face recognition: names are only the ones you type.
