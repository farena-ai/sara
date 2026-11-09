// The Teams attachments she sends (docs/ops/EC7_DESIGN.md): an Adaptive Card for her requests for his
// OK (Allow / Deny) and for the progress message (⏹), and the file-consent and file-info cards of
// Teams' personal-chat file flow. Buttons are `Action.Submit`: a tap comes back as a message activity
// whose `value` is `{ sara: '<id>' }` (Sara decides what it means, never the plugin).

export const CARD = 'application/vnd.microsoft.card.adaptive';
export const CONSENT = 'application/vnd.microsoft.teams.card.file.consent';
export const FILE_INFO = 'application/vnd.microsoft.teams.card.file.info';
export const DOWNLOAD_INFO = 'application/vnd.microsoft.teams.file.download.info';
const TEXT_MAX = 6_000;

const style = (id) => (/^ap:.+:1$/.test(id) ? 'positive' : /^ap:/.test(id) ? 'destructive' : 'default');

/** A card with her text and up to five buttons (`[{ id, label }]`); no buttons = the text alone. */
export function card(text, buttons = []) {
  const t = String(text ?? '');
  return {
    contentType: CARD,
    content: {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body: [{ type: 'TextBlock', text: t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t || ' ', wrap: true }],
      ...(buttons.length ? { actions: buttons.slice(0, 5).map((b) => ({ type: 'Action.Submit', title: String(b.label ?? b.id).slice(0, 40), style: style(String(b.id)), data: { sara: String(b.id).slice(0, 200) } })) } : {}),
    },
  };
}

/** Asks him to let her put a file in his OneDrive (personal chat only); `fileId` comes back on Allow. */
export function consent(name, size, fileId, description) {
  return { contentType: CONSENT, name: String(name).slice(0, 120), content: { description: String(description ?? '').slice(0, 200), sizeInBytes: size, acceptContext: { fileId }, declineContext: { fileId } } };
}

/** The file she uploaded, shown in the chat. */
export function fileInfo(info) {
  return { contentType: FILE_INFO, contentUrl: String(info.contentUrl ?? ''), name: String(info.name ?? 'file').slice(0, 120), content: { uniqueId: String(info.uniqueId ?? ''), fileType: String(info.fileType ?? '') } };
}

/** The button id a tap carries (`value.sara`), or ''. */
export const tapOf = (activity) => {
  const v = activity?.value;
  return v && typeof v === 'object' && typeof v.sara === 'string' ? v.sara.slice(0, 200) : '';
};
