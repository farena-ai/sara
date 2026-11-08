# Companion portraits: where they come from

The portraits of the 21 first-party companion packs in `store/companions/<id>/` (`look/sara-portrait.jpg`,
`look/sara-avatar.jpg`, `cover.png`).

- **Model:** OpenAI GPT Image 2 (requested `high`, square) through the Hermes `openai-codex` image
  plugin, called directly, the same method as the brand art (`docs/images/brand/PROVENANCE.md`). Made
  2026-11-07, one picture per companion, no reference images, no retries needed.
- **Prompt:** `Square portrait of <name>, <look.json appearance>, wearing <look.json wear>, in <look.json
  place>.` followed by the shared house style:

  > Warm painterly digital illustration, soft brush texture, gentle warm rim light, a harmonious palette with warm plum, rose and amber accents, friendly and approachable, looking at the viewer, head and shoulders, centered, softly blurred background. The character is clearly an adult. An original fictional character, not based on any real person, celebrity or existing franchise character. Fully clothed, safe for work. No text, no letters, no logos, no watermark, no border.

  The words come from each pack's own `look.json`, so the picture and the look Sara builds later describe
  the same person. Every appearance line states an adult age (21+).
- **Files:** the 1254 px PNG is resized (Lanczos) to a 1024 px JPEG portrait (quality 88), a 384 px JPEG
  avatar and a 512 px PNG cover, saved fresh with no EXIF/XMP/text chunks (the pack checker refuses
  picture metadata). `rights.json` in each pack: `made: "ai"`, `model: "gpt-image-2"`, `by: "the Sara
  team"`, `from: "words"`, `at: "2026-11-07"`.
- **Review:** every picture was looked at before signing: clearly adult, fully clothed, no text, logos or
  franchise characters, no likeness of a real person intended or recognisable. The four starter packs
  had plain gradient covers before; their `look.json` style is now `illustrated` so the shelf is one set.

| id | name | image request id | generated size |
|---|---|---|---|
| juniper | Juniper | `3f1c7477-c613-4dcf-a30c-9cba9cd127cf` | 1254x1254 |
| rowan | Rowan | `c95ee3f4-1d6e-4f90-9a47-69a0cc830085` | 1254x1254 |
| vesper | Vesper | `da7fbb56-e8de-4583-9fdd-cca0b90fba97` | 1254x1254 |
| jax | Jax | `3b5332bf-232b-42e8-9e2c-7634982a0095` | 1254x1254 |
| marisol | Marisol | `ba27d1e6-da41-4957-b6dc-d96d72829a53` | 1254x1254 |
| elodie | Élodie | `4659423b-f598-44db-a838-3b6c50da1b9a` | 1254x1254 |
| kenji | Kenji | `25a40b73-c17a-4d79-bea8-2b8f40ba6a21` | 1254x1254 |
| dex | Dex | `6eb3c01d-00d5-439a-a734-1f9150466937` | 1254x1254 |
| lucia | Lucia | `62568d1c-ce6c-4001-8b42-66a82a92e61f` | 1254x1254 |
| priya | Priya | `f3858e7a-fd22-4123-a9e9-90630e188bf3` | 1254x1254 |
| wren | Wren | `874a717c-023f-44a8-94b4-cd94ec317866` | 1254x1254 |
| hollis | Hollis | `425ca114-f5b6-4534-acfe-b919d8616528` | 1254x1254 |
| ines | Inês | `75345538-192a-47d0-a9bd-231dde3d3352` | 1254x1254 |
| tavi | Tavi | `97d37722-4282-4ec0-b7a1-2dd0e8c621ee` | 1254x1254 |
| nia | Nia | `81a7e217-50b2-4900-a641-4eb55c7eb037` | 1254x1254 |
| ambrose | Ambrose | `a66fd420-b4e4-43a7-bde6-e7fe60fc98ac` | 1254x1254 |
| bram | Bram | `4884c5f7-4233-453c-b0a6-67c461d57990` | 1254x1254 |
| zara | Zara | `a671e057-a199-4dee-80a1-ec3bd46ac030` | 1254x1254 |
| arjun | Arjun | `d485b2e0-c517-4c59-a109-66105fee7258` | 1254x1254 |
| theodora | Theodora | `c01b5e81-4290-4701-aeae-b660d9965b94` | 1254x1254 |
| kestrel | Kestrel | `245e86b6-5aaf-4aff-adf7-cb968ca03d77` | 1254x1254 |
