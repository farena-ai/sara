// Receipts are the truth: claims in Sara's reply about actions (writing files, running commands,
// tests, commits, searches) must be backed by a tool receipt from the same turn. Deliberately
// simple and conservative: sentence-level patterns, scoped to work artifacts so ordinary
// conversation ("I wrote you a poem", "I fixed my bike") is not flagged.

import { BROWSER_TOOLS } from './tools/browser.ts';

export interface Receipt {
  name: string;
  status: 'ok' | 'error' | 'denied';
  args: Record<string, unknown>;
  output: string;
}

/**
 * 'send': sent, emailed or replied to a message (Phase 62); 'schedule': put something in a
 * calendar (Phase 62); 'action': found by the optional local judge (any kind of action).
 */
export type ClaimKind = 'write' | 'run' | 'tests_pass' | 'types_clean' | 'commit' | 'web' | 'remind' | 'planner' | 'browser' | 'send' | 'schedule' | 'action';

export interface Claim {
  kind: ClaimKind;
  sentence: string;
  /** "missing": no receipt; "contradicted": a receipt shows the opposite (e.g. tests failed). */
  problem: 'missing' | 'contradicted';
}

const ARTIFACT =
  /\b(files?|folders?|director(?:y|ies)|scripts?|code|functions?|class(?:es)?|modules?|tests?|specs?|repo(?:sitory)?|branch(?:es)?|commits?|readme|config|package\.json|bugs?|project|workspace|changes?|patch|feature|endpoint|component|[\w-]+\.(?:js|ts|tsx|jsx|py|md|txt|json|ya?ml|toml|sh|css|html|go|rs|java|rb|php|c|cpp|h|sql))\b/i;
const WRITE_VERB = /\b(?:I(?:'ve| have)?|I just|I've just|I went ahead and)\s+(?:also\s+)?(created|wrote|written|saved|added|updated|edited|modified|changed|fixed|deleted|removed|renamed|implemented|refactored|patched)\b/i;
const RUN_VERB = /\b(?:I(?:'ve| have)?|I just)\s+(?:also\s+)?(ran|run|executed|re-ran|reran|tested|built|installed)\b/i;
const TESTS_PASS = /\b(?:all\s+(?:the\s+)?|the\s+)?tests?\s+(?:are\s+|now\s+)*(?:pass(?:ing|ed|es)?|green|succeed(?:ed|ing)?)\b|\beverything (?:passes|passed|is passing|works now)\b/i;
const COMMIT = /\b(?:I(?:'ve| have)?|I just)\s+(?:also\s+)?(committed|pushed|merged|tagged)\b|\b(?:changes|work|fix(?:es)?)\s+(?:are|is|have been|has been)\s+(?:now\s+)?(committed|pushed)\b/i;
const WEB = /\b(?:I(?:'ve| have)?|I just)\s+(?:also\s+)?(searched|googled|looked (?:it )?up online|checked online|fetched|browsed)\b/i;
const REMIND = /\b(?:I(?:'ll| will|'ve| have)?|I just)\s+(?:also\s+)?(?:set (?:up )?(?:a |the |your |that )?reminders?|remind you|make sure to remind you|ping you)\b|\breminders? (?:is|are|has been|have been|'s) (?:all |now )?set\b|\bI(?:'ve| have)? (?:scheduled|set) (?:it|that|one)\b/i;
const PLANNER = /\b(?:I(?:'ve| have)?|I just)\s+(?:also\s+)?(?:added|put|saved|wrote|written|jotted|noted|marked|checked off|crossed off|ticked off)\b[^.!?]*\b(to-?do|to do list|task|tasks|list|planner|notes?|done|complete)\b/i;
/**
 * Phase 49: "I tested it in the browser", "I checked it on my phone width", "I took a screenshot",
 * "I clicked through it": only true when her testing-browser tools ran in this turn.
 */
const BROWSER = /\b(?:I(?:'ve| have)?|I just)\s+(?:also\s+)?(?:(?:tested|checked|tried|opened|viewed|looked at|clicked (?:through|around)|went through|previewed)\b[^.!?]{0,80}\b(?:in (?:the |a |my )?(?:testing )?browser|in the preview|(?:at|on) (?:a |the )?(?:phone|mobile|desktop)(?: width| size| screen)?|phone width|mobile width|on (?:a )?(?:small|narrow) screens?)|(?:took|taken|grabbed) (?:a |some )?screenshots?|clicked (?:through|around)(?: (?:it|the app|the page))?)\b/i;
const SCREENSHOT = /\b(?:I(?:'ve| have)?|I just)\s+(?:also\s+)?(?:took|taken|grabbed) (?:a |some |two |both )?screenshots?\b|\b(?:the |my )?screenshots? (?:show|shows|showed|confirm|confirms)\b/i;

/**
 * Phase 120 (PRECISE §4.11): "it compiles", "no type errors", "the types check", in the six
 * languages: checked against the turn's last check of her edits (a `diagnostics` receipt).
 */
const TYPES_CLEAN = /\b(?:it|everything|the code|this|that|the project)\s+(?:now\s+)?(?:compiles|type-?checks|builds without (?:type )?errors)\b|\bno (?:more )?type errors\b|\bthe types (?:now )?(?:check|pass)\b|\btypes? (?:are|is) (?:now )?clean\b|\b(?:ya )?compila\b|\bsin errores de tipos?\b|\bça compile\b|\bplus d'erreurs? de type\b|\bkompiliert (?:jetzt|wieder)?\b|\bkeine typfehler\b|\bsem erros de tipo\b|\bnessun errore di tipo\b|\bcompila (?:ora|adesso)\b/i;

/** Past-turn references are allowed: those receipts live in earlier turns. */
const EARLIER = /\b(earlier|before|previously|last time|yesterday|already|this morning|the other day|in our last)\b/i;
const NEGATED = /\b(didn't|did not|haven't|have not|couldn't|could not|wasn't able|won't|can't|cannot|not yet|failed to|unable to)\b/i;

// Phase 28: the same claims in Spanish, French, German, Portuguese and Italian. Unicode-aware word
// edges (see safety.ts `words`); German puts the verb last ("ich habe die Datei erstellt").
const w = (src: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${src})(?![\\p{L}\\p{N}])`, 'iu');
const I18N = {
  artifact: w(
    'archivos?|ficheros?|carpetas?|código|scripts?|pruebas?|tests?|repositorio|rama|commits?|proyecto|cambios|fichiers?|dossiers?|code|répertoire|dépôt|branche|projet|modifications?|datei(?:en)?|ordner|skript|tests?|repo|zweig|projekt|änderungen|arquivos?|pastas?|testes?|repositório|projeto|alterações|mudanças|file|cartelle?|codice|progetto|modifiche|[\\w-]+\\.(?:js|ts|py|md|txt|json|ya?ml|sh|css|html)',
  ),
  write: w(
    'he (?:creado|escrito|guardado|añadido|actualizado|editado|modificado|cambiado|corregido|arreglado|borrado|eliminado|renombrado|implementado)|creé|escribí|guardé|actualicé|corregí|arreglé|borré|eliminé|' +
      "j'ai (?:créé|écrit|enregistré|ajouté|mis à jour|modifié|changé|corrigé|supprimé|renommé|implémenté)|" +
      'ich habe[^.!?]{0,60}(?:erstellt|geschrieben|gespeichert|hinzugefügt|aktualisiert|bearbeitet|geändert|behoben|repariert|gelöscht|entfernt|umbenannt|implementiert)|' +
      'criei|escrevi|salvei|adicionei|atualizei|editei|modifiquei|alterei|corrigi|consertei|apaguei|deletei|removi|renomeei|implementei|' +
      'ho (?:creato|scritto|salvato|aggiunto|aggiornato|modificato|cambiato|corretto|sistemato|cancellato|eliminato|rinominato|implementato)',
  ),
  run: w(
    'he (?:ejecutado|corrido|probado|compilado|instalado)|ejecuté|corrí|compilé|instalé|' +
      "j'ai (?:lancé|exécuté|testé|compilé|installé)|" +
      'ich habe[^.!?]{0,60}(?:ausgeführt|gestartet|getestet|gebaut|kompiliert|installiert)|' +
      'executei|rodei|testei|compilei|instalei|' +
      'ho (?:eseguito|lanciato|testato|compilato|installato)',
  ),
  tests: w(
    '(?:todas )?las pruebas (?:ya )?pasan|los tests pasan|todo pasa|' +
      'les tests passent|tous les tests passent|tout passe|' +
      'alle tests (?:sind grün|bestehen|laufen durch)|die tests (?:sind grün|bestehen|laufen durch)|' +
      'os testes passam|todos os testes passam|' +
      'i test passano|tutti i test passano',
  ),
  commit: w(
    'he hecho (?:el )?(?:commit|push)|hice (?:el )?(?:commit|push)|he subido los cambios|' +
      "j'ai (?:commité|poussé|fusionné|fait (?:le |un )?commit)|" +
      'ich habe[^.!?]{0,60}(?:committet|commited|gepusht|gemergt|hochgeladen)|' +
      'fiz (?:o )?(?:commit|push)|' +
      'ho fatto (?:il )?(?:commit|push)|ho pushato',
  ),
  web: w(
    'he buscado|busqué (?:en internet|en la web|online)|' +
      "j'ai (?:cherché|recherché) (?:sur internet|en ligne|sur le web)|" +
      'ich habe[^.!?]{0,60}(?:gegoogelt|im internet gesucht|online nachgesehen)|' +
      'pesquisei|procurei na internet|' +
      'ho cercato (?:su internet|online|sul web)',
  ),
  remind: w(
    'te lo recordaré|te recordaré|he puesto un recordatorio|recordatorio (?:está )?(?:listo|puesto)|' +
      "je te le rappellerai|je te rappellerai|j'ai (?:mis|programmé|créé) un rappel|rappel (?:est )?(?:programmé|créé)|" +
      'ich erinnere dich|ich habe[^.!?]{0,40}erinnerung[^.!?]{0,20}(?:gesetzt|eingerichtet|erstellt)|erinnerung (?:ist )?gesetzt|' +
      'vou te lembrar|eu te lembro|criei um lembrete|lembrete (?:está )?(?:criado|definido|marcado)|' +
      'te lo ricorderò|ti ricorderò|ho (?:impostato|creato|messo) un promemoria|promemoria (?:è )?impostato',
  ),
  planner: w(
    '(?:he añadido|añadí|he apuntado|apunté|he marcado|marqué)[^.!?]{0,60}(?:lista|tareas?|notas?|hecho)|' +
      "(?:j'ai ajouté|j'ai noté|j'ai coché)[^.!?]{0,60}(?:liste|tâches?|notes?|fait)|" +
      'ich habe[^.!?]{0,60}(?:liste|aufgabe|notiz)[^.!?]{0,30}(?:hinzugefügt|eingetragen|abgehakt|notiert)|' +
      '(?:adicionei|anotei|marquei)[^.!?]{0,60}(?:lista|tarefas?|notas?|feito)|' +
      '(?:ho aggiunto|ho segnato|ho annotato)[^.!?]{0,60}(?:lista|attività|compiti|note|fatto)',
  ),
  // Not "ya", "já" or "schon": too common as fillers ("ya quedó" = "done").
  earlier: w('antes|ayer|esta mañana|la otra vez|avant|hier|déjà|ce matin|la dernière fois|vorhin|gestern|bereits|heute morgen|letztes mal|ontem|hoje de manhã|da última vez|prima|ieri|già|stamattina|l\'ultima volta'),
  negated: w("no he|no pude|no lo|todavía no|aún no|je n'ai pas|je n'ai rien|pas encore|je ne peux pas|nicht|kein(?:e|en)?|noch nicht|não|ainda não|non ho|non sono riuscit[oa]|non ancora|non posso"),
};

// Phase 62: smarter checks in every language. More verb forms per language (clitics like "je l'ai",
// "lo guardé", "l'ho salvato"; German verb-last and inverted order, "hab"; "acabo de", "je viens
// de", "acabei de", "ho appena"; passives like "quedaron guardadas", "sont enregistrées", "foram
// salvas", "sind gespeichert"), two new kinds (sent / emailed / replied, and calendar entries),
// and negation scoped to the clause that holds the verb ("I created it, nothing failed" is still a
// claim). These only ever ADD flags: every Phase 28 pattern above still applies as before.
const ART2 = w(
  'errors?|errores?|fallos?|bugs?|fehlers?|erreurs?|erros?|errori|errore|imports?|importaciones|importações|importe|dependencies|dependencias|dépendances|abhängigkeiten|dependências|dipendenze|readme|cartell[ae]|backups?|notizen|notas|note|configs?|login|[\\w./-]+/[\\w./-]+',
);
/** Something one sends (an email, a message, a comment) or "by email". */
const SEND_OBJ = w(
  'e-?mails?|mails?|correos?|courriels?|messages?|mensajes?|nachrichten?|mensage(?:m|ns)|messaggi[oa]?|invit(?:e|ation|ación|ación|o|e)s?|einladung(?:en)?|convites?|comments?|comentarios?|commentaires?|kommentare?|comentários?|comment[oi]|issues?|pull requests?|prs?|respuestas?|réponses?|antwort(?:en)?|respostas?|rispost[ae]|por correo|par e-?mail|par mail|per mail|por e-?mail|via e-?mail',
);
/** Something one puts in a calendar. */
const CAL_OBJ = w(
  'calendars?|calendario|calendrier|kalender|calendário|agenda|agendas|appointments?|meetings?|citas?|reuni(?:ón|ones)|rendez-vous|réunions?|termine?s?|besprechung(?:en)?|consultas?|reuni(?:ão|ões)|compromissos?|appuntament[oi]|riunion[ei]',
);
const DE_HAVE = '(?:ich (?:habe|hab)|(?:habe|hab) ich|^(?:habe|hab)|^(?:gerade|eben|grad) (?:habe|hab))';
const MORE: Partial<Record<ClaimKind, RegExp[]>> = {
  write: [
    /\b(?:has|have) been (?:created|saved|written|updated|deleted|removed|renamed|added|fixed|changed|modified)\b|\b(?:is|are) (?:now )?(?:saved|created|deleted|updated)\b/i,
    w(
      '(?:(?:lo|la|los|las|le|les|te) )?he (?:creado|escrito|guardado|añadido|agregado|actualizado|editado|modificado|cambiado|corregido|arreglado|borrado|eliminado|renombrado|implementado|movido)|' +
        'agregué|añadí|edité|modifiqué|cambié|renombré|implementé|moví|' +
        'acabo de (?:crear|escribir|guardar|añadir|agregar|actualizar|editar|modificar|cambiar|corregir|arreglar|borrar|eliminar|renombrar|implementar)|' +
        '(?:quedó|quedaron|ha quedado|han quedado|está|están|ha sido|han sido|fue|fueron) (?:ya )?(?:guardad|cread|actualizad|borrad|eliminad|escrit|modificad|corregid|renombrad)[oa]s?',
    ),
    w(
      "(?:j'|je (?:l'|les |t'|lui |leur |vous ))ai (?:bien |aussi |déjà |enfin )?(?:créée?s?|écrite?s?|enregistrée?s?|sauvegardée?s?|ajoutée?s?|mise? à jour|modifiée?s?|changée?s?|corrigée?s?|supprimée?s?|effacée?s?|renommée?s?|implémentée?s?|déplacée?s?)|" +
        'je viens de (?:créer|écrire|enregistrer|sauvegarder|ajouter|mettre à jour|modifier|changer|corriger|supprimer|effacer|renommer|implémenter)|' +
        '(?:est|sont|a été|ont été) (?:bien |maintenant )?(?:créée?s?|enregistrée?s?|sauvegardée?s?|mise?s? à jour|supprimée?s?|modifiée?s?|corrigée?s?|renommée?s?)',
    ),
    w(
      `${DE_HAVE}.{0,90}?(?:erstellt|angelegt|geschrieben|gespeichert|abgespeichert|hinzugefügt|ergänzt|aktualisiert|bearbeitet|geändert|angepasst|behoben|repariert|korrigiert|gefixt|gelöscht|entfernt|umbenannt|implementiert|verschoben|eingebaut|überarbeitet)|` +
        '(?:ist|sind|wurde|wurden)(?: [^ ]+){0,6}? (?:jetzt |nun )?(?:gespeichert|abgespeichert|erstellt|angelegt|gelöscht|entfernt|aktualisiert|geändert|umbenannt)',
    ),
    w(
      'gravei|excluí|acabei de (?:criar|escrever|salvar|gravar|adicionar|atualizar|editar|modificar|alterar|corrigir|consertar|apagar|excluir|remover|renomear|implementar)|' +
        '(?:foi|foram|está|estão|ficou|ficaram) (?:já )?(?:salv|criad|atualizad|apagad|excluíd|gravad|corrigid|removid|alterad|renomead)[oa]s?',
    ),
    w(
      "(?:(?:l'|li |le |lo |ti |gli |vi )?ho|abbiamo) (?:appena |già |anche |finalmente )?(?:creat|scritt|salvat|aggiunt|aggiornat|modificat|cambiat|corrett|sistemat|cancellat|eliminat|rimoss|rinominat|implementat|spostat)[oaie]|" +
        '(?:è|sono) (?:stat[oaie] )?(?:salvat|creat|aggiornat|cancellat|eliminat|scritt|modificat|corrett|rinominat)[oaie]',
    ),
  ],
  run: [
    w(
      'he (?:lanzado|vuelto a ejecutar)|lancé|acabo de (?:ejecutar|correr|probar|lanzar|compilar|instalar)|' +
        "(?:j'|je (?:l'|les ))ai (?:re)?(?:lancée?s?|exécutée?s?|testée?s?|compilée?s?|installée?s?)|je viens de (?:lancer|exécuter|tester|compiler|installer)|" +
        `${DE_HAVE}.{0,90}?(?:ausgeführt|gestartet|laufen lassen|getestet|gebaut|kompiliert|installiert)|` +
        'acabei de (?:rodar|executar|testar|compilar|instalar)|' +
        "(?:l'|li |le |lo )?ho (?:appena |già )?(?:eseguit|lanciat|testat|compilat|installat)[oaie]",
    ),
  ],
  tests_pass: [
    w(
      'todas pasan|pasan todas|pasan las \\d+|las pruebas están en verde|todos (?:os testes )?passam|passam todos|passaram todos|os testes estão verdes|' +
        'tous les tests sont verts|les \\d+ passent|' +
        'laufen alle tests durch|alle tests laufen durch|tests (?:sind|waren) (?:alle )?grün|alle (?:\\d+ )?(?:tests )?(?:bestehen|sind grün)|bestehen alle|' +
        'passano tutti|tutti (?:e \\d+ )?passano|i test sono verdi',
    ),
  ],
  commit: [
    /\b(?:changes|commits?|fix(?:es)?|branch)\b[^.!?]{0,40}\b(?:committed and pushed|pushed)\b/i,
    w(
      'he subido|subí los cambios|(?:están|está|fueron|fue) (?:ya )?(?:subidos?|commiteados?)|' +
        '(?:sont|est|ont été|a été) (?:bien )?(?:commitée?s?|poussée?s?|pushée?s?)|' +
        `${DE_HAVE}.{0,90}?(?:committet|commitet|gepusht|gepushed|gemergt)|(?:sind|ist|wurden|wurde)(?: [^ ]+){0,4}? (?:committet|gepusht)|` +
        'commitei|(?:foi|foram|estão|está) (?:já )?(?:commitad|pushad)[oa]s?|' +
        '(?:sono|è) (?:stat[oaie] )?(?:committat|pushat)[oaie]|ho committato',
    ),
  ],
  web: [
    w(
      'lo busqué|la busqué|he buscado|busqué en (?:internet|la web|google)|' +
        "j'ai (?:cherché|recherché|regardé) (?:sur internet|en ligne|sur le web|sur google)|" +
        `${DE_HAVE}.{0,90}?(?:online|im internet|im netz|im web).{0,30}?(?:nachgesehen|nachgeschaut|gesucht|recherchiert)|${DE_HAVE}.{0,60}?gegoogelt|` +
        'pesquisei|procurei (?:na internet|online|no google)|' +
        'ho cercato (?:su internet|online|sul web|su google)',
    ),
  ],
  planner: [
    // German compounds (Einkaufsliste, Aufgabenliste) have no word edge before "liste".
    new RegExp(`${DE_HAVE}.{0,90}?(?:liste|aufgabe|notiz|to-?do)[\\p{L}]*.{0,40}?(?:gesetzt|hinzugefügt|eingetragen|abgehakt|notiert|geschrieben|aufgeschrieben)`, 'iu'),
  ],
  remind: [
    w(
      '(?:te |le )?(?:puse|he puesto|he creado|creé|dejé) un recordatorio|' +
        "(?:je t'ai|j'ai|je vous ai) (?:mis|programmé|créé|réglé) un rappel|" +
        `${DE_HAVE}.{0,60}?erinnerung.{0,40}?(?:gesetzt|eingerichtet|erstellt|gestellt|angelegt)|` +
        '(?:coloquei|criei|pus|deixei|programei) um lembrete|' +
        '(?:ti )?ho (?:messo|impostato|creato|programmato) un promemoria',
    ),
  ],
};
/** Kinds with their own receipts (Phase 62); a verb plus the right kind of object. */
const SEND_VERB = [
  /\bI(?:'ve| have)?\s+(?:just\s+|also\s+|already\s+)?(?:sent|forwarded|replied to|answered|posted|wrote back to|messaged)\b/i,
  w(
    '(?:(?:le|te|les|se lo|se la) )?(?:he enviado|he mandado|he reenviado|he respondido|he contestado|envié|mandé|reenvié|respondí|contesté)|' +
      "(?:j'|je (?:l'|les |lui |leur |t'|vous ))ai (?:envoyée?s?|renvoyée?s?|transférée?s?|répondu|écrit)|" +
      `${DE_HAVE}.{0,90}?(?:geschickt|verschickt|gesendet|gesandt|weitergeleitet|geantwortet|geschrieben)|` +
      'enviei|mandei|encaminhei|respondi|reenviei|' +
      "(?:(?:l'|li |le |gli |ti )?ho) (?:appena |già )?(?:inviat|mandat|spedit|inoltrat|scritt)[oaie]|ho risposto",
  ),
];
const SEND_ALONE = /\bI(?:'ve| have)?\s+(?:just\s+|also\s+|already\s+)?(?:e-?mailed|emailed)\b/i;
const SCHEDULE_VERB = [
  /\bI(?:'ve| have)?\s+(?:just\s+|also\s+)?(?:scheduled|booked|put|added|blocked(?: out)?|entered|set up)\b/i,
  w(
    '(?:(?:te|le|les|lo|la) )?(?:he agendado|agendé|he programado|programé|he reservado|reservé|puse|he puesto|añadí|he añadido|agregué|he agregado|apunté|he apuntado)|' +
      "(?:j'|je (?:l'|les |t'|lui |vous ))ai (?:programmée?s?|planifiée?s?|calée?s?|réservée?s?|mise?s?|ajoutée?s?|notée?s?|inscrite?s?|bloquée?s?)|" +
      `${DE_HAVE}.{0,90}?(?:eingetragen|eingeplant|geplant|gebucht|reserviert|terminiert|geblockt|gelegt)|` +
      'agendei|marquei|coloquei|reservei|programei|adicionei|' +
      "(?:(?:l'|ti |gli |le )?ho) (?:appena |già )?(?:fissat|programmat|pianificat|prenotat|mess|aggiunt|segnat|inserit)[oaie]",
  ),
];
const SCHEDULE_ALONE = w('he agendado|agendé|agendei');
/** Phase 62: "tested it in the browser / at phone width", "took a screenshot", in five more languages. */
const BROWSER_I18N = w(
  '(?:probé|he probado|lo probé|testé|abrí|revisé|lo he probado).{0,80}?(?:navegador|vista previa|ancho de móvil|en el móvil)|(?:hice|he hecho|tomé) (?:una |unas )?capturas?|' +
    "(?:j'ai|je l'ai) (?:testé|essayé|ouvert|vérifié|regardé).{0,80}?(?:navigateur|aperçu|largeur (?:de )?téléphone|sur mobile)|(?:j'ai|je l'ai) (?:fait|pris) (?:une |des )?captures?|" +
    `${DE_HAVE}.{0,90}?(?:im browser|in der vorschau|handybreite|auf dem handy|mobil).{0,40}?(?:getestet|angesehen|ausprobiert|geöffnet|geprüft)|${DE_HAVE}.{0,40}?screenshots? (?:gemacht|erstellt)|` +
    '(?:testei|abri|verifiquei|olhei).{0,80}?(?:navegador|pré-visualização|largura de celular|no celular)|(?:tirei|fiz) (?:um |uns )?(?:print|captura)s?|' +
    "(?:(?:l'|lo |la )?ho) (?:provat|testat|apert|controllat)[oaie].{0,80}?(?:browser|anteprima|larghezza (?:del )?telefono|sul telefono)|ho fatto (?:uno |degli )?screenshot",
);
/** E3: which width a claim names, in the six languages ("at phone width", "en el móvil", "auf dem Desktop"). */
const PHONE = w('phones?|mobile|small screens?|narrow screens?|móvil|celular|téléphone|handy(?:breite)?|mobil|telefono');
const DESKTOP = w('desktop|escritorio|ordinateur|computador');
/** E3: present-tense "fixed / looks right now" in the six languages; needs a browser look after the last edit. */
const FIXED_NOW = [
  /\b(?:I(?:'ve| have)?|I just)\s+(?:also\s+)?fixed\b|\b(?:it's|it is|that's|that is|is|are)\s+(?:now\s+)?fixed\b|\b(?:looks?|fits?|works?)\s+(?:(?:right|good|fine|correct|properly)\s+)?now\b|\bnow (?:looks|fits|works)\b/i,
  w("arreglad[oa]s?|corregid[oa]s?|se ve bien|corrigée?s?|réparée?s?|s'affiche bien|behoben|repariert|korrigiert|sieht (?:jetzt )?gut aus|corrigid[oa]s?|consertad[oa]s?|sistemat[oa]|corrett[oa]|risolt[oa]"),
];
/** E3: phone = "phone"/"mobile" or an explicit width up to 480 px; desktop = the default, "desktop" or 1024 px and up. */
export function shotWidth(r: Receipt): 'phone' | 'desktop' | undefined {
  const v = r.args.width;
  if (v === undefined || v === null || v === '' || v === 'desktop') return 'desktop';
  if (v === 'phone' || v === 'mobile') return 'phone';
  const n = Number(String(v).replace(/px$/i, ''));
  if (!Number.isFinite(n)) return undefined;
  return n <= 480 ? 'phone' : n >= 1024 ? 'desktop' : undefined;
}
/** Clause edges: punctuation and "but" words; negation counts only in the verb's own clause. */
const CLAUSE = /\s*[,;:–—]\s*|\s+-\s+|\s+(?:but|however|pero|aunque|sin embargo|mais|cependant|aber|jedoch|doch|mas|porém|però|ma)\s+/i;
/** Read-only tools: they never back an action claim. */
const READ_ONLY = /^(?:read_file|list_dir|search|web_search|web_fetch|gmail_read|gmail_search|gmail_thread|gmail_needs_answer|calendar_events|github_list|github_read|home_status|job_status|browser_read|recall|find|ssh_servers)$/;

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
/** Phase 73: a command on one of the owner's servers counts like her shell; these change her server list. */
const COMMAND_TOOLS = new Set(['shell', 'ssh_run']);
const SSH_CHANGE = new Set(['ssh_connect', 'ssh_revoke_key', 'ssh_remove_server', 'ssh_forget_password']);

/**
 * The reply with things that aren't her own claims taken out (Phase 62): code blocks, block
 * quotes, inline code with spaces, and quoted text of three words or more (a quoted example like
 * «I've sent it» is not a claim). Typographic apostrophes become plain ones.
 */
export function visibleText(text: string): string {
  return text
    .replace(/[\u2019\u02bc]/g, "'")
    .replace(/(`{3,}|~{3,})[\s\S]*?\1/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/`[^`\n]*\s[^`\n]*`/g, ' ')
    .replace(/"([^"\n]{1,400})"|“([^”\n]{1,400})”|„([^“”\n]{1,400})[“”]|«([^»\n]{1,400})»|‹([^›\n]{1,400})›/g, (m: string, ...g: (string | undefined)[]) => {
      const inner = g.slice(0, 5).find((x) => typeof x === 'string') ?? '';
      return inner.trim().split(/\s+/).length >= 3 ? ' ' : m;
    });
}

function sentences(text: string): string[] {
  return visibleText(text)
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when a pattern matches a clause with no negation in it, or (as before) the whole sentence with none. */
function claimed(s: string, res: RegExp | RegExp[]): boolean {
  const list = Array.isArray(res) ? res : [res];
  const neg = (x: string) => NEGATED.test(x) || I18N.negated.test(x);
  if (list.some((r) => r.test(s)) && !neg(s)) return true;
  return s.split(CLAUSE).some((c) => c && !neg(c) && list.some((r) => r.test(c)));
}

function exitCode(output: string): number | null {
  const m = output.match(/^\[exit code (\d+)/);
  return m ? Number(m[1]) : null;
}

/** File-ish names in a sentence ("eval-note.txt", "src/app.ts"). */
const NAMES = /[\w./-]+\.[A-Za-z]{1,5}\b/g;

/**
 * True if an earlier receipt in this conversation names the same file/artifact the sentence
 * names. Lets Sara truthfully recap earlier work ("tonight I created eval-note.txt") without
 * letting a vague claim ride on unrelated old receipts.
 */
function priorSupports(sentence: string, prior: Receipt[], kinds: (r: Receipt) => boolean): boolean {
  const names = [...new Set(sentence.match(NAMES) ?? [])].map((n) => n.toLowerCase()).filter((n) => !/^(e\.g|i\.e|etc)\b/.test(n));
  if (!names.length) return false;
  return prior.some((r) => r.status === 'ok' && kinds(r) && names.some((n) => JSON.stringify(r.args).toLowerCase().includes(n)));
}

/** What this turn's receipts can back, per kind of claim. */
function backing(receipts: Receipt[]) {
  const ok = receipts.filter((r) => r.status === 'ok');
  const shells = ok.filter((r) => COMMAND_TOOLS.has(r.name));
  const mcp = ok.some((r) => r.name.startsWith('mcp_'));
  const cmd = (r: Receipt) => String(r.args.command ?? '');
  return {
    ok,
    shells,
    hasWrite: ok.some((r) => WRITE_TOOLS.has(r.name) || SSH_CHANGE.has(r.name)) || mcp || shells.length > 0,
    hasRun: shells.length > 0 || mcp,
    hasCommit: ok.some((r) => r.name === 'git_commit' || r.name === 'git_push') || shells.some((r) => /\bgit\b[\s\S]*\b(commit|push|merge|tag)\b/.test(cmd(r)) && exitCode(r.output) === 0),
    hasWeb: ok.some((r) => r.name === 'web_search' || r.name === 'web_fetch'),
    hasRemind: ok.some((r) => r.name === 'remind' && String(r.args.action) === 'set'),
    hasPlanner: ok.some((r) => r.name === 'todo' || r.name === 'note') || mcp,
    hasBrowser: ok.some((r) => BROWSER_TOOLS.has(r.name)),
    hasShot: ok.some((r) => r.name === 'browser_screenshot'),
    // E3: the widths her screenshots were taken at, and whether she looked again after her last edit:
    shotAt: new Set(ok.filter((r) => r.name === 'browser_screenshot').map(shotWidth)),
    // A screenshot (at that width, when one is named) or a passing browser_check after the last edit.
    lookedAfterEdit: (width?: 'phone' | 'desktop') => {
      const last = (f: (r: Receipt) => boolean) => receipts.findLastIndex((r) => r.status === 'ok' && f(r));
      return last((r) => (r.name === 'browser_screenshot' && (!width || shotWidth(r) === width)) || (!width && r.name === 'browser_check' && !/^FAIL\b/m.test(r.output))) > last((r) => WRITE_TOOLS.has(r.name));
    },
    // Phase 62: sending (mail, a GitHub comment / issue / pull request, an MCP tool, a mail command).
    hasSend: mcp || ok.some((r) => r.name === 'gmail_send' || r.name === 'github_comment' || r.name === 'github_create_issue' || r.name === 'github_open_pr') || shells.some((r) => /\b(?:mail|sendmail|msmtp|mutt|curl|gh)\b/.test(cmd(r))),
    // Phase 62: a calendar entry (or a reminder set for it).
    hasSchedule: mcp || ok.some((r) => r.name === 'calendar_add' || (r.name === 'remind' && String(r.args.action) === 'set')),
    // Anything that did something (not just reading) backs the judge's generic "action".
    hasAny: ok.some((r) => !READ_ONLY.test(r.name)),
    typeChecks: receipts.filter((r) => r.name === 'diagnostics'),
    testRuns: shells.filter((r) => /\b(test|jest|vitest|pytest|mocha|go test|cargo test|npm t\b|node --test|make check|npm run check)\b/i.test(cmd(r))),
  };
}

const isQuestion = (s: string) => /[?¿]\s*$/.test(s) || /^\s*¿/.test(s);
const isEarlier = (s: string) => EARLIER.test(s) || I18N.earlier.test(s);

export function checkClaims(reply: string, receipts: Receipt[], prior: Receipt[] = []): Claim[] {
  const b = backing(receipts);
  const claims: Claim[] = [];
  const seen = new Set<string>();
  const add = (kind: ClaimKind, sentence: string, problem: Claim['problem']) => {
    const key = `${kind}:${sentence}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims.push({ kind, sentence, problem });
  };
  const priorWrite = (s: string) => priorSupports(s, prior, (r) => WRITE_TOOLS.has(r.name) || r.name === 'shell');
  const priorRun = (s: string) => priorSupports(s, prior, (r) => r.name === 'shell' || r.name.startsWith('mcp_'));

  for (const s of sentences(reply)) {
    // Earlier work and questions are fine; a negation only clears the clause it is in (Phase 62).
    if (isEarlier(s) || isQuestion(s)) continue;
    const artifact = ARTIFACT.test(s) || I18N.artifact.test(s) || ART2.test(s);
    if (artifact && !b.hasWrite && !priorWrite(s) && claimed(s, [WRITE_VERB, I18N.write, ...MORE.write!])) add('write', s, 'missing');
    if (artifact && !b.hasRun && !priorRun(s) && claimed(s, [RUN_VERB, I18N.run, ...MORE.run!])) add('run', s, 'missing');
    if (claimed(s, [TESTS_PASS, I18N.tests, ...MORE.tests_pass!])) {
      if (!b.testRuns.length && !b.hasRun) add('tests_pass', s, 'missing');
      else if (b.testRuns.length && exitCode(b.testRuns.at(-1)!.output) !== 0) add('tests_pass', s, 'contradicted');
    }
    // Phase 120: "it compiles now" while the last check of her edits had errors left.
    if (b.typeChecks.length && TYPES_CLEAN.test(s) && !NEGATED.test(s) && b.typeChecks.at(-1)!.status === 'error') add('types_clean', s, 'contradicted');
    if (!b.hasCommit && claimed(s, [COMMIT, I18N.commit, ...MORE.commit!])) add('commit', s, 'missing');
    if (!b.hasWeb && claimed(s, [WEB, I18N.web, ...MORE.web!])) add('web', s, 'missing');
    const remind = claimed(s, [REMIND, I18N.remind, ...MORE.remind!]);
    const schedule = !remind && ((SCHEDULE_ALONE.test(s) && claimed(s, SCHEDULE_ALONE)) || (CAL_OBJ.test(s) && claimed(s, SCHEDULE_VERB)));
    if (remind && !b.hasRemind) add('remind', s, 'missing');
    else if (schedule) {
      if (!b.hasSchedule) add('schedule', s, 'missing');
    } else if (!remind && !b.hasPlanner && !b.hasWrite && claimed(s, [PLANNER, I18N.planner, ...MORE.planner!])) add('planner', s, 'missing');
    if (!b.hasSend && ((SEND_OBJ.test(s) && claimed(s, SEND_VERB)) || claimed(s, SEND_ALONE))) add('send', s, 'missing');
    if ((claimed(s, SCREENSHOT) && !b.hasShot) || (claimed(s, [BROWSER, BROWSER_I18N]) && !b.hasBrowser)) add('browser', s, 'missing');
    // E3: a phone or desktop claim needs a screenshot at that width; "fixed / looks right now" in web
    // work (browser tools ran) needs a screenshot or a passing browser_check after the last edit.
    if (claimed(s, [SCREENSHOT, BROWSER, BROWSER_I18N]) && ((PHONE.test(s) && !b.shotAt.has('phone')) || (DESKTOP.test(s) && !b.shotAt.has('desktop')))) add('browser', s, 'missing');
    if (b.hasBrowser && claimed(s, FIXED_NOW)) {
      const width = PHONE.test(s) ? 'phone' : DESKTOP.test(s) ? 'desktop' : undefined;
      if (!b.lookedAfterEdit() || (width && !b.lookedAfterEdit(width))) add('browser', s, 'missing');
    }
  }
  return claims;
}

/** Phase 28: the claim judge's labels, as claim kinds. */
export const JUDGE_KINDS: Record<string, ClaimKind> = { FILE: 'write', RUN: 'run', COMMIT: 'commit', WEB: 'web', REMINDER: 'remind', LIST: 'planner' };

/**
 * For the claim judge: is a sentence it picked really a claim this turn's receipts don't back?
 * Uses the same rules as `checkClaims` (earlier work, negations, questions are fine; a shell
 * command can back anything but a commit or passing tests).
 */
export function judgedClaim(sentence: string, kind: ClaimKind, receipts: Receipt[], prior: Receipt[] = []): Claim | undefined {
  if (EARLIER.test(sentence) || NEGATED.test(sentence) || I18N.earlier.test(sentence) || I18N.negated.test(sentence) || /\?\s*$/.test(sentence)) return undefined;
  return isBacked(sentence, kind, receipts, prior) ? undefined : { kind, sentence, problem: 'missing' };
}

/** Does a tool in this turn (or an earlier one naming the same file) back this kind of claim? */
function isBacked(sentence: string, kind: ClaimKind, receipts: Receipt[], prior: Receipt[]): boolean {
  const ok = receipts.filter((r) => r.status === 'ok');
  const shell = ok.some((r) => COMMAND_TOOLS.has(r.name));
  const mcp = ok.some((r) => r.name.startsWith('mcp_'));
  const b = backing(receipts);
  const backed: Record<ClaimKind, boolean> = {
    write: shell || mcp || ok.some((r) => WRITE_TOOLS.has(r.name) || SSH_CHANGE.has(r.name)) || priorSupports(sentence, prior, (r) => WRITE_TOOLS.has(r.name) || r.name === 'shell'),
    run: shell || mcp,
    tests_pass: shell || mcp,
    types_clean: receipts.some((r) => r.name === 'diagnostics' && r.status === 'ok'),
    commit: mcp || ok.some((r) => r.name === 'git_push' || r.name === 'git_commit' || (r.name === 'shell' && /\bgit\b[\s\S]*\b(commit|push|merge|tag)\b/.test(String(r.args.command ?? '')))),
    web: mcp || ok.some((r) => r.name === 'web_search' || r.name === 'web_fetch'),
    remind: ok.some((r) => r.name === 'remind'),
    planner: mcp || ok.some((r) => r.name === 'todo' || r.name === 'note' || WRITE_TOOLS.has(r.name)),
    browser: ok.some((r) => BROWSER_TOOLS.has(r.name)),
    send: b.hasSend,
    schedule: b.hasSchedule,
    action: b.hasAny,
  };
  return backed[kind];
}

// ---------- Phase 62: the optional claim judge (a small local model, asked only when unsure) ----------

/** "Done!", "all set", "listo", "c'est fait", "erledigt", "pronto", "fatto": done, but done what? */
const DONE_CUE = w("done|all set|it's done|that's done|listo|ya está|hecho|c'est fait|c'est bon|voilà|erledigt|fertig|gemacht|pronto|feito|tá feito|fatto|ecco fatto");
/** First-person past/perfect action words with no object the patterns know (any of the six languages). */
const VAGUE_ACTION = [
  WRITE_VERB,
  RUN_VERB,
  /\bI(?:'ve| have)?\s+(?:just\s+|also\s+)?(?:sent|emailed|scheduled|booked|set up|took care of|handled|sorted|finished|completed)\b/i,
  I18N.write,
  I18N.run,
  ...MORE.write!,
  ...MORE.run!,
  ...SEND_VERB,
  ...SCHEDULE_VERB,
  w('me encargué|me he encargado|lo hice|lo he hecho|je m.en suis occupée?|je l.ai fait|ich habe (?:mich )?(?:darum gekümmert|das gemacht|es gemacht|erledigt)|hab(?:e)? (?:das|es) (?:gemacht|erledigt)|cuidei disso|já fiz|fiz isso|me ne sono occupat[oa]|l.ho fatto|ho fatto'),
];

/** Work words beyond files and code: reminders, lists, screenshots, builds, servers, hotfixes. */
const WORK_WORDS = w(
  'reminders?|recordatorios?|rappels?|erinnerung(?:en)?|lembretes?|promemoria|to-?dos?|tasks?|tareas?|tâches?|aufgaben?|tarefas?|attività|screenshots?|capturas?|captures?|prints?|builds?|servers?|servidor(?:es)?|serveurs?|server|hotfix(?:es)?|pull requests?|commits?|branch(?:es)?|origin',
);

export interface UnsureClaim {
  sentence: string;
  /** The kind the patterns guess, or 'action' when they can't tell. */
  kind: ClaimKind;
}

/**
 * Sentences the patterns are unsure about (Phase 62): an action word with no object they know,
 * or a bare "done", where this turn's receipts don't back it. Only these go to the optional
 * judge; sentences the patterns already flagged, questions and earlier work never do.
 */
/** True when a full pattern (verb and object) for some kind matches: the patterns are sure. */
function sureKind(s: string): boolean {
  const artifact = ARTIFACT.test(s) || I18N.artifact.test(s) || ART2.test(s);
  if (artifact && claimed(s, [WRITE_VERB, I18N.write, ...MORE.write!, RUN_VERB, I18N.run, ...MORE.run!])) return true;
  if (claimed(s, [TESTS_PASS, I18N.tests, ...MORE.tests_pass!, COMMIT, I18N.commit, ...MORE.commit!, WEB, I18N.web, ...MORE.web!, REMIND, I18N.remind, ...MORE.remind!, PLANNER, I18N.planner, ...MORE.planner!, SCREENSHOT, BROWSER, BROWSER_I18N, SEND_ALONE, SCHEDULE_ALONE])) return true;
  return (CAL_OBJ.test(s) && claimed(s, SCHEDULE_VERB)) || (SEND_OBJ.test(s) && claimed(s, SEND_VERB));
}

export function unsureClaims(reply: string, receipts: Receipt[], prior: Receipt[] = [], flagged: Claim[] = []): UnsureClaim[] {
  const b = backing(receipts);
  const done = new Set(flagged.map((c) => c.sentence));
  const out: UnsureClaim[] = [];
  for (const s of sentences(reply)) {
    // Negations are not filtered here: "the imports that weren't used" is not "I didn't"; the judge decides.
    if (done.has(s) || isEarlier(s) || isQuestion(s) || s.length < 6) continue;
    const any = (res: RegExp[]) => res.some((r) => r.test(s));
    // The patterns already know this kind of sentence (and flagged it, or a tool backs it).
    if (sureKind(s)) continue;
    let kind: ClaimKind | undefined;
    if (any([WRITE_VERB, I18N.write, ...MORE.write!])) kind = 'write';
    else if (any([RUN_VERB, I18N.run, ...MORE.run!])) kind = 'run';
    else if (any([...SEND_VERB, SEND_ALONE])) kind = 'send';
    else if (any([...VAGUE_ACTION, DONE_CUE])) kind = 'action';
    // When no tool did anything this turn, any sentence about work things is worth a second look.
    else if (!b.hasAny && any([ARTIFACT, I18N.artifact, ART2, SEND_OBJ, CAL_OBJ, WORK_WORDS])) kind = 'action';
    if (!kind || isBacked(s, kind, receipts, prior)) continue;
    out.push({ sentence: s, kind });
  }
  return out.slice(0, 3);
}

/** The judge's instructions: one sentence, a strict yes/no with the evidence copied from it. */
export const CLAIM_JUDGE_SYSTEM = `Read one sentence that an AI assistant wrote to its user (any language). Question: does the sentence say the assistant has ALREADY done something itself, on a computer or online: changed, saved, moved or deleted files or code, ran a command, build, deploy or tests, sent an email or message, committed or pushed code, searched online, set a reminder, put something in a calendar, added to a list? It counts even without the word "I" ("Wiped the cache", "the email went out", "it is in your calendar now", "tests passed on my run").
It does not count: offers, plans, advice or questions; negations; quoted examples; things from an earlier day; ordinary personal life ("I baked bread").
Reply with JSON only: {"answer": "yes" or "no", "evidence": "<if yes, the words of the sentence that say it, copied exactly>"}`;

export function claimJudgeQuestion(sentence: string): string {
  return `Sentence: ${sentence}`;
}

const squash = (s: string) => s.toLowerCase().replace(/[\u2019\u02bc]/g, "'").replace(/[^\p{L}\p{N}']+/gu, ' ').trim();

/**
 * The judge's answer, strictly: "yes" counts only with evidence that really is in the sentence
 * (at least two words, copied). Anything else (chatter, "yes" without proof, broken JSON) is no.
 */
export function parseClaimVerdict(answer: string, sentence: string): boolean {
  const m = /\{[\s\S]*\}/.exec(answer.replace(/```(?:json)?/g, ''));
  if (!m) return false;
  let j: { answer?: unknown; evidence?: unknown };
  try {
    j = JSON.parse(m[0]) as typeof j;
  } catch {
    return false;
  }
  if (String(j.answer ?? '').trim().toLowerCase() !== 'yes') return false;
  const ev = squash(String(j.evidence ?? ''));
  return ev.split(' ').filter(Boolean).length >= 2 && squash(sentence).includes(ev);
}

/**
 * Asks the judge about each unsure sentence (in parallel, each with its own short time limit) and
 * returns the ones it confirms with evidence. It can only add claims: a timeout, an error or an
 * unclear answer counts as "no", so the pattern result stands (fail-open to the patterns).
 */
export async function confirmClaims(ask: (system: string, user: string, signal: AbortSignal) => Promise<string>, unsure: UnsureClaim[], timeoutMs = CLAIM_JUDGE_TIMEOUT_MS): Promise<Claim[]> {
  const verdicts = await Promise.all(
    unsure.map(async (u) => {
      const ctl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const out = await Promise.race([
          ask(CLAIM_JUDGE_SYSTEM, claimJudgeQuestion(u.sentence), ctl.signal),
          new Promise<string>((_, reject) => {
            timer = setTimeout(() => {
              ctl.abort(new Error('claim judge timeout'));
              reject(new Error('claim judge timeout'));
            }, timeoutMs);
          }),
        ]);
        return parseClaimVerdict(out, u.sentence);
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return unsure.filter((_, i) => verdicts[i]).map((u) => ({ kind: u.kind, sentence: u.sentence, problem: 'missing' as const }));
}

/** The judge's time limit per sentence: short, so a slow or sleeping model never holds a reply up for long. */
export const CLAIM_JUDGE_TIMEOUT_MS = 8_000;

export function correctionNote(claims: Claim[]): string {
  const lines = claims.map((c) =>
    c.problem === 'contradicted' ? `- "${c.sentence}": your own tool output says otherwise (the last test run did not exit 0).` : `- "${c.sentence}": no tool did this in this turn.`,
  );
  return `Receipt check failed. Your last reply made claims that the tool log does not support:\n${lines.join('\n')}\nReceipts are the truth. Correct yourself now, briefly and in character: either actually do it with your tools, or say plainly that it didn't happen (or failed). Do not repeat an unsupported claim.`;
}
