"""Distinct customers: different non-empty customer values, compared exactly as they are."""


def distinct_customers(rows):
    seen = []
    for row in rows:
        customer = row["customer"]
        if customer != "" and customer not in seen:
            seen.append(customer)
    return len(seen)
