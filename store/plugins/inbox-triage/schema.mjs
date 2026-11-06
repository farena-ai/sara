export const parameters = {
  "type": "object",
  "properties": {
    "messages": {
      "type": "array",
      "minItems": 0,
      "maxItems": 8,
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "pattern": "\\S"
          },
          "subject": {
            "type": "string",
            "minLength": 1,
            "maxLength": 180,
            "pattern": "\\S"
          },
          "body": {
            "type": "string",
            "minLength": 0,
            "maxLength": 1500
          }
        },
        "required": [
          "id",
          "subject",
          "body"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "messages"
  ],
  "additionalProperties": false
};
export const contract = "Unique message IDs. Input JSON <=24000 characters; output <=3800, oversized results refused.";
