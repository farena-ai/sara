"""The best-selling products of a list of rows: by revenue, highest first; equal revenue by product name."""


def product_revenue(rows):
    totals = []  # [product, revenue], in order of first appearance
    for row in rows:
        product = row["product"]
        for entry in totals:
            if entry[0] == product:
                entry[1] += row.revenue
                break
        else:
            totals.append([product, row.revenue])
    return totals


def top_products(rows, n):
    totals = product_revenue(rows)
    picked = []
    while totals and len(picked) < n:
        best = 0
        for i in range(1, len(totals)):
            name, value = totals[i]
            best_name, best_value = totals[best]
            if value > best_value or (value == best_value and name < best_name):
                best = i
        picked.append(tuple(totals.pop(best)))
    return picked
