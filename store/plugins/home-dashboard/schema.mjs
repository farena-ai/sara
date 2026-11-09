export const parameters = {
  "type": "object",
  "properties": {
    "observedAt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 30,
      "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$"
    },
    "devices": {
      "type": "array",
      "minItems": 0,
      "maxItems": 8,
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100,
            "pattern": "^[a-z_]+\\.[a-z0-9_]+$"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100,
            "pattern": "\\S"
          },
          "state": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100,
            "pattern": "\\S"
          },
          "approved": {
            "type": "boolean",
            "const": true
          }
        },
        "required": [
          "id",
          "name",
          "state",
          "approved"
        ],
        "additionalProperties": false
      }
    },
    "scenes": {
      "type": "array",
      "minItems": 0,
      "maxItems": 6,
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100,
            "pattern": "^scene\\.[a-z0-9_]+$"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100,
            "pattern": "\\S"
          },
          "approved": {
            "type": "boolean",
            "const": true
          }
        },
        "required": [
          "id",
          "name",
          "approved"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "observedAt",
    "devices",
    "scenes"
  ],
  "additionalProperties": false
};
export const contract = "Real UTC timestamp; unique entity IDs across devices/scenes; approved:true required. Supplied metadata only, not live or control. Input JSON <=24000; output <=3800.";
