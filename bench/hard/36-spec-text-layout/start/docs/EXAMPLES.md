# Worked examples

Each example shows the input and the exact output of a correct 2.0 implementation. The rules
used are named after each one. Lines in the outputs have no trailing spaces unless the example
says so.

## 1. Wrapping (R4, R7 to R10)

```js
wrapText('the  quick\tbrown fox', 9)            // ["the quick", "brown fox"]
wrapText('see https://example.com/a/b now', 10) // ["see", "https://ex", "ample.com/", "a/b now"]
wrapText('漢字かな交じり', 5)                    // ["漢字", "かな", "交じ", "り"]
wrapText('one\r\n\r\ntwo', 8)                    // ["one", "", "two"]
```

In the second call the URL is wider than 10, so "see" is finished first (R10); the last piece
"a/b" then takes "now" under R9. In the third, every ideograph is 2 wide: two of them fill 4 of
the 5 columns and a third would need 6.

## 2. Truncation (R12 to R14)

```js
truncateText('Grand total for the year', 10)  // "Grand tot…"
truncateText('日本語のテキスト', 7)            // "日本語…"   (width 7: 6 + 1)
truncateText('ab   cd  ef', 6)                // "ab cd…"
truncateText('abcdef', 2, '...')              // ".."
```

The flattened text of the third call is "ab cd ef" (width 8). In the last call the ellipsis is
wider than the room, so R14 applies.

## 3. Flex shares (R17, R21, R22)

```js
columnWidths({ width: 41, columns: [{ width: 6 }, { flex: 1 }, { flex: 2 }, { flex: 2 }], rows: [] })
// [6, 4, 9, 9]
```

Overhead 3 × 4 + 1 = 13, so B = 28 and R = 28 − 6 = 22, K = 5. The shares are 4, 8 and 8 with
remainders 2, 4 and 4; the two units left go to the two columns with remainder 4.

```js
columnWidths({ width: 41, columns: [{ width: 6 }, { flex: 1, min: 8 }, { flex: 2, max: 7 }, { flex: 2 }], rows: [] })
// [6, 8, 7, 7]
```

Round 1: shares 4, 9, 9; the third column is above its max and is settled at 7 (R = 15).
Round 2: shares 5 and 10; the second column is below its min and is settled at 8 (R = 7).
Round 3: the last column takes 7.

## 4. Shrinking (R19, R23)

```js
columnWidths({
  width: 30,
  columns: [{ header: 'Name' }, { header: 'Description' }, { width: 5 }],
  rows: [['Alexandria', 'the longest description here', 'x']],
})
// [8, 7, 5]
```

B = 30 − 10 = 20. The natural widths are 10 and 28 and the fixed column is 5: 23 too many. The
description loses 18 to reach 10; from then on the two are equally wide every other step and the
rightmost loses first: 10/9, 9/9, 9/8, 8/8, 8/7.

## 5. Decimal alignment (R26 to R28)

```js
renderTable({ columns: [{ header: 'Amount', align: 'decimal' }], rows: [['12.5'], ['-3'], ['100.25'], ['n/a'], [7]] })
```

```
+--------+
| Amount |
+========+
|  12.5  |
|  -3    |
| 100.25 |
|    n/a |
|   7    |
+--------+
```

I = 3, F = 2, D = 6. The number 7 is shown as "7" and is numeric; "n/a" is not and is
right-aligned. (The lines inside this table have no trailing spaces because they end with "|".)

## 6. Spans and vertical alignment (R30, R31)

```js
renderTable({
  columns: [
    { header: 'Q', width: 3 },
    { header: 'Item', width: 6, valign: 'middle' },
    { header: 'Price', width: 6, align: 'right', valign: 'bottom' },
  ],
  rows: [
    ['1', 'Large green apples', '0.80'],
    [{ text: 'Subtotal for the order', span: 2, align: 'right' }, '0.80'],
  ],
})
```

```
+-----+--------+--------+
| Q   | Item   |  Price |
+=====+========+========+
| 1   | Large  |        |
|     | green  |        |
|     | apples |   0.80 |
| Subtotal for |        |
|    the order |   0.80 |
+-----+--------+--------+
```

The spanning cell is 3 + 3 + 6 = 12 wide.

## 7. The "none" style (R33, R34)

Spaces are shown as "·" here.

```js
renderTable({
  style: 'none',
  rowRules: true,
  columns: [{ header: 'Key' }, { header: 'Value', align: 'center', width: 7 }],
  rows: [['a', 'x'], ['bb', 'yy'], ['c', '']],
})
```

```
Key···Value
---··-------
a·······x

bb·····yy

c
```

## 8. Pages (R36 to R38)

```js
renderTable({
  pageHeight: 7,
  title: 'Log',
  columns: [{ header: 'N', width: 2 }, { header: 'Message', width: 12 }],
  rows: [['1', 'started'], ['2', 'a long message that needs several lines'], ['3', 'done']],
})
```

The result has three pages (shown one after the other; each is separated from the next by "\f"):

```
         Log

+----+--------------+
| N  | Message      |
+====+==============+
| 1  | started      |
+----+--------------+
```

```
+----+--------------+
| N  | Message      |
+====+==============+
| 2  | a long       |
|    | message that |
|    | needs        |
+----+--------------+
```

```
+----+--------------+
| N  | Message      |
+====+==============+
|    | several      |
|    | lines        |
| 3  | done         |
+----+--------------+
```

Page 1 has room for one body line (7 minus 2 title lines and 4 frame lines). The second row is 5
lines tall; it does not fit on page 1, and on the empty page 2 (room 3) it is split.
