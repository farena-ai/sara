export const parameters = {
  "type": "object",
  "properties": {
    "brief": {
      "type": "string",
      "minLength": 1,
      "maxLength": 600,
      "pattern": "\\S"
    },
    "audience": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120,
      "pattern": "\\S"
    },
    "tone": {
      "type": "string",
      "minLength": 1,
      "maxLength": 60,
      "pattern": "\\S"
    },
    "channel": {
      "type": "string",
      "minLength": 1,
      "maxLength": 30,
      "pattern": "\\S",
      "enum": [
        "newsletter",
        "social",
        "article",
        "email"
      ]
    },
    "useModel": {
      "type": "boolean"
    }
  },
  "required": [
    "brief",
    "audience",
    "tone",
    "channel"
  ],
  "additionalProperties": false
};
export const contract = "useModel defaults false: one background-route request, max600 output tokens, may cost money. Local tone is a review instruction, not applied prose styling. Input JSON <=24000; output <=3800.";
