"""A checked record: the record itself and its parsed numbers."""


class Row:
    __slots__ = ("record", "qty", "price", "revenue", "index")

    def __init__(self, record, qty, price, index):
        self.record = record
        self.qty = qty
        self.price = price
        self.revenue = price * qty
        self.index = index

    def __getitem__(self, name):
        return self.record[name]
