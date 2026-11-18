# U3.15: tracked changes in every part, comments, moves

Owner ask (ROADMAP_U U3.15): tracked changes in headers, footers, text boxes and comments, plus moved text.

## What existed (S7)
`src/documents/tracked.ts`: a paragraph model (plain runs become characters that remember their run),
`reviseDocx` (find/replace, insert after, delete paragraph) writing `w:ins`/`w:del` in `word/document.xml`
only; anything not a plain run (hyperlink, field, picture) was opaque and an edit through it was refused.
`listRevisions`/`resolveAll` read and resolved the body only. Tool `doc_revise`, route
`/api/doc-studio/:id` and the Library review card (`web/doc-studio.js`).

## What changed (extended in place, nothing duplicated)
- **Stories.** `openDocx` also returns the story parts from the main part's rels (headers, footers,
  footnotes, endnotes, comments). `storyParas` walks them: paragraphs in `w:txbxContent` are "textbox";
  in `mc:AlternateContent` the `mc:Fallback` (VML) paragraphs are paired with the `mc:Choice` ones when
  their text matches and edited alongside (listed once). Search order: everything but comments first.
- **One id counter** starting above every `w:id` in every XML part, so revision, comment and move-range
  ids are unique across the package.
- **Links and fields.** A hyperlink with only plain runs is flattened into the model (each character
  remembers its link) and written back as one link element per stretch (same attributes and `r:id`);
  `w:del`/`w:ins` sit inside it, which the schema allows. `w:fldSimple` shows its value in the tracked
  edit text; the diff never deletes it (a deleted field would regenerate anyway) and its text stays.
  Untracked filling (placeholders) is unchanged: fields are still opaque there.
- **Comments.** `{comment, on}` adds `commentRangeStart`/`End` + reference run (inside the link when the
  words are), `comments.xml` (with rel + content type when missing), and `commentEx`/`commentId`/
  `commentExtensible` entries only when those parts already exist (Word needs them consistent, not
  present). Body and notes only.
- **Moves.** `{move, after|before}`: whole paragraph. The old paragraph's runs go in `w:moveFrom`
  (inside links/simple fields too) between `moveFromRangeStart`/`End`; a copy (bookmarks stripped) in
  `w:moveTo` between `moveToRangeStart`/`End` with the same `w:name`; both paragraph marks are marked so
  accept/reject leaves no empty paragraph. Refused: earlier revisions, notes/comments/text boxes/complex
  fields inside, a section-ending paragraph, a no-op.
- **Accept/reject all** walks every story; move range marks are dropped; comments stay (as Word).
- Reader: `readDocx` skips `w:moveFrom` (the accepted view has the text once, where it went).
- UI: review card shows Moved and where each change is; a new Comments card (author, date, anchored words).
- Lean words for "add a comment", "move the paragraph" in six languages.

## Proof
`test/u3-docs-tracked.test.ts` (fixture `test/u3-docs-fixtures.ts`): XML well-formed, ids unique across
parts, rels/content types, reader round trip, accept/reject in every part, existing comment parts.
Real Word 16 (read-only COM): every result opens without repair; revisions found in body, footnote,
endnote, text box, header and footer stories; moves are Word types 14/15; comments with their scope.
