# Pictures from her

Settings → Her → **Pictures from her**.

- **Pictures:** Off, only her own portraits (free), or her portraits and new pictures.
- **Picture engine** (for new pictures):
  - **Grok Imagine** (default): edits her own portrait, so her face stays the same. Uses your Grok
    subscription or an xAI API key.
  - **OpenAI images:** uses the OpenAI key from Settings → Models (billed per picture).
  - **A ComfyUI workflow:** runs on your own ComfyUI through the ComfyUI tool server
    (Settings → Add-ons → Other programs (MCP)). In ComfyUI open the workflow, choose
    **Workflow → Export (API)** and paste the file. Pick the node that takes the prompt (usually the
    positive *CLIP Text Encode*) and whether every picture gets a new random seed.
  - **Another image tool:** any connected tool that sends a picture back, and the name of its
    prompt setting.

  Engines other than Grok draw her from her description (name, look, what she wears, her art style)
  each time, so her face can vary a little.
- In a chat she asks before taking a new picture unless you set *Take a new photo* to Allowed in
  Tools.

## Pictures on her own

Off by default. Switch on **She sends pictures on her own** and she now and then sends a picture of
what she's doing, with one line, like a person would.

- **How often:** Rarely (about once a week), Sometimes (2 or 3 a week), Often (about once a day).
  Never more than one a day.
- **Monthly limit:** at most this many in a month (default 8); 0 stops them. The page shows about
  how many pictures that is and, for paid engines, a rough monthly cost (an estimate).
- **Send one now** sends one right away to test it (the monthly limit and every content rule still
  apply).

She follows the same rules as her own messages (Settings → Her → Relationship): not during quiet
hours, inside her daily limit (a picture counts as one of her messages), not while her last message
of her own is unanswered, and not when you haven't written for a week. Only in your own chat in the
app: never in groups, rooms, work channels, other apps or household members' chats. Pictures never
show children; explicit pictures only with Adult mode on. A message is only sent when the picture
really came back.

With ComfyUI or another tool server, the tools it uses must be **Always allowed** for pictures on
her own (nobody is there to answer a card): in Tools choose **Always allow the safe ones** for that
server.

## Always allow

- On an approval card, **Always allow this tool** allows it now and from then on. The card shows
  **Undo**; Settings → Coding → Tools and approvals changes it too.
- In Tools → *Other programs* (and on each server's card in Other programs) one choice per tool
  server: **Ask me first**, **Always allow the safe ones** (tools that only read or make pictures and
  results), **Always allow everything**, or **Never**. *Which tools each choice covers* lists them.
  Installs, downloads, restarts, removing, training, renting machines and reporting keep asking
  under every choice unless you change that tool itself. Only the owner has these.
