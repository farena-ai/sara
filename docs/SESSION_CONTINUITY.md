# Session continuity

Development candidate, not yet in the current public or installed private release.

Session continuity gives your eligible sessions fresh, ordered context with this companion in
this personal space. A later model step can see a previous session's committed reply and short
context notes. It does not merge full transcripts, start another model, send a human a message,
or give a tool permission to do anything.

## Turn it on or off

Open **Settings → Chat apps → Session continuity → Use context across my sessions**. It is on by
default for eligible owner sessions. The change saves automatically and survives a restart.
This control is separate from **Pick up across apps** and **While she's working**; changing it
preserves those settings.

Off stops new continuity context, history tools and model-created handoffs at the next eligible
model boundary. It cannot make an already sent model request unseen. Turning it off does not
delete saved notes, chat messages or run history. You can still explicitly inspect or clear
eligible saved context while it is off.

## Inspect saved notes

Open an eligible chat, choose **This conversation** (the model/workspace chip at the top), then
**Saved session context → Show saved session context**. Each note shows its source session title,
when it was saved, when it stops being eligible, and its text. Earlier revisions are
labelled history; a later model step uses only the newest eligible revision from each source.

A note is available context. Its presence does **not** mean a human received or read it, a tool
executed it, or a check passed. Historical text is quoted data and does not grant permission.
Refresh current project or world facts before relying on them.

## Clear one session's saved context

Choose **Clear saved context**, then **Confirm clear**. **Cancel** or **Escape** cancels without
a delete request. Clear removes saved handoffs aimed at this selected session only. It does not
delete its original chat messages, other sessions' context, old run prompts/audit records,
exports or backups.

Use Clear even when no notes are available for later replies. It also removes expired saved
notes without turning continuity on.

If another writer changes the notes, clear stops with a conflict. Your existing view stays
visible: choose **Reload saved context**, review it, then confirm clear again. A failed request
also keeps the view, so you can retry. Reload does not clear anything.

## Retention and boundaries

Notes are eligible for 24 hours after creation. This is an eligibility limit, **not** a timed
background eraser: expired rows are pruned on the next write. The store retains at most the
newest five notes per source/target pair and the newest 100 overall. Reads do not mutate it.
Editing, deleting or forgetting source dialogue revokes its derived notes; changing relevant
privacy, workspace, room or session scope also invalidates affected context.

Only your own eligible direct app/linked owner-DM/plugin-owner chat and coding sessions with this
companion in this exact personal store take part. No private, off-the-record, other-person,
household-member, business, shared-room, imported, replay or external-app audience gains access.
Archived sessions are excluded; ended sessions are historical reads only and cannot receive
handoffs. Adult source channels require the existing adult setting and eligible owner audience.
Personal coding context does not grant filesystem access to another workspace.

When eligible sessions want to use the provider together, their provider steps wait in order.
Tools, approvals and after-reply hooks do not hold that provider slot. A changed current chat
history stops a waiting request before provider invocation: refresh the conversation and send
again. Other safety, disclosure, privacy, provider, budget and approval checks still apply.

Shared fictional scenes and project collision coordination are separate future work; this
feature does not claim either one is complete.

## Imported and older history

New native Sara JSON imports retain host-side import provenance. Those imported lines are
excluded from session history tools and automatic cross-session context. If you later add real
new dialogue in that conversation, eligible new messages can participate; the imported lines
remain excluded. Importing a file does not authenticate its old speaker as the current owner.

Older records can lack origin information, including genuine old owner messages and native
imports made before this provenance fix. They cannot be reliably distinguished after the fact.
They remain usable as historical context, labelled **Historical user (origin unverified)** rather
than authenticated direct-owner speech. Existing data is not automatically relabelled or erased.
You can keep a particular old conversation out of continuity using the existing private-chat or
forget/delete controls described in [Chats](CHATS.md); saved-note clear has the narrower limits
above. This is a provenance limitation, not a claim that every older chat was imported.
