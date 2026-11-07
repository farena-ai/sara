# Weather Cards

A small static site generator for city weather cards.

## Prerequisites

- Node 22 or newer
- The card data in `data/cities.json`
- The template `templates/card.html`

## Build

```sh
node scripts/build.mjs
```

The npm script does the same:

```sh
npm run build
```

## Test

```sh
node --test test/build.test.mjs
```
