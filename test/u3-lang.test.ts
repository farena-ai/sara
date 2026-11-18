// U3.12 (docs/LANGUAGES_TEXT.md): promises, clause checklists and travel emails in English, Spanish,
// French, German, Brazilian Portuguese and Italian. Phrase sets per language, no model: the text's
// language is detected first and only that language's phrases are used (never mixed). Every
// language has fixtures that must match and near-misses that must NOT. All data is made up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { clauseChecklist, guessDocType, type Checklist } from '../src/documents/clauses.ts';
import { extractContract } from '../src/biz/contracts.ts';
import { classify, findDate, type InboxMail } from '../src/inbox/classify.ts';
import { detectLang } from '../src/lang-text.ts';
import { findPromises } from '../src/people-ties.ts';

// Wednesday 2026-11-18 in Chicago: Friday = 11-20, tomorrow = 11-19.
const AT = '2026-11-18T16:00:00Z';
const TZ = 'America/Chicago';
const NOW = new Date('2026-11-16T15:00:00Z');

// ------------------------------------------------------------------ language detection

test('U3.12 detectLang: each fixture language, English by default', () => {
  const cases: [string, string][] = [
    ['Thanks for the call, I will send you the slides by Friday.', 'en'],
    ['Gracias por la llamada. Te envío las diapositivas el viernes.', 'es'],
    ['Merci pour votre appel, je vous enverrai le devis vendredi.', 'fr'],
    ['Danke für den Anruf, ich schicke dir die Unterlagen bis Freitag.', 'de'],
    ['Obrigado pela ligação, vou te enviar o relatório na sexta.', 'pt'],
    ['Grazie per la chiamata, ti mando il preventivo venerdì.', 'it'],
    ['', 'en'],
    ['OK 12:30', 'en'],
  ];
  for (const [s, want] of cases) assert.equal(detectLang(s), want, s);
});

// ------------------------------------------------------------------ S4 promises

const PROMISES: Record<string, { yes: [string, string, string | null][]; no: string[] }> = {
  es: {
    yes: [
      ['Hola Ana,\nGracias por la llamada. Te envío las diapositivas el viernes.\nUn saludo, Alex', 'envío las diapositivas', '2026-11-20'],
      ['Mañana te llamo para hablar del contrato.', 'te llamo', '2026-11-19'],
      ['Te mando el contrato firmado el 3 de diciembre.', 'mando el contrato', '2026-12-03'],
      ['Voy a revisar el presupuesto la semana que viene.', 'revisar el presupuesto', '2026-11-25'],
    ],
    no: ['No te voy a enviar nada hasta que firmes el acuerdo.', '¿Te envío el informe mañana?', 'Ana me enviará el informe el viernes por la tarde.', 'Si me mandas los datos, revisaré el informe.'],
  },
  fr: {
    yes: [
      ['Bonjour Marc,\nMerci pour votre appel. Je vous enverrai le devis vendredi.\nCordialement, Alex', 'enverrai le devis', '2026-11-20'],
      ['Je vais t’appeler demain matin pour en parler.', 'appeler demain', '2026-11-19'],
      ['Je vous envoie la facture le 3 décembre.', 'envoie la facture', '2026-12-03'],
    ],
    no: ['Je ne vais pas envoyer le devis avant la signature.', 'Est-ce que je vous envoie le devis demain ?', 'Marc va envoyer le devis vendredi prochain.', 'Si vous me donnez les chiffres, je vérifierai le devis.'],
  },
  de: {
    yes: [
      ['Hallo Jonas,\ndanke für den Anruf. Ich schicke dir die Unterlagen bis Freitag.\nViele Grüße, Alex', 'schicke dir die Unterlagen', '2026-11-20'],
      ['Ich werde dich morgen wegen des Vertrags anrufen.', 'anrufen', '2026-11-19'],
      ['Ich sende Ihnen das Angebot bis zum 3. Dezember.', 'sende Ihnen das Angebot', '2026-12-03'],
    ],
    no: ['Ich werde nächste Woche im Urlaub sein und keine Mails lesen.', 'Ich schicke dir nichts, bevor der Vertrag steht.', 'Jonas schickt dir die Unterlagen am Freitag.', 'Soll ich dir die Unterlagen morgen schicken?'],
  },
  pt: {
    yes: [
      ['Oi Bia,\nObrigado pela ligação. Vou te enviar o relatório na sexta.\nAbraços, Alex', 'enviar o relatório', '2026-11-20'],
      ['Amanhã eu te ligo para falar do contrato.', 'te ligo', '2026-11-19'],
      ['Eu mando a proposta assinada até 03/12.', 'mando a proposta', '2026-12-03'],
    ],
    no: ['Não vou enviar o relatório antes da reunião de segunda.', 'Você pode me enviar o relatório amanhã?', 'A Bia vai enviar o relatório na sexta.', 'Se você me mandar os números, eu reviso o relatório.'],
  },
  it: {
    yes: [
      ['Ciao Luca,\ngrazie per la chiamata. Ti mando il preventivo venerdì.\nA presto, Alex', 'mando il preventivo', '2026-11-20'],
      ['Domani ti chiamo per il contratto.', 'ti chiamo', '2026-11-19'],
      ['Controllerò la bozza entro il 3 dicembre.', 'Controllerò la bozza', '2026-12-03'],
    ],
    no: ['Non ti mando niente finché non firmi il contratto.', 'Ti mando il preventivo domani?', 'Luca manderà il preventivo venerdì prossimo.', 'Se mi mandi i numeri, controllerò il preventivo.'],
  },
};

for (const [lang, set] of Object.entries(PROMISES)) {
  test(`U3.12 promises (${lang}): found with their due day`, () => {
    for (const [text, part, due] of set.yes) {
      const got = findPromises(text, AT, TZ);
      assert.equal(got.length, 1, `${text} → ${JSON.stringify(got)}`);
      assert.ok(got[0]!.text.toLowerCase().includes(part.toLowerCase()), `${got[0]!.text} ∌ ${part}`);
      assert.equal(got[0]!.due, due, text);
    }
  });
  test(`U3.12 promises (${lang}): near-misses are not promises`, () => {
    for (const text of set.no) assert.deepEqual(findPromises(text, AT, TZ), [], text);
  });
}

test('U3.12 promises: quoted replies in other languages are not the owner’s words', () => {
  const mail = 'Perfecto, gracias.\n\nEl 17 nov 2026, Ana escribió:\n> Te envío el contrato mañana.';
  assert.deepEqual(findPromises(mail, AT, TZ), []);
  const de = 'Danke!\n\nAm 17.11.2026 schrieb Jonas:\n> Ich schicke dir die Unterlagen morgen.';
  assert.deepEqual(findPromises(de, AT, TZ), []);
});

test('U3.12 promises: an English text never reads Spanish/German day words', () => {
  // "Mañana" (a café's name) and "Freitag" (a band) are not due days in an English promise.
  const got = findPromises('I will book a table at Mañana Café for the Freitag concert.', AT, TZ);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.due, null);
});

// ------------------------------------------------------------------ S7 clause checklists

const status = (c: Checklist) => Object.fromEntries(c.items.map((i) => [i.id, i.status]));

const CONTRACTS: Record<string, string> = {
  es: `CONTRATO DE PRESTACIÓN DE SERVICIOS
Este contrato se celebra entre Estudio Ejemplo S.L. y Cliente Demo S.A.

1. Duración. El presente contrato entra en vigor el 1 de enero de 2027 y se renovará automáticamente por periodos sucesivos de un año salvo preaviso.

2. Pago. El Cliente pagará cada factura en un plazo de 30 días. Los pagos atrasados devengarán un interés del 3% mensual.

3. Resolución. Cualquiera de las partes podrá resolver el contrato con un preaviso de 30 días.

4. Limitación de responsabilidad. La responsabilidad total del Proveedor no excederá los honorarios pagados en los últimos doce meses.

5. Indemnización. El Cliente mantendrá indemne al Proveedor frente a reclamaciones de terceros.

6. Confidencialidad. Las partes mantendrán la confidencialidad de la información recibida.

7. Propiedad intelectual. Los derechos de propiedad intelectual sobre los entregables pertenecen al Cliente.

8. Ley aplicable. Este contrato se rige por las leyes de España.

Firmas: ______________`,
  fr: `CONTRAT DE PRESTATION DE SERVICES
Le présent contrat est conclu entre Atelier Exemple SARL et Client Démo SAS.

1. Durée. Le contrat entre en vigueur le 1er janvier 2027 et sera reconduit tacitement par périodes successives d’un an.

2. Paiement. Le Client paiera chaque facture sous 30 jours. Tout retard entraîne des pénalités de retard de 3 % par mois.

3. Résiliation. Chaque partie peut résilier le contrat avec un préavis de 30 jours.

4. Limitation de responsabilité. La responsabilité totale du Prestataire ne pourra excéder les honoraires versés au cours des douze derniers mois.

5. Indemnisation. Le Client garantit et indemnisera le Prestataire contre toute réclamation de tiers.

6. Confidentialité. Les parties gardent confidentielles les informations échangées.

7. Propriété intellectuelle. Les droits de propriété intellectuelle sur les livrables sont cédés au Client.

8. Droit applicable. Le présent contrat est régi par le droit français.

Signatures : ______________`,
  de: `DIENSTLEISTUNGSVERTRAG
Dieser Vertrag wird geschlossen zwischen Beispiel Studio GmbH und Demo Kunde AG.

§ 1 Laufzeit. Der Vertrag tritt am 1. Januar 2027 in Kraft und verlängert sich automatisch um jeweils ein weiteres Jahr, wenn er nicht gekündigt wird.

§ 2 Vergütung. Der Kunde zahlt jede Rechnung innerhalb von 30 Tagen. Bei Zahlungsverzug fallen Verzugszinsen von 3 % pro Monat an.

§ 3 Kündigung. Jede Partei kann den Vertrag mit einer Frist von 30 Tagen kündigen.

§ 4 Haftungsbegrenzung. Die Haftung des Auftragnehmers ist auf die in den letzten zwölf Monaten gezahlte Vergütung begrenzt.

§ 5 Freistellung. Der Kunde stellt den Auftragnehmer von Ansprüchen Dritter frei.

§ 6 Vertraulichkeit. Die Parteien behandeln alle erhaltenen Informationen vertraulich.

§ 7 Nutzungsrechte. Das geistige Eigentum an den Arbeitsergebnissen geht auf den Kunden über.

§ 8 Anwendbares Recht. Es gilt das Recht der Bundesrepublik Deutschland. Gerichtsstand ist Berlin.

Unterschriften: ______________`,
  pt: `CONTRATO DE PRESTAÇÃO DE SERVIÇOS
Este contrato é celebrado entre Estúdio Exemplo Ltda. e Cliente Demo S.A.

1. Prazo. O presente contrato entra em vigor em 1º de janeiro de 2027 e será renovado automaticamente por períodos sucessivos de um ano.

2. Pagamento. O Cliente pagará cada fatura em até 30 dias. Pagamentos em atraso terão juros de mora de 3% ao mês.

3. Rescisão. Qualquer das partes poderá rescindir o contrato com aviso prévio de 30 dias.

4. Limitação de responsabilidade. A responsabilidade total do Prestador não excederá os honorários pagos nos últimos doze meses.

5. Indenização. O Cliente deverá indenizar o Prestador por reclamações de terceiros.

6. Confidencialidade. As partes manterão sigilo sobre as informações recebidas.

7. Propriedade intelectual. Os direitos de propriedade intelectual sobre as entregas pertencem ao Cliente.

8. Lei aplicável e foro. Este contrato é regido pelas leis do Brasil, ficando eleito o foro de São Paulo.

Assinaturas: ______________`,
  it: `CONTRATTO DI PRESTAZIONE DI SERVIZI
Il presente contratto è stipulato tra Studio Esempio S.r.l. e Cliente Demo S.p.A.

1. Durata. Il contratto entra in vigore il 1° gennaio 2027 e si rinnova automaticamente per periodi successivi di un anno.

2. Pagamento. Il Cliente pagherà ogni fattura entro 30 giorni. I pagamenti in ritardo comportano interessi di mora del 3% al mese.

3. Recesso. Ciascuna parte può recedere dal contratto con un preavviso di 30 giorni.

4. Limitazione di responsabilità. La responsabilità complessiva del Fornitore non potrà superare i corrispettivi pagati negli ultimi dodici mesi.

5. Manleva. Il Cliente terrà indenne e manleverà il Fornitore da pretese di terzi.

6. Riservatezza. Le parti mantengono riservate le informazioni ricevute.

7. Proprietà intellettuale. I diritti di proprietà intellettuale sui risultati spettano al Cliente.

8. Legge applicabile. Il contratto è regolato dalla legge italiana. Foro competente: Milano.

Firme: ______________`,
};

for (const [lang, text] of Object.entries(CONTRACTS)) {
  test(`U3.12 clause checklist (${lang}): every clause found, renewal and late fee flagged`, () => {
    assert.equal(detectLang(text), lang);
    assert.equal(guessDocType(`contract-${lang}.docx`, text), 'contract');
    const c = clauseChecklist(text, 'contract');
    const st = status(c);
    assert.deepEqual(
      st,
      { parties: 'present', term: 'unusual', payment: 'unusual', termination: 'present', liability_cap: 'present', indemnity: 'present', confidentiality: 'present', ip: 'present', governing_law: 'present', signatures: 'present' },
      `${lang}: ${JSON.stringify(c.items.filter((i) => i.status === 'missing').map((i) => i.id))}`,
    );
    // The quote is the document's own sentence, in its language.
    assert.ok(c.items.find((i) => i.id === 'liability_cap')!.quote!.length > 20);
    // The E6 reader finds the start date (month names in the document's language).
    const facts = extractContract(text);
    assert.ok(facts.dates.some((d) => d.norm === '2027-01-01'), `${lang} dates: ${JSON.stringify(facts.dates.map((d) => d.value))}`);
    assert.ok(facts.flags.some((f) => f.id === 'auto_renewal'), `${lang} flags: ${facts.flags.map((f) => f.id)}`);
  });
}

test('U3.12 clause checklist near-misses: a passing mention is not the clause', () => {
  const es = 'CONTRATO\nEste contrato se celebra entre A Ejemplo S.L. y B Demo S.L.\n\n1. Objeto. El Proveedor asume la responsabilidad de entregar el trabajo a tiempo.\n\n2. Varios. Las partes se comunicarán por correo.';
  const s = status(clauseChecklist(es, 'contract'));
  assert.equal(s.liability_cap, 'missing');
  assert.equal(s.governing_law, 'missing');
  const de = 'VERTRAG\nZwischen A GmbH und B AG.\n\n§ 1 Gegenstand. Der Auftragnehmer erstellt eine Website.\n\n§ 2 Haftung. Die Haftung des Auftragnehmers ist unbeschränkt.';
  const d = clauseChecklist(de, 'contract');
  assert.equal(status(d).liability_cap, 'unusual');
  assert.equal(status(d).term, 'missing');
  // An English contract never matches the German heading words.
  const en = 'AGREEMENT between A LLC and B Inc.\n\n1. Haftungsbegrenzung Partners is the name of the vendor. The vendor builds a website.';
  assert.equal(status(clauseChecklist(en, 'contract')).liability_cap, 'missing');
});

test('U3.12 document kinds and other checklists in each language', () => {
  assert.equal(guessDocType('acuerdo.pdf', 'ACUERDO DE CONFIDENCIALIDAD entre A y B'), 'nda');
  assert.equal(guessDocType('x.pdf', 'Geheimhaltungsvereinbarung zwischen A und B'), 'nda');
  assert.equal(guessDocType('devis.pdf', 'Devis pour la refonte du site'), 'proposal');
  assert.equal(guessDocType('rechnung.pdf', 'Rechnung Nr. 2026-014'), 'invoice');
  assert.equal(guessDocType('fattura.pdf', 'Fattura n. 14 del 3 dicembre 2026'), 'invoice');
  assert.equal(guessDocType('escopo.docx', 'Declaração de trabalho (escopo) entre A e B'), 'sow');

  const letter = 'Paris, le 3 décembre 2026\n\nMadame,\n\nNous vous remercions de votre courrier.\n\nVeuillez agréer, Madame, l’expression de nos salutations distinguées.\nAlex';
  assert.deepEqual(status(clauseChecklist(letter, 'letter')), { date: 'present', greeting: 'present', closing: 'present' });
  const invoice = 'Rechnung Nr. 2026-014\nDatum: 3. Dezember 2026\nGesamtbetrag: 1.200,00 €\nZahlbar bis 17. Dezember 2026.\nBitte überweisen Sie den Betrag per Überweisung auf das unten genannte Konto.';
  assert.deepEqual(status(clauseChecklist(invoice, 'invoice')), { invoice_no: 'present', date: 'present', amount_due: 'present', due_date: 'present', pay_how: 'present' });
  const proposal = 'Preventivo per il nuovo sito\n\nAmbito del lavoro: progettazione e sviluppo del sito.\n\nTempistiche: consegna entro 6 settimane dall’avvio.\n\nPrezzo: 4.800 € IVA esclusa.\n\nIpotesi: il Cliente fornisce testi e immagini.';
  assert.deepEqual(status(clauseChecklist(proposal, 'proposal')), { scope: 'present', timeline: 'present', price: 'present', assumptions: 'present' });
  const nda = 'ACUERDO DE CONFIDENCIALIDAD\nEste acuerdo se celebra entre A Ejemplo S.L. y B Demo S.L.\n\n1. Información confidencial. Las partes mantendrán la confidencialidad de la información.\n\n2. Excepciones. No es confidencial la información de dominio público.\n\n3. Duración. El acuerdo tiene una duración de dos años.\n\n4. Ley aplicable. Se rige por las leyes de España.';
  const n = status(clauseChecklist(nda, 'nda'));
  assert.equal(n.confidentiality, 'present');
  assert.equal(n.exclusions, 'present');
  assert.equal(n.term, 'present');
  assert.equal(n.signatures, 'missing');
});

// ------------------------------------------------------------------ S6 travel emails

const mail = (subject: string, text: string, from = 'Travel <no-reply@travel.example>'): InboxMail => ({ account: 'me@example.com', id: `m-${subject.length}-${text.length}`, from, subject, date: NOW.toISOString(), text });

test('U3.12 dates per locale: month names, dd/mm, 24 h', () => {
  assert.deepEqual(findDate('Salida: 20 de noviembre de 2026, 07:45', NOW, 'es'), { day: '2026-11-20', time: '07:45' });
  assert.deepEqual(findDate('Départ : vendredi 20 novembre 2026 à 07h45', NOW, 'fr'), { day: '2026-11-20', time: '07:45' });
  assert.deepEqual(findDate('Abfahrt: 20.11.2026 um 08:34 Uhr', NOW, 'de'), { day: '2026-11-20', time: '08:34' });
  assert.deepEqual(findDate('Partida: 03/04/2027 às 21:10', NOW, 'pt'), { day: '2027-04-03', time: '21:10' });
  assert.deepEqual(findDate('Partenza: 3 dic 2026 ore 9:05', NOW, 'it'), { day: '2026-12-03', time: '09:05' });
  // English keeps month-first.
  assert.deepEqual(findDate('Departs: 03/04/2027 at 9:10 PM', NOW), { day: '2027-03-04', time: '21:10' });
  assert.deepEqual(findDate('Departs: 03/04/2027 at 9:10 PM', NOW, 'en'), { day: '2027-03-04', time: '21:10' });
});

const FLIGHTS: Record<string, { m: InboxMail; flight: string; from: string; to: string; departs: string; arrives: string; conf: string }> = {
  es: { m: mail('Confirmación de tu reserva', 'Gracias por volar con nosotros.\nLocalizador: QXRTAB\nVuelo IB 3456 MAD → LHR\nSalida: 20 de noviembre de 2026, 07:45\nLlegada: 20 de noviembre de 2026, 09:05\nTarjeta de embarque disponible 24 horas antes.'), flight: 'IB3456', from: 'MAD', to: 'LHR', departs: '2026-11-20T07:45', arrives: '2026-11-20T09:05', conf: 'QXRTAB' },
  fr: { m: mail('Votre réservation est confirmée', 'Merci d’avoir choisi notre compagnie.\nRéférence de réservation : QXRTAC\nVol AF 1234 CDG → NCE\nDépart : vendredi 20 novembre 2026 à 07h45\nArrivée : vendredi 20 novembre 2026 à 09h20'), flight: 'AF1234', from: 'CDG', to: 'NCE', departs: '2026-11-20T07:45', arrives: '2026-11-20T09:20', conf: 'QXRTAC' },
  de: { m: mail('Ihre Buchungsbestätigung', 'Vielen Dank für Ihre Buchung.\nBuchungscode: QXRTAD\nFlug LH 400 FRA → JFK\nAbflug: Fr., 20.11.2026 um 10:55 Uhr\nAnkunft: 20.11.2026 um 13:50 Uhr'), flight: 'LH400', from: 'FRA', to: 'JFK', departs: '2026-11-20T10:55', arrives: '2026-11-20T13:50', conf: 'QXRTAD' },
  pt: { m: mail('Sua reserva está confirmada', 'Obrigado por voar conosco.\nCódigo de reserva: QXRTAE\nVoo LA 3302 GRU → GIG\nPartida: 20/11/2026 às 07:45\nChegada: 20/11/2026 às 08:50\nCartão de embarque disponível no app.'), flight: 'LA3302', from: 'GRU', to: 'GIG', departs: '2026-11-20T07:45', arrives: '2026-11-20T08:50', conf: 'QXRTAE' },
  it: { m: mail('Conferma della prenotazione', 'Grazie per aver scelto la nostra compagnia.\nCodice di prenotazione: QXRTAF\nVolo AZ 1610 FCO → LIN\nPartenza: 20 novembre 2026 ore 07:45\nArrivo: 20 novembre 2026 ore 08:55'), flight: 'AZ1610', from: 'FCO', to: 'LIN', departs: '2026-11-20T07:45', arrives: '2026-11-20T08:55', conf: 'QXRTAF' },
};

for (const [lang, f] of Object.entries(FLIGHTS)) {
  test(`U3.12 travel email (${lang}): the flight booking`, () => {
    const { findings } = classify(f.m, NOW);
    assert.equal(findings.length, 1, JSON.stringify(findings));
    const t = findings[0]!;
    assert.equal(t.kind, 'trip');
    assert.equal(t.confirmation, f.conf);
    assert.deepEqual(t.flights, [{ flight: f.flight, from: f.from, to: f.to, departs: f.departs, arrives: f.arrives }]);
  });
}

test('U3.12 travel email: hotels and trains in other languages', () => {
  const es = classify(mail('Reserva confirmada', 'Su estancia en el Hotel Miramar está confirmada.\nNúmero de reserva: 4471829\nEntrada: 20 de noviembre de 2026\nSalida: 23 de noviembre de 2026\nDirección: 12 Calle Ejemplo, Valencia'), NOW).findings[0];
  assert.equal(es?.kind, 'trip');
  assert.deepEqual(es?.hotel, { name: 'Hotel Miramar', address: '12 Calle Ejemplo, Valencia', checkIn: '2026-11-20', checkOut: '2026-11-23' });
  const fr = classify(mail('Confirmation de votre séjour', 'Votre réservation à l’Hôtel Belle Vue est confirmée.\nArrivée : 20 novembre 2026 à 15h00\nDépart : 23 novembre 2026 à 11h00'), NOW).findings[0];
  assert.deepEqual(fr?.hotel, { name: 'Hôtel Belle Vue', checkIn: '2026-11-20T15:00', checkOut: '2026-11-23T11:00' });
  const pt = classify(mail('Reserva de hospedagem confirmada', 'Sua hospedagem na Pousada Sol Nascente está confirmada.\nCheck-in: 20 de novembro de 2026\nCheck-out: 23 de novembro de 2026'), NOW).findings[0];
  assert.deepEqual(pt?.hotel, { name: 'Pousada Sol Nascente', checkIn: '2026-11-20', checkOut: '2026-11-23' });

  const de = classify(mail('Ihre Fahrkarte', 'Vielen Dank für Ihre Buchung.\nAuftragsnummer: 7Q4K2M\nZug ICE 578 von Berlin Hbf nach München Hbf\nAbfahrt: 20.11.2026 um 08:34\nAnkunft: 20.11.2026 um 12:31'), NOW).findings[0];
  assert.equal(de?.confirmation, '7Q4K2M');
  assert.deepEqual(de?.trains, [{ train: '578', from: 'Berlin Hbf', to: 'München Hbf', departs: '2026-11-20T08:34', arrives: '2026-11-20T12:31' }]);
  const it = classify(mail('Il tuo biglietto', 'Codice di prenotazione: XK4P7T\nTreno Frecciarossa 9541 da Roma Termini a Milano Centrale\nPartenza: 20/11/2026 ore 09:10\nArrivo: 20/11/2026 ore 12:20'), NOW).findings[0];
  assert.deepEqual(it?.trains, [{ train: '9541', from: 'Roma Termini', to: 'Milano Centrale', departs: '2026-11-20T09:10', arrives: '2026-11-20T12:20' }]);
});

test('U3.12 travel email near-misses: offers and chats are not bookings', () => {
  const misses = [
    mail('¡Vuelos a Roma desde 39 €!', 'Ofertas de vuelos a Roma, Lisboa y París. Reserva ya, plazas limitadas. Darse de baja del boletín.'),
    mail('Offres de la semaine', 'Vols vers Nice dès 49 €. Départ possible tous les vendredis. Se désabonner de la newsletter.'),
    mail('Ihr Reise-Newsletter', 'Angebote: Flug nach Rom ab 49 €. Abflug ab Frankfurt, jeden Freitag. Newsletter abbestellen.'),
    mail('Promoções de voos', 'Voos para o Rio a partir de R$ 199. Partida de São Paulo todas as sextas. Cancelar inscrição.'),
    mail('Offerte voli', 'Voli per Milano da 29 €. Partenza da Roma ogni venerdì. Annulla iscrizione alla newsletter.'),
    mail('Re: el viaje', 'Hola, ¿qué tal el vuelo de tu hermana? Llegó bien el viernes, ¿verdad?', 'Ana <ana@example.com>'),
  ];
  for (const m of misses) assert.deepEqual(classify(m, NOW).findings, [], m.subject);
});
