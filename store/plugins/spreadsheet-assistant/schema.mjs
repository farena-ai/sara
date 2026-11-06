export const parameters = {
  "type": "object",
  "properties": {
    "csv": {
      "type": "string",
      "minLength": 1,
      "maxLength": 12000,
      "pattern": "\\S"
    },
    "filter": {
      "type": "object",
      "properties": {
        "column": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100,
          "pattern": "\\S"
        },
        "equals": {
          "type": "string",
          "minLength": 0,
          "maxLength": 1000
        }
      },
      "required": [
        "column",
        "equals"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "csv"
  ],
  "additionalProperties": false
};
export const contract = "CSV <=50 data rows, <=12 columns, <=1000 characters/cell; unique nonblank header, rectangular rows. Filter exact, case-sensitive. Statistics use floating point, not financial precision. Input JSON <=24000; output <=3800.";
