# Examples

Small stores before and after one step, to go with [MIGRATIONS.md](MIGRATIONS.md). Each block is a whole
file; the outputs are exactly what a migration writes (canonical JSON, keys sorted). Where an example and
MIGRATIONS.md seem to disagree, MIGRATIONS.md is right and this file is a bug.

## v1 -> v2: customers

Renames, email clean-up, the tier default, and the three kinds of quarantine (a line that is not an object, a failed check, a duplicate id).

Before, `records/customers.ndjson` (schema 1):

```
{"id":"c1","name":"Ada Lovelace","email":" ADA@Example.com ","created":"2024-01-05"}
{"id":"c2","name":"Grace Hopper","email":"grace@navy.mil","created":"2024-02-10","tier":"gold"}
{"id":"c3","name":"Nobody","email":"nobody","created":"2024-02-11"}
{"id":"c1","name":"Ada Again","email":"ada2@example.com","created":"2024-03-01"}
{"name":"No Id","email":"x@y.z","created":"2024-01-01"}
```

Before, `records/orders.ndjson` (schema 1):

```
```

After, `records/customers.ndjson` (schema 2):

```
{"created":"2024-01-05","email":"ada@example.com","full_name":"Ada Lovelace","id":"c1","tier":"basic"}
{"created":"2024-02-10","email":"grace@navy.mil","full_name":"Grace Hopper","id":"c2","tier":"gold"}
```

After, `records/orders.ndjson` (schema 2):

```
(empty file)
```

After, `quarantine/customers.ndjson` (schema 2):

```
{"reason":"bad email","record":{"created":"2024-02-11","email":"nobody","id":"c3","name":"Nobody"},"step":"v1->v2"}
{"reason":"missing id","record":{"created":"2024-01-01","email":"x@y.z","name":"No Id"},"step":"v1->v2"}
{"reason":"duplicate id","record":{"created":"2024-03-01","email":"ada2@example.com","id":"c1","name":"Ada Again"},"step":"v1->v2"}
```

## v1 -> v2: orders

Dollar strings become cents, pounds become grams, item prices become cents.

Before, `records/customers.ndjson` (schema 1):

```
```

Before, `records/orders.ndjson` (schema 1):

```
{"id":"o1","customer":"c1","total":"1,234.50","weight_lb":2.5,"status":"paid","items":[{"sku":"desk","qty":1,"price":"1,200"},{"sku":"lamp","qty":2,"price":"17.25"}]}
{"id":"o2","customer":"c1","total":"3.5","weight_lb":0,"status":"new","items":[]}
{"id":"o3","customer":"c1","total":"$3","weight_lb":1,"status":"new","items":[]}
{"id":"o4","customer":"c1","total":"3.00","weight_lb":1,"status":"new","items":[{"sku":"x","qty":1,"price":"free"}]}
```

After, `records/customers.ndjson` (schema 2):

```
(empty file)
```

After, `records/orders.ndjson` (schema 2):

```
{"customer":"c1","id":"o1","items":[{"price_cents":120000,"qty":1,"sku":"desk"},{"price_cents":1725,"qty":2,"sku":"lamp"}],"status":"paid","total_cents":123450,"weight_g":1134}
{"customer":"c1","id":"o2","items":[],"status":"new","total_cents":350,"weight_g":0}
```

After, `quarantine/orders.ndjson` (schema 2):

```
{"reason":"bad total","record":{"customer":"c1","id":"o3","items":[],"status":"new","total":"$3","weight_lb":1},"step":"v1->v2"}
{"reason":"bad item price","record":{"customer":"c1","id":"o4","items":[{"price":"free","qty":1,"sku":"x"}],"status":"new","total":"3.00","weight_lb":1},"step":"v1->v2"}
```

## v2 -> v3: names, phones and merging

Two customers share an email: the first survives and takes the phone it lacked from the second. The order of the second customer now points to the survivor; the order of an unknown customer is quarantined.

Before, `records/customers.ndjson` (schema 2):

```
{"id":"k1","full_name":"  Mary   Ann  Evans ","email":"mae@lit.uk","created":"2024-05-01","tier":"basic"}
{"id":"k2","full_name":"George Eliot","email":"mae@lit.uk","created":"2024-05-02","tier":"gold","phone":"212.555.0123"}
{"id":"k3","full_name":"Plato","email":"plato@academy.gr","created":"2024-05-03","tier":"basic","phone":""}
{"id":"k4","full_name":"Short Number","email":"sn@x.io","created":"2024-05-04","tier":"basic","phone":"555-0199"}
```

Before, `records/orders.ndjson` (schema 2):

```
{"id":"p1","customer":"k2","total_cents":1500,"weight_g":1250,"status":"paid","items":[{"sku":"book","qty":3,"price_cents":500}]}
{"id":"p2","customer":"k3","total_cents":700,"weight_g":30,"status":"new","items":[{"sku":"pen","qty":2,"price_cents":200},{"sku":"ink","qty":1,"price_cents":300}]}
{"id":"p3","customer":"k4","total_cents":100,"weight_g":1,"status":"new","items":[]}
```

After, `records/customers.ndjson` (schema 3):

```
{"created":"2024-05-01","email":"mae@lit.uk","first_name":"Mary Ann","id":"k1","last_name":"Evans","merged_ids":["k2"],"phone":"+12125550123","tier":"basic"}
{"created":"2024-05-03","email":"plato@academy.gr","first_name":"Plato","id":"k3","last_name":"","tier":"basic"}
```

After, `records/orders.ndjson` (schema 3):

```
{"customer":"k1","id":"p1","line_count":1,"status":"paid","total_cents":1500,"weight_g":1250}
{"customer":"k3","id":"p2","line_count":2,"status":"new","total_cents":700,"weight_g":30}
```

After, `records/order_lines.ndjson` (schema 3):

```
{"id":"p1#1","order":"p1","price_cents":500,"qty":3,"sku":"book"}
{"id":"p2#1","order":"p2","price_cents":200,"qty":2,"sku":"pen"}
{"id":"p2#2","order":"p2","price_cents":300,"qty":1,"sku":"ink"}
```

After, `quarantine/customers.ndjson` (schema 3):

```
{"reason":"bad phone","record":{"created":"2024-05-04","email":"sn@x.io","full_name":"Short Number","id":"k4","phone":"555-0199","tier":"basic"},"step":"v2->v3"}
```

After, `quarantine/orders.ndjson` (schema 3):

```
{"reason":"unknown customer","record":{"customer":"k4","id":"p3","items":[],"status":"new","total_cents":100,"weight_g":1},"step":"v2->v3"}
```

## v3 -> v4

Dates, defaults, kilograms and line totals. Order q2 claims 10.00 but its lines add up to 8.00: the order and its line are quarantined.

Before, `records/customers.ndjson` (schema 3):

```
{"id":"k1","first_name":"Mary Ann","last_name":"Evans","email":"mae@lit.uk","created":"2024-05-01","tier":"basic"}
{"id":"k2","first_name":"Plato","last_name":"","email":"plato@academy.gr","created":"5 May 2024","tier":"basic"}
```

Before, `records/orders.ndjson` (schema 3):

```
{"id":"q1","customer":"k1","total_cents":1500,"weight_g":1250,"status":"paid","line_count":1}
{"id":"q2","customer":"k1","total_cents":1000,"weight_g":250,"status":"paid","line_count":1,"currency":"EUR"}
```

Before, `records/order_lines.ndjson` (schema 3):

```
{"id":"q1#1","order":"q1","sku":"book","qty":3,"price_cents":500}
{"id":"q2#1","order":"q2","sku":"cup","qty":2,"price_cents":400}
```

After, `records/customers.ndjson` (schema 4):

```
{"created_at":"2024-05-01T00:00:00Z","email":"mae@lit.uk","first_name":"Mary Ann","id":"k1","last_name":"Evans","marketing_opt_in":false,"tier":"basic"}
```

After, `records/orders.ndjson` (schema 4):

```
{"currency":"USD","customer":"k1","id":"q1","line_count":1,"status":"paid","total_cents":1500,"weight_kg":1.25}
```

After, `records/order_lines.ndjson` (schema 4):

```
{"id":"q1#1","line_total_cents":1500,"order":"q1","price_cents":500,"qty":3,"sku":"book"}
```

After, `quarantine/customers.ndjson` (schema 4):

```
{"reason":"bad date","record":{"created":"5 May 2024","email":"plato@academy.gr","first_name":"Plato","id":"k2","last_name":"","tier":"basic"},"step":"v3->v4"}
```

After, `quarantine/orders.ndjson` (schema 4):

```
{"reason":"total mismatch","record":{"currency":"EUR","customer":"k1","id":"q2","line_count":1,"status":"paid","total_cents":1000,"weight_g":250},"step":"v3->v4"}
```

After, `quarantine/order_lines.ndjson` (schema 4):

```
{"reason":"order quarantined","record":{"id":"q2#1","order":"q2","price_cents":400,"qty":2,"sku":"cup"},"step":"v3->v4"}
```
