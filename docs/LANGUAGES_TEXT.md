# Reading other people's text in six languages (U3.12)

Sara reads promises in your sent mail and chats (S4), clause checklists and contracts (S7, E6) and
booking mails (S6) in **English, Spanish, French, German, Brazilian Portuguese and Italian**. No model is
used: each language has its own phrase set.

## How it works (one page)

- **Detect, then read with one language only.** `src/lang-text.ts` `detectLang` scores small words
  ("el/los", "le/vous", "der/und", "você/não", "il/della") and letters only one language uses (ñ, ß, ã,
  ò). English wins ties and empty text. A text is then read with *its* language's phrases only, never a
  mix: an English promise "I will book Mañana Café for the Freitag concert" gets no due day from the
  Spanish or German words, and an English contract never matches "Haftungsbegrenzung".
- **Dates per locale.** Day first (20/11/2026, 20.11.2026), month names and short forms in each
  language ("20 de noviembre de 2026", "1er janvier", "3. Dezember", "1º de janeiro", "3 dic"), 24-hour
  times ("07h45", "um 10:55 Uhr", "às 07:45", "ore 9:05"). English keeps month first.
- **Promises (S4, `src/people-ties.ts`).** First-person promise phrases per language ("te envío",
  "voy a enviar", "je vous enverrai", "ich schicke dir", "ich werde … anrufen", "vou te enviar",
  "eu te ligo", "ti mando", "controllerò"), no-promise words ("no/si/quizás", "ne/pas/si", "nicht/wenn",
  "não/se/talvez", "non/se/forse"), questions, other people's words ("Ana me enviará", "Marc va
  envoyer") and quoted replies ("El … escribió:", "Am … schrieb", "Em … escreveu:") are skipped. Due
  days: today/tomorrow/after tomorrow, this/next week, in N days, weekdays, "3 de diciembre", 03/12.
- **Clause checklists (S7 `src/documents/clauses.ts`, E6 `src/biz/contracts.ts`).** Every checklist
  rule has a per-language pattern in `src/documents/clauses-i18n.ts`: headings and sentence wording
  (Duración / Durée / Laufzeit / Prazo / Durata; Limitación de responsabilidad / Limitation de
  responsabilité / Haftungsbegrenzung / Limitação de responsabilidade / Limitazione di responsabilità;
  Ley aplicable / Droit applicable / Anwendbares Recht / Lei aplicável / Legge applicabile). The unusual
  flags work too: automatic renewal ("se renovará automáticamente", "reconduit tacitement", "verlängert
  sich automatisch"), unlimited liability ("Die Haftung ist unbeschränkt") and late fees above 1.5 % a
  month in any unit ("3% mensual", "3 % par mois", "3 % pro Monat", "3% ao mês", "3% al mese"). Clause
  numbers "§ 4", "Artículo 4", "Cláusula 4" and dates like "1. Januar" no longer break sentences. A
  passing mention ("asume la responsabilidad de entregar a tiempo") is not a liability cap. Document
  kinds: Acuerdo de confidencialidad, Geheimhaltungsvereinbarung, Devis, Rechnung, Fattura, Declaração de
  trabalho… (a bare title with no clear language tries each language's title words).
- **Travel mails (S6, `src/inbox/travel-i18n.ts`).** Flights (vuelo/vol/Flug/voo/volo + an airline
  code), booking codes (localizador, référence de réservation, Buchungscode, código de reserva, codice
  di prenotazione), departure/arrival labels (Salida/Llegada, Départ/Arrivée, Abflug/Ankunft,
  Partida/Chegada, Partenza/Arrivo), trains (Zug ICE 578 von … nach …, Treno Frecciarossa 9541 da … a
  …), hotels (Entrada/Salida, Arrivée/Départ, Anreise/Abreise, Check-in/Check-out; Hotel/Hôtel/Pousada
  names), rental cars (recogida/devolución, Abholung/Rückgabe…). Offers and newsletters without a
  flight number and booking code are not bookings. JSON-LD mail was already language-free.

## Limits

- Bills, receipts, shipping and appointments in the inbox are still read with English words (plus
  JSON-LD, which most shops send); U3.12 covers promises, checklists and travel.
- The E6 reader's notice periods ("30 days' notice") and money amounts in European format (1.200,00 €)
  are still English-shaped; dates, flags, rates and termination are per language.
- Detection needs a few words: a one-line note mixing languages is read as the language with more signs.

Tests: `test/u3-lang.test.ts` (fixtures and near-misses per language; made-up data).
