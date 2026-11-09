# Brand pictures: where they come from

- **Art:** OpenAI GPT Image 2 (requested `high`) through the Hermes `openai-codex` image plugin,
  made 2026-11-07 from a written prompt plus two crops of the earlier Sara art as references, so she
  keeps her look: wavy auburn hair, light freckles, cream cable-knit sweater, warm plum, rose and
  amber light. The prompt asked for no text in the art.
- **Words:** never drawn by the image model. The lockup is HTML/CSS rendered over the art in
  headless Chromium (Playwright) and saved as WebP (quality 86) / JPEG (quality 88):
  - hero (1600×640) and social preview (1280×640): the **Sara** wordmark (Georgia), a rose-to-gold
    rule, *Your companion. Your coding partner. Your server.* (Segoe UI), *Self-hosted AI companion &
    agent harness* in gold capitals and `github.com/farena-ai/sara`;
  - section pictures (1600×560, the new look 1600×800): a small **Sara · section** label in the top
    left corner, away from her face.
- **Colours:** rose `#B4436C` and gold `#C99A45` (the warm side of the README badge colours), cream
  `#FBEFE6` text, plum `rgba(32,12,38,.52)` behind the section labels.
- **Social preview:** GitHub → Settings → General → Social preview → Upload
  `sara-social-preview.jpg` (owner step; there is no API for it).
