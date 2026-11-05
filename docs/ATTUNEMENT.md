# Recent cues and follow-ups

E2 development candidate: implementation and qualification are separate from a published release.
See the changelog and release notes for the version actually installed.

Sara can respond to explicit tiredness, frustration with a task and conflict directed at her.
Criticizing broken code is not the same thing as insulting your companion. The rules recognize
a bounded set of phrases in English, Spanish, French, German, Brazilian Portuguese and Italian;
they can miss slang, irony or unusual wording. This is not a diagnosis or comprehensive emotion
detector. Say when things change; explicit corrections take precedence.

## What she uses

Normal owner chat and coding replies recheck up to the latest six eligible messages in the current
conversation, within 30 minutes of their original timestamps. Unrelated new messages do not keep an
old cue alive. Quoted/code examples, reported speech, third-person statements, denials and ambiguous
statements are excluded conservatively. Nothing runs a separate classifier or adds a provider call.
Existing model calls and selected destinations still apply.

The existing **Inner life** switch controls these cues. Her mood and energy labels describe her
simulated character state. There is no new owner mood-profile table or setting. Existing character
reactions to genuine conflict, apology, stress and ordinary private owner interaction remain; tiredness
alone does not add persistent concern. Historical raw disagreement quotations are not included in
newly built character prompts, and existing numeric state is not reset merely by reading it.

New cues are excluded for private conversations, off-record chats, household members, demo, partners,
groups/work rooms, external/client-supplied contexts, unattended goals/loops, replay and resume.
The global **Nothing leaves this computer** setting is compatible with otherwise eligible local
owner replies; it is different from making a particular conversation private or off the record.
Live-call transcripts from an eligible owner session retain their source identity for later normal
chat replies. Realtime voice calls keep their existing character behavior; the new marked cue note
is added to normal chat/coding provider handoffs.

## What changes and forgetting do

Fresh cue and follow-up notes are checked at the actual normal provider handoff, after awaited
preparation or approval. Source edits, deletion, forgetting, privacy changes, opt-out and original
expiry affect those new notes. Unknown queued/bridge origins are not promoted just because their
messages have a user role. Proven owner-web queued messages and steers keep their identity.

This does not retroactively erase a provider request, a conversation, recorded prompt, export or
backup. Coding/run records can retain the cue note under existing settings (defaults: 90 days and
200 MB; an until-deleted option also exists). Run-history inspection/export/deletion remain separate
controls. Existing memory and skill systems can independently retain stated facts; no claim is made
that a word vanishes from every subsystem. The general conversation-history snapshot mechanism is
unchanged; current derived-note invalidation is not a promise to rebuild every in-flight input.

Newly recorded transient cue/follow-up extras are omitted during replay, and the replay cannot claim
identical original inputs when it omits them. The original record remains inspectable. Older base
prompts retain their historical semantics; this is not a retrospective rewrite of old runs.

## More accurate follow-ups

Mentioning a person or company name alone does not answer an event. Recognized categories are
interviews, appointments, exams, trips, meetings, surgery, moves and presentations. A clear reported
outcome (including a bad outcome), cancellation or decline must identify the event. Pending,
hypothetical, quoted and ambiguous reports do not close it. With competing events, an ambiguous
answer closes neither. Evidence is bounded to recent eligible messages; a missing match is not proof
that you never answered elsewhere.

Automatic follow-ups use current qualified conversation sources or new notes explicitly added by
the owner. Old/imported notes stay visible, searchable and editable; an edit does not silently
authenticate their origin. A full database backup preserves genuine provenance, while JSON import
does not turn supplied origin fields into proof. Different companions, household spaces, private
conversations and workspaces do not become shared merely because their words overlap.

Agenda keeps its own opt-in, daily caps, quiet hours, budgets and delivery controls. A short answer
such as “It went great” counts only immediately after a single identifiable, still-valid question.
Short-answer matching recognizes bounded explicit question forms; unfamiliar wording stays pending
rather than guessing. An explicit answer such as “My interview went well” remains available.
An edit, deletion or intervening question cannot manufacture that relationship. Supported explicit
topic answers can arrive later in the same sent conversation. Other qualified plans retain normal
delivery and manual **Done/Skip** controls even when their event category is unsupported by automatic
closure.

An event's known date is separate from a moved question window. Moving a check-in does not move the
event. When an older edited plan has no trustworthy event date, closure remains conservative.
Revalidating an invalid automatic completion can return it to **Sent**; it preserves the original
delivery and never resends the question automatically. Existing unprovenanced completed plans stay
completed, and manual completion/cancellation remains authoritative.
