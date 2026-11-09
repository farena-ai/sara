export const parameters = {
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "minLength": 1,
      "maxLength": 7,
      "pattern": "\\S",
      "enum": [
        "prepare",
        "save",
        "load",
        "clear"
      ]
    },
    "brief": {
      "type": "string",
      "minLength": 1,
      "maxLength": 600,
      "pattern": "\\S"
    },
    "style": {
      "type": "string",
      "minLength": 1,
      "maxLength": 20,
      "pattern": "\\S",
      "enum": [
        "product",
        "illustration",
        "cinematic"
      ]
    },
    "aspect": {
      "type": "string",
      "minLength": 1,
      "maxLength": 5,
      "pattern": "\\S",
      "enum": [
        "1:1",
        "16:9",
        "9:16"
      ]
    },
    "avoid": {
      "type": "string",
      "minLength": 0,
      "maxLength": 200
    },
    "seed": {
      "type": "integer",
      "minimum": 0,
      "maximum": 2147483647
    }
  },
  "required": [
    "action"
  ],
  "additionalProperties": false
};
export const contract = "Preset version 1 is internal KV shape {version:1,brief,style,aspect,avoid,seed}; seed is integer or null in storage. prepare/save require brief/style/aspect; avoid/seed optional. load/clear take action only. Corrupt/old state is preserved and refused. Input JSON <=24000; output <=3800.";
