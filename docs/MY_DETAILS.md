# My details, form filling, mail attachments and store checks in your browser (N4)

## My details

Settings → You → **My details** keeps what a person types into forms again and again:

- name, emails, phones;
- home, work and shipping addresses;
- date of birth (optional), clothing and shoe sizes;
- up to two vehicles (make, model, year, plate, VIN);
- insurance (company, policy number);
- loyalty numbers;
- employer and job title;
- an emergency contact.

It is stored in the person's own space (`my_details` in their store.db, `src/my-details.ts`). Every household member
has their own details, and the demo has none. API: `GET/PUT/DELETE /api/my-details` (`src/routes/my-details.ts`).
The owner's tool is `my_details_get`.

**Never stored:** passwords, payment card numbers, CVCs, SSNs or full government ID numbers. The validators refuse a
value that looks like one and name the field (HTTP 400 `{error, field}`). They check for:

- Luhn-valid 13–19 digit numbers with a card prefix;
- the SSN shape `123-45-6789`;
- secret words such as "PIN", "CVV" or "passport no.".

## Filling a form in the person's own browser (`pc_fill_form`)

This needs the desktop app with *The whole screen* on. Use `pc_fill_form {window | tab, use_address?, values?}`
(`src/form-fill.ts`, `src/tools/computer.ts`):

1. **Look.** It reads the page with `d.elements`. The Windows app also exports each field's AutomationId (the HTML
   id/name) and HelpText.
2. **Match.** Each field is matched to a detail by its label, its id/name and the browser's autocomplete purpose.
   - It never matches password, card, CVC, ID-number or one-time-code fields. Those are listed as "left for you".
   - Sign-in names, search boxes, coupons and free-text boxes are ignored.
3. **One review card on the PC.** The card lists every field and its value. The Windows app always shows it, even
   for actions that are Always allowed. *Allow for this task* covers typing every field.
4. **Type.** Edits are typed with `d.type`. A pick-list (`<select>`) has its option chosen by name through UI
   Automation; if no option has that name, the value is typed into the list. Payment and sign-in pages ask at every
   step. Sara keeps to the PC's limit of 4 actions a second.
5. **Read back.** It looks at the page again and reports `Verified: read back …`.
6. **Stop before Submit.** Sara never presses Submit herself. The person presses it, or says "submit it" and
   approves a separate card. On payment or sign-in pages the person always presses Submit.

## Mail attachments

`mail_draft` and `mail_send` (Outlook/Graph and IMAP/SMTP), and `gmail_draft` and `gmail_send`, take `attachments`.
Each item is one of:

- a Library number (`12` or `library:12`);
- a chat file id (`src/mail/attachments.ts`).

Limits per email:

| Mail service | Size limit |
| --- | --- |
| Gmail | 20 MB |
| IMAP/SMTP | 20 MB |
| Outlook | 3 MB (each Graph request stays under its 4 MB limit) |

At most 10 files go with one email.

How each service builds the email:

- Gmail and SMTP send `multipart/mixed` with RFC 2231 UTF-8 file names.
- Graph adds each file as a `fileAttachment`.

The N1 verify line reads the attachment names back from the saved draft. Also:

- "Email it" after `invoice_make` offers a draft with the invoice attached.
- The automations' `draft_email` step attaches the file the run produced.
- The time-sheet starter, given "email it to boss@…", drafts the email with the filled sheet attached.

Drafts are only saved. Nothing is sent unless send is on and approved.

## Store checks in the person's browser ("check in my browser")

Some stores block Sara's own browser (a bot check or "access denied"). For those stores, `find_product` lists
"Couldn't check" and offers **check in my browser**. This runs as `find_product {result_id, in_my_browser: true}`
(`src/shopping/my-browser.ts`, `my-browser-port.ts`).

Sara uses the person's own browser on the paired PC, where their store selection and sign-in apply:

1. She opens a new tab and types the store's address with Enter.
2. She reads the price, stock and pickup with `d.elements`.
3. She closes the tab again, unless **Leave the store tab open** is checked on the My details page.

Every step is an approval card on the PC. The page text is data only. She never adds anything to a cart, signs in or
buys anything.

Results come back into the ranked list labeled **from your browser**. A product watch with "check in my browser" on
uses the same path, under these limits:

- the PC must be on and idle;
- Sara stops at the takeover pause or when the person uses the PC;
- she does not run while another task holds the computer.

When she can't run, the result says "Not now: …" and nothing is read.
