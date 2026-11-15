# Pictures from her

Settings → Sara → **Pictures from her**.

- **Pictures:** Off, only her own portraits (free), or her portraits and new pictures.
- **Picture engine** (for new pictures):
  - **Grok Imagine** (default): edits her own portrait, so her face stays the same. Uses your Grok
    subscription or an xAI API key.
  - **OpenAI images:** uses the OpenAI key from Settings → Models (billed per picture).
  - **A ComfyUI workflow:** runs on your own ComfyUI through the ComfyUI tool server
    (Settings → Skills & tools → Other programs (MCP)). Either pick a workflow you saved in ComfyUI
    (**Saved in ComfyUI** → **Load the list**; Sara reads it converted to API format and keeps a copy,
    so pick it again after you change it in ComfyUI), or open the workflow in ComfyUI, choose
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
  apply). It runs in the background, so the page stays usable: the line under the button shows
  *Writing the scene…*, *Making the picture in ComfyUI…* (or the engine you use), then where it went
  (*Sent to the "Pictures from Sara" chat · Telegram: "…"*) or the plain reason it wasn't sent. One
  at a time; closing the page doesn't stop it.

### Where they go

**Send her pictures to** decides where every picture on her own lands (Send one now too), so they
never turn up in whichever chat happens to be first:

- **A chat just for her pictures** (the default): a chat called *Pictures from <her name>*, made the
  first time and used from then on.
- **One of my chats here:** pick one of your own chats with her (private chats, groups, rooms and
  chats with other people aren't offered).
- **A chat in a project:** pick a project; her pictures go to a *Pictures from <her name>* chat inside
  it, made the first time.
- **Only my chat apps:** nothing new here; the picture goes to the apps you tick below and is kept in
  her Telegram or Discord chat with you in the app.
- **To my Telegram** / **To my Discord:** each picture also arrives, with her line as the caption, in
  your own Telegram chat or Discord DM with her. They can only be picked when that app is connected
  (otherwise the line says *Telegram isn't connected*), and *Sending pictures and files* in Apps and
  services must be on. Her pictures are never mirrored from another chat.

The line under the choices shows the result, for example *Sends to: the "Pictures from Sara" chat ·
Telegram*. Every picture is also in her Photos in the Scrapbook, because it is always kept in a chat
here. If you had *Also send them to my chat apps* on before, that became a chat just for her
pictures + Telegram + Discord.

### With ComfyUI

Sara queues your workflow through the ComfyUI tool server and checks ComfyUI's history every few
seconds. As soon as ComfyUI is done she fetches the first picture it saved. If the run fails she
stops at once and says why (for example *ComfyUI couldn't finish the picture: Value not in list:
ckpt_name …*); if it finished without saving a picture: *check it ends in Save Image*. After 5
minutes without a result she gives up.

She follows the same rules as her own messages (Settings → Sara → Relationship): not during quiet
hours, inside her daily limit (a picture counts as one of her messages), not while her last message
of her own is unanswered, and not when you haven't written for a week. Only where you chose above:
never in groups, rooms, work channels, other people's or household members' chats. Pictures never
show children; explicit pictures only with Adult mode on. A message is only sent when the picture
really came back.

With ComfyUI or another tool server, the tools it uses must be **Always allowed** for pictures on
her own (nobody is there to answer a card): in Tools choose **Always allow the safe ones** for that
server.

## Always allow

- On an approval card, **Always allow this tool** allows it now and from then on. The card shows
  **Undo**; Settings → Skills & tools → Tools and approvals changes it too.
- In Tools → *Other programs* (and on each server's card in Other programs) one choice per tool
  server: **Ask me first**, **Always allow the safe ones** (tools that only read or make pictures and
  results), **Always allow everything**, or **Never**. *Which tools each choice covers* lists them.
  Installs, downloads, restarts, removing, training, renting machines and reporting keep asking
  under every choice unless you change that tool itself. Only the owner has these.
