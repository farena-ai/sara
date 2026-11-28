# Record shapes per schema

What the records of each collection look like at each schema, for records that were kept. Fields not
listed here are carried along unchanged by every step (an order's `status`, say, or any extra key an older
tool wrote). How each field gets from one schema to the next is in [MIGRATIONS.md](MIGRATIONS.md).

## Schema 1 (exports of the old shop system)

customers

| field | type | notes |
|---|---|---|
| `id` | string | unique within the file (in theory) |
| `name` | string | the whole name |
| `email` | string | any case, sometimes with spaces around it |
| `created` | string | `YYYY-MM-DD` |
| `phone` | string | optional, any punctuation |
| `tier` | string | optional |

orders

| field | type | notes |
|---|---|---|
| `id` | string | |
| `customer` | string | a customer id |
| `total` | string | dollars: `"12.50"`, `"0.5"`, `"1,234.50"` |
| `weight_lb` | number | pounds |
| `items` | array | `{ sku, qty, price }`, `price` in dollars like `total` |
| `currency` | string | optional |

## Schema 2

customers: `id`, `full_name`, `email` (trimmed, lower case), `created`, `phone` (as in schema 1), `tier`
(always present).

orders: `id`, `customer`, `total_cents` (whole cents), `weight_g` (whole grams), `items` (`{ sku, qty,
price_cents }`), `currency` (optional).

## Schema 3

customers: `id`, `first_name`, `last_name`, `email` (unique: customers with the same email were merged),
`created`, `phone` (`+1` and ten digits, or absent), `tier`, `merged_ids` (only on merged customers).

orders: `id`, `customer` (always a customer of the store, at the time of the step), `total_cents`,
`weight_g`, `line_count`, `currency` (optional).

order_lines (new): `id` (`<order>#<n>`), `order`, `sku`, `qty`, `price_cents`, plus any other item field.

## Schema 4

customers: `id`, `first_name`, `last_name`, `email`, `created_at` (`YYYY-MM-DDT00:00:00Z`), `phone`,
`tier`, `marketing_opt_in` (always present), `merged_ids`.

orders: `id`, `customer`, `total_cents` (equal to the sum of its lines), `weight_kg` (a number of
kilograms, `weight_g / 1000`), `line_count`, `currency` (always present, `"USD"` unless it said otherwise).

order_lines: as in schema 3, plus `line_total_cents` (`qty × price_cents`); every line belongs to an order
of the store.

## Quarantine

Quarantine entries keep the record exactly as the step read it, so an entry from `v2->v3` holds a schema-2
record, and a line that was not JSON is kept as its text. Nothing ever takes records out of quarantine
automatically.
