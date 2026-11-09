export const parameters = {
  "type": "object",
  "properties": {
    "start": {
      "type": "string",
      "minLength": 1,
      "maxLength": 10,
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    },
    "end": {
      "type": "string",
      "minLength": 1,
      "maxLength": 10,
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    },
    "currency": {
      "type": "string",
      "minLength": 1,
      "maxLength": 3,
      "pattern": "\\S",
      "enum": [
        "USD",
        "EUR",
        "GBP",
        "CAD",
        "AUD",
        "BRL",
        "CHF",
        "JPY",
        "KRW",
        "KWD",
        "BHD",
        "OMR"
      ]
    },
    "budget": {
      "type": "number",
      "minimum": 0,
      "maximum": 10000000
    },
    "preferences": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300,
      "pattern": "\\S"
    },
    "options": {
      "type": "array",
      "minItems": 0,
      "maxItems": 8,
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 60,
            "pattern": "\\S"
          },
          "date": {
            "type": "string",
            "minLength": 1,
            "maxLength": 10,
            "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100,
            "pattern": "\\S"
          },
          "amount": {
            "type": "number",
            "minimum": 0,
            "maximum": 10000000
          },
          "source": {
            "type": "string",
            "minLength": 1,
            "maxLength": 180,
            "pattern": "\\S"
          },
          "checked": {
            "type": "string",
            "minLength": 1,
            "maxLength": 10,
            "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
          },
          "confirmed": {
            "type": "boolean",
            "const": true
          }
        },
        "required": [
          "id",
          "date",
          "title",
          "amount",
          "source",
          "checked",
          "confirmed"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "start",
    "end",
    "currency",
    "budget",
    "preferences",
    "options"
  ],
  "additionalProperties": false
};
export const contract = "Real calendar dates, forward trip 1\u201331 days; options within trip, unique IDs, confirmed:true, line totals in one supported currency. Amounts/budget <=10000000 each. JPY/KRW:0 decimals; KWD/BHD/OMR:3; other listed currencies:2. Extra precision rejected, totals/compare use integer minor units. Input JSON <=24000; output <=3800.";
