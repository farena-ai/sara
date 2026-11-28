# Data

Three tables, defined in `src/db.js`.

## customers

| column | type | notes |
|---|---|---|
| `id` | int | key |
| `name` | text | display name, e.g. "Harbor Books" |
| `email` | text | unique |
| `region` | text, nullable | `north`, `south`, ... or null when not known |
| `since` | date | first order date |

## orders

| column | type | notes |
|---|---|---|
| `id` | int | key; ids are assigned in the order orders are entered, which is not always date order |
| `customerId` | int | the customer's `id`; old orders may point at a customer who was deleted |
| `date` | date | `YYYY-MM-DD` |
| `total` | int | cents |
| `status` | text | one of `open`, `paid`, `closed`, `cancelled` |
| `note` | text, nullable | free text |

## closings

One row per closed month.

| column | type | notes |
|---|---|---|
| `month` | text | key, `YYYY-MM` |
| `orders` | int | how many orders the closing changed |
| `revenue` | int | cents; the sum of the totals of those orders |
