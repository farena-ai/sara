"""How numbers are shown (docs/CONTRACT.md, "Columns")."""

from decimal import ROUND_HALF_EVEN, ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")
TENTH = Decimal("0.1")
HUNDRED = Decimal(100)


def fmt_money(value):
    """Two decimals, half to even; never "-0.00"."""
    shown = value.quantize(CENT, rounding=ROUND_HALF_EVEN)
    if shown == 0:
        shown = abs(shown)
    return str(shown)


def fmt_percent(part, whole):
    """part / whole as a percentage with one decimal, half up; "-" when whole is 0."""
    if whole == 0:
        return "-"
    shown = (part * HUNDRED / whole).quantize(TENTH, rounding=ROUND_HALF_UP)
    if shown == 0:
        shown = abs(shown)
    return str(shown)


def fmt_ratio(part, whole):
    """part / whole as money; "-" when whole is 0."""
    if whole == 0:
        return "-"
    return fmt_money(part / Decimal(whole))


def fmt_median(value):
    """A median of whole numbers: "3", "3.5", "-2.5"; "-" when there is none."""
    if value is None:
        return "-"
    return str(value)


def fmt_int(value):
    return str(value)
