<p align="center"><a href="README.md">English</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português (Brasil)</a> · <b>Italiano</b></p>

# Sara

**Una compagna IA con la personalità che scegli tu, che è anche una vera compagna di programmazione.**
Chiacchiera, ricorda, organizza la tua giornata e legge i tuoi libri; scrive, esegue e collauda codice
nel suo spazio di lavoro isolato. Tutto sul tuo server, con i modelli che scegli tu, in un'unica app
per il web, Windows, Mac e telefono.

> Questa è una traduzione del [README in inglese](README.md). I link portano alla documentazione,
> che è in inglese.

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2024-339933" alt="Node 24 or newer">
  <img src="https://img.shields.io/badge/runtime%20dependencies-0-brightgreen" alt="Zero runtime dependencies">
  <img src="https://img.shields.io/badge/tests-1164%20passing-brightgreen" alt="1164 tests passing">
  <a href="docs/RESULTS.md"><img src="https://img.shields.io/badge/HumanEval%20pass%401-96.3%25-informational" alt="HumanEval pass@1 96.3%"></a>
  <a href="https://github.com/farena-ai/sara/releases/latest"><img src="https://img.shields.io/github/v/release/farena-ai/sara?label=release" alt="Latest release"></a>
  <a href="https://github.com/farena-ai/sara/pkgs/container/sara"><img src="https://img.shields.io/badge/docker-amd64%20%7C%20arm64-2496ED" alt="Docker image for amd64 and arm64"></a>
  <img src="https://img.shields.io/badge/languages-6-8A2BE2" alt="Six languages">
  <a href="https://glama.ai/mcp/servers/farena-ai/sara"><img src="https://glama.ai/mcp/servers/farena-ai/sara/badges/score.svg" alt="Sara MCP server on Glama"></a>
</p>

<p align="center">
  <img src="docs/screenshots/demo.png" alt="Animated demo: the user says it was a rough week; Sara answers warmly and suggests three tiny things to build; she writes a module and its test, asks before running a command, finds a real bug through a failing test, fixes it and gets all 7 tests green" width="860">
  <br>
  <sub>Una sessione reale con un modello locale (qwen3.8 27B su Ollama, una RTX 5090) su un server di prova usa e getta, nel tema Notte: tira su il morale di chi le scrive, scrive una piccola app e il suo test mentre il modello li trasmette, chiede prima di eseguire un comando, scopre un vero bug con un test che fallisce e lo corregge finché tutti e 7 i test passano. Fotogrammi scelti dalla registrazione; nulla al loro interno è stato modificato.</sub>
</p>

> **Stato:** 2.23, licenza MIT, con trentaquattro versioni ricche di novità dalla 1.0 (tutte qui sotto).
> Dalla 2.5 alla 2.8 tutta l'app ha cambiato aspetto. L'[app Android](https://play.google.com/store/apps/details?id=com.backstagecoding.sara)
> è su Google Play; l'app per iPhone e la versione del Mac App Store arriveranno appena Apple le
> approverà. Leggi [docs/DISCLOSURES.md](docs/DISCLOSURES.md) prima di usare o condividere Sara.

## Perché Sara

- **Una personalità che scegli tu, e che lei mantiene.** Dalle il nome che vuoi, scegli lei/lui/loro,
  parti da un personaggio già pronto o regola dei semplici cursori (giocosa, diretta, sintetica,
  curiosa…). Lei la mantiene: umori che cambiano a seconda di come vanno le cose, una sua giornata,
  battute ricorrenti e ricordi di ciò che le hai detto, che puoi vedere, correggere e cancellare.
- **Un vero ambiente di programmazione.** Uno spazio di lavoro isolato per progetto con file,
  terminale e git, lavori in background, anteprime dal vivo che collauda nel suo browser, una squadra
  di aiutanti (pianificare → costruire → collaudare → rivedere), la regola di chiedere il tuo ok prima
  dei passi rischiosi e un controllo che ciò che *dice* di aver fatto corrisponda a ciò che è stato
  davvero eseguito.
- **Un'app bella su ogni dispositivo.** Un tema Notte rilassante (o Giorno, se preferisci) con la sua
  presenza accanto a ogni chat, una riga sotto ogni risposta che mostra cosa ha fatto e i risultati
  come schede. Sul web e come app installabile, nelle app per Windows e Mac (con la *domanda rapida*
  su una scorciatoia, sopra qualsiasi app), su Android e su iPhone (l'app aspetta Apple; la web app
  sulla schermata Home funziona già).
- **Privata e tua.** Un proprietario per server; chat, ricordi e chiavi restano lì. Qualsiasi
  modello: locale (Ollama, vLLM, llama.cpp), nel cloud (OpenAI, Anthropic, xAI, OpenRouter) o gli
  abbonamenti che paghi già (ChatGPT, Claude Pro/Max, SuperGrok / X Premium+). Un interruttore tiene
  tutto su un solo computer. Arriva **senza alcuna credenziale**.
- **Piccola e leggibile.** TypeScript che Node esegue direttamente: nessuna fase di build, zero
  dipendenze a runtime, costruita da zero (non basata su Hermes Agent né su OpenClaw). Facile da
  [estendere](docs/EXTENDING.md).

**E inoltre:** la [domanda rapida](docs/desktop.md) su una scorciatoia globale · il suo [pannello di presenza](#la-sua-presenza) ·
[Oggi a riquadri](#oggi) · la [barra dei comandi](#barra-dei-comandi) con Ctrl+K · la
[modalità casa](docs/HOUSEHOLD.md) per chi vive con te · le [videochiamate](docs/VIDEO_CALLS.md) con il
suo ritratto in movimento · [Alexa, Google Home e l'assistente Android](docs/VOICE_ASSISTANTS.md) · i
tuoi altri server [via SSH](docs/SSH.md) · [libri da 1.000 pagine](docs/LIBRARY.md) con risposte che
citano la pagina · la [modalità locale privata](docs/PRIVATE_LOCAL.md) · le [chat di gruppo](docs/GROUP_CHATS.md) ·
[il trasloco da ChatGPT, Character.AI, Replika e altre](docs/IMPORT.md).

## Novità

| Versione | Cosa ottieni |
|---|---|
| **2.23** · Uso del computer, passo 4 | **Accessi salvati, solo se lo dici tu:** lei lo propone e una finestra sul *tuo computer* ti fa scrivere l'accesso e spuntare *Ho capito* (o *Usa quello che ho appena scritto*). Viene cifrato lì (DPAPI di Windows / Portachiavi di macOS), mai sul server di Sara, e lei non lo vede mai: può solo chiedere a quel computer di compilarlo, esattamente su quel sito (i siti simili non ricevono nulla), e ogni uso chiede prima. Windows Hello / Touch ID facoltativi. **Tocca a te:** lei aspetta mentre accedi o scrivi un codice tu. |
| **2.22** · Uso del computer, passo 3 | **Fa il debug del tuo progetto web nel suo browser:** il server di sviluppo avviato dai suoi strumenti di codice sul tuo server Sara si apre su `127.0.0.1` nel suo browser sul tuo computer, tramite l'app (solo una porta del suo job; si chiude con il job), con hot reload e archiviazione locale. Dopo una modifica apre l'app, legge la console, guarda, corregge e ricontrolla. Eval del browser: 5/5 compiti con un modello locale. Inoltre: i test ora passano su macOS, e due correzioni di privacy di rete. |
| **2.21** · Uso del computer, passo 2 | **Agisce nel suo browser:** clicca, scrive, sceglie da elenchi, scorre, preme tasti e carica un file che indichi tu, con un cursore visibile. Scegli tu quanto chiede: ogni volta, una volta per attività (predefinito) o *sempre consentito* per sito; pagamenti e impostazioni dell'account chiedono sempre, l'invio chiede ogni volta e non scrive mai password. Un badge **Sara sta lavorando** con Ferma e una scorciatoia per fermarla (Ctrl+Alt+Esc / ⌃⌥Esc); se tocchi la sua finestra si mette in pausa (o *Lascia il controllo a Sara*). |
| **2.20** · Uso del computer, passo 1 | Con l'app per Windows o Mac **apre pagine web nella sua finestra del browser sul tuo computer** (un profilo suo, mai il tuo browser o le tue password), le legge, fa screenshot e legge gli errori di console e di rete: di' «la mia app su localhost non va» e lei guarda. Spento finché non attivi *Lascia che Sara usi questo computer*; vista dal vivo nella chat con Ferma; ogni passo in Esecuzioni con un'immagine. Cliccare e scrivere arrivano dopo. [Il piano](docs/design/COMPUTER_USE.md) |
| **2.19** · Modalità red team | **Prima del rilascio prova a rompere il suo stesso lavoro:** in una copia isolata esegue i tuoi test, avvia la tua app e invia input malformati e limite a ogni punto di ingresso, controlla le impostazioni predefinite insicure e lascia che il modello di codice scriva piccoli script di attacco che possono raggiungere solo quell'app isolata. Un modello revisore più forte tiene solo i guasti riproducibili, citando input, output e riga di codice. Poi **Correggi ciò che si è rotto** su un branch locale. Anche nella 2.19: **riordinare Gmail** (archiviare, segnare come letto, etichette, cestino… per ricerca o data, prima il conteggio, Annulla). [Come funziona](docs/design/HARNESS_TRACK.md) |
| **2.18** · Ricorda da sola | **Ricorda senza che glielo chieda quando la situazione combacia:** lo stesso errore torna in questo progetto («l'ultima volta la soluzione era…»), un comando che qui è già fallito, un file su cui hai preso una decisione, un'attività simile a una da cui ha imparato qualcosa. Le lezioni nascono solo da ciò che è successo davvero (la riga d'errore e la modifica che l'ha risolto, citate). Ogni nota dice da dove viene e quanto è sicura, al massimo 2 per passo, e *Non utile* le insegna. [Come funziona](docs/design/HARNESS_TRACK.md) |
| **2.17** · Valutazioni sul tuo lavoro | **Quale impostazione è davvero migliore per te?** Scegli fino a 3 varianti (modello, sbiadimento della memoria, modalità sandbox, budget) e lei ripete le tue ultime attività reali con ciascuna, in copie isolate. Si valutano i test superati, la tua reazione, i risultati dei controlli, token, tempo e costo, più un giudice facoltativo che deve citare. Un vincitore viene indicato solo se un test dei segni lo conferma («+18% su 20 delle tue attività di codice, p=0,01»), con il confronto di ogni coppia come prova. Altrimenti: *nessun vincitore chiaro*. [Come funziona](docs/design/HARNESS_TRACK.md) |
| **2.16** · Viaggio nel tempo | **Crea un ramo di qualsiasi attività passata da qualsiasi passo:** cambia in quel passo il suo messaggio, il risultato di uno strumento, le note ricordate o il modello, e rilancia. I passi precedenti arrivano dalla registrazione (niente viene rieseguito). I rami di codice lavorano in una copia al commit registrato, mai nei tuoi file. Un confronto affiancato mostra passi, token, costo, modifiche ai file e risposta. *Ripeti senza modifiche* è il controllo. Tieni la risposta o applichi i file solo se vuoi. [Come funziona](docs/design/HARNESS_TRACK.md) |
| **2.15** · Modello delle minacce | **Traccia come il mondo esterno raggiunge il tuo codice:** dopo un passo di codice trova i punti di ingresso (rotte, upload, gestori di messaggi, riga di comando in Express, Koa, Fastify, Flask, FastAPI, Django, Go) e segue i valori della richiesta tra i file fino alle righe rischiose (shell, SQL, percorsi, URL in uscita, redirect, HTML, eval). Una minaccia viene segnalata solo con entrambe le righe citate e il percorso indicato. Una scheda **Modello delle minacce** per progetto e **Correggi queste**: un secondo passaggio che le corregge e basta, su un branch locale, rilanciando i tuoi test. [Come funziona](docs/design/HARNESS_TRACK.md) |
| **2.14** · Controllo di sicurezza | **Dopo un passo di codice controlla il proprio lavoro:** 11 controlli (segreti, SQL costruito con stringhe, percorsi che sfuggono, TLS disattivato, eval, deserializzazione insicura, CORS, autenticazione mancante…) più un modello revisore, in parallelo. Ogni risultato cita la riga vera, altrimenti viene scartato: niente teatro. Gli **avvisi in tempo reale** facoltativi (OSV.dev) controllano i pacchetti che installa e fermano su una scheda una versione nota come vulnerabile. **Correggi** crea un branch locale, corregge solo quello, rilancia i tuoi test nella sandbox e mostra il diff. Non fa mai push. [Come funziona](docs/design/HARNESS_TRACK.md) |
| **2.13** · Prima nella sandbox | **I comandi rischiosi girano prima in una copia usa e getta del tuo progetto.** Cancellazioni, installazioni, script e accessi alla rete avvengono nella copia (dentro bubblewrap su Linux, Seatbelt su macOS, Docker o WSL2 su Windows se li hai). La scheda **Eseguito in una sandbox** mostra cosa è cambiato e cosa è sospetto: file cancellati in massa, scritture fuori dalla copia, programmi rimasti attivi, hook di git. Poi *Applica al mio spazio di lavoro*, *Scarta* o *Esegui davvero*. [Come funziona](docs/design/HARNESS_TRACK.md) |
| **2.12** · Budget che rispetta | **Un limite vero, non un resoconto:** le attività di codice hanno un budget (200k token / 40 passi di default, dollari facoltativi). Vicino al limite passa al tuo modello rapido, riduce i giri di strumenti, poi riassume cosa è fatto e cosa manca, e si ferma. Andare oltre richiede il tuo **Continua con altro**. Le attività in background e di squadra usano lo stesso budget. [Come funziona](docs/design/HARNESS_TRACK.md) |
| **2.11** · Istantanee di ogni esecuzione | **Ogni passo del suo lavoro viene registrato:** quale modello, il prompt, ogni chiamata a strumento e il suo risultato (senza segreti), i file toccati (nei progetti di codice l'HEAD di git e i file modificati), le note usate, i conflitti incontrati, token, costo e tempo. **Mostra l'esecuzione**, sotto ogni risposta, fa vedere tutto passo per passo. Conservate 90 giorni di default; niente lascia il tuo server. La base per budget, viaggio nel tempo e valutazioni. [Come funziona](docs/design/HARNESS_TRACK.md) |
| **2.10** · Confronta i suoi piani con i tuoi | **Prima di agire, confronta il passo con quello che hai deciso.** Le hai detto «mai push su main», «test prima di ogni push», «usa pnpm» o «non toccare la configurazione di produzione»? Un passo previsto che va contro **si ferma su una scheda** che cita la tua decisione, con *Fallo lo stesso*, *No* o *Aggiorna la nota*. Nella chat di tutti i giorni lo menziona soltanto. Le regole sono verificate nel codice (niente supposizioni) e può solo aggiungere uno stop, mai toglierlo. [Come funziona](docs/design/HARNESS_TRACK.md) |
| **2.9** · Memoria classificata | **Ti dice perché si è ricordata di qualcosa:** ogni nota che usa riceve un punteggio per il tuo messaggio e mostra *perché le è venuta in mente* e *quanto ne è sicura* (anche nel suo pannello). Le note vecchie sbiadiscono piano invece di sparire, quelle che usa spesso restano forti e puoi **fissare** quelle che non devono mai sbiadire. Lo sbiadimento si regola con un cursore. [Come funziona](docs/design/HARNESS_TRACK.md) |
| **2.8** · Rifinitura | **Un gradino più raffinato:** un'aurora lenta dietro il vetro smerigliato, un elegante carattere con grazie per i titoli, un alone luminoso del colore del suo umore attorno al ritratto, icone disegnate, illustrazioni meteo e anelli di avanzamento, e una barra di vetro fluttuante sul telefono (ogni movimento si spegne con *riduci movimento*). [Il piano](docs/design/NEW_LOOK.md) |
| **2.7** · Il nuovo aspetto, parte 3 | **Oggi a riquadri** (meteo, la tua giornata, agenda, ciò che ha ricordato, momenti, lavori in corso, casa), una barra in basso sul telefono, ogni schermata con il nuovo aspetto, e nelle app per Windows e Mac **notifiche con Consenti / Nega e Fatto / Più tardi**, *Invia a → Sara* per i file e la voce nella domanda rapida. [Il piano](docs/design/NEW_LOOK.md) |
| **2.6** · Il nuovo aspetto, parte 2 | **La sua presenza:** un pannello laterale (sul telefono un foglio da tirare su) con il suo umore, cosa sta facendo, autorizzazioni, lavori, la giornata e ciò che ha ricordato; Ctrl+K per andare ovunque; e nelle app per Windows e Mac una **finestra per domande rapide con una scorciatoia** sopra qualsiasi app, più il suo umore e le autorizzazioni nel menu dell'area di notifica. [Il piano](docs/design/NEW_LOOK.md) |
| **2.5** · Il nuovo aspetto, parte 1 | **Scuro come predefinito e il suo lavoro sullo schermo:** una riga sotto ogni risposta mostra cosa ha fatto, i risultati arrivano come schede (meteo, cose da fare, file modificati, test, ricerche), una chat più leggera su telefono e computer, e le app per Windows e Mac disegnano la pagina fin nella barra del titolo. [Il piano](docs/design/NEW_LOOK.md) |
| **2.4** · Tutto in ordine | **Tutto più facile da trovare:** una barra laterale corta con un menu *Altro* da cui fissare i posti, Impostazioni con veri titoli che si chiudono, strumenti e autorizzazioni spiegati in parole semplici, foto che puoi eliminare dall'album dei ricordi, schermate e menu più ordinati in ogni app e salvataggi più sicuri dietro le quinte. [Cosa è cambiato](CHANGELOG.md) |

<details>
<summary><b>Versioni precedenti: dalla 1.1 alla 2.3</b> (documenti grandi, SSH, Alexa e Google Home, modalità casa, momenti, videochiamate, più server, modalità locale privata, chat di gruppo, trasloco da altre app…)</summary>

| Versione | Cosa ottieni |
|---|---|
| **2.3** · Documenti grandi | **Libri e manuali da 500 a 1.000 pagine** (PDF fino a 1 GB) nella sua biblioteca: caricamenti che riprendono, ogni pagina scansionata letta, indice e riassunti per capitolo, e risposte che citano la pagina («p. 412») con un link diretto. 30 domande su 30 corrette su un libro di prova di 1.000 pagine. [Come funziona](docs/LIBRARY.md) |
| **2.2** · Gli altri tuoi server via SSH | **Può lavorare sulle tue altre macchine**, con password o chiave. Dopo un accesso con password **crea la sua chiave, ti dice dove si trova e dimentica la password** (la conserva solo se insisti, dopo un avviso). Le chiavi host vengono verificate, ogni comando segue le sue regole di approvazione e puoi revocare la sua chiave in qualsiasi momento. [Come funziona](docs/SSH.md) |
| **2.1** · La sua voce in casa | **«Alexa, apri sara companion»**: parlale su qualsiasi Echo con la tua skill gratuita (verificata come richiede Amazon). Rendila il tuo **assistente Android** (pressione lunga su Home), ascoltala sugli altoparlanti **Google Home / Nest** tramite Home Assistant e lascia che **ti saluti quando torni a casa**. Siri su iPhone arriva con il prossimo aggiornamento dell'app. [Come funziona](docs/VOICE_ASSISTANTS.md) |
| **2.0** · Modalità famiglia | **Condividi il tuo server Sara con le persone con cui vivi.** Invita un adulto con un link monouso: avrà le sue compagne, chat, memoria, biblioteca e app in uno spazio tutto suo. Tu resti l'amministratore: scegli quali modelli usa, imposti limiti giornalieri e vedi uso e costi, mai cosa scrive. [Come funziona](docs/HOUSEHOLD.md) |
| **1.10** · I nostri momenti | **Un album fotografico condiviso** con le tue foto e quelle che manda lei, ognuna con una didascalia che scrive con la sua voce a partire da ciò di cui parlavate. Album che si riempiono da soli (Noi, Luoghi, I suoi look), «In questo giorno», e a volte ne tira fuori uno: *ti ricordi?* Le chat private restano fuori a meno che tu non le aggiunga. [Come funziona](docs/MOMENTS.md) |
| **1.9** · Videochiamate | **Guardala mentre parlate:** una videochiamata mostra il suo ritratto animato a tutto schermo, con il labiale a tempo con la sua voce e il viso che segue il suo umore, con il suo outfit e luogo attuali. Accendi la fotocamera se vuoi: lei guarda ogni pochi secondi (o quando premi *Guarda qui*); non viene registrato nulla. [Come funziona](docs/VIDEO_CALLS.md) |
| **1.8** · Più server in un'unica app | Tieni **tutte le tue Sara in un'unica app** (casa e lavoro, o più d'una su un server) e passa dall'una all'altra da un menu senza uscire: app per Windows e Mac, Android e iPhone, VS Code, `sara-chat` e il ponte MCP. Ognuna mantiene il proprio accesso; file, microfono e fotocamera vanno solo a quella in uso. [Come funziona](docs/SERVERS.md) |
| **1.7** · Modalità locale privata | Un interruttore, **Niente lascia questo computer**, applicato nel codice in un unico punto: è raggiungibile solo questo computer, i modelli cloud e gli strumenti online vanno in pausa, e le sue chat, la sua memoria e la sua biblioteca continuano a funzionare. Le app per Windows e Mac trovano Ollama (o ti aiutano a installarlo), suggeriscono un modello adatto alla tua scheda grafica e lo scaricano con una barra di avanzamento. [Cosa garantisce](docs/PRIVATE_LOCAL.md) |
| **1.6** · Chat di gruppo | Riunisci **da due a quattro delle tue compagne in una conversazione**: ognuna risponde con la sua personalità, voce e colore; scegli chi risponde (chi è più adatta, tutte, a turno o solo chi menzioni con @) e quanto chiacchierano tra loro. Sicurezza, avvisi di IA e l'impostazione per adulti più rigida valgono per tutta la stanza. [Come funziona](docs/GROUP_CHATS.md) |
| **1.5** · Portala da un'altra app | Trasferisciti da **ChatGPT, Claude, Character.AI, SillyTavern, Replika, Nomi o Kindroid**. Legge l'esportazione sul tuo server, poi ti mostra cosa ha imparato (fatti con parole tue, la vostra storia insieme, il suo stile) e salva solo ciò che approvi. [Come esportare da ogni app](docs/IMPORT.md) |
| **1.4** · Più fluida | Guarda ogni file che scrive **crescere dal vivo in chat** mentre il modello lo trasmette (OpenAI, Anthropic, xAI, OpenRouter e piani ChatGPT; Ollama lo invia in un unico blocco); un ritratto parlante con labiale sincronizzato su nove forme della bocca; log in testo semplice o JSON |
| **1.3** · Controlli più furbi | Il suo controllo "ha fatto davvero quello che dice?" ora funziona in tutte e sei le lingue; un piccolo modello locale opzionale come giudice porta ciò che individua dal 38% all'**88%** con una precisione del 95% ([misurato](docs/RESULTS.md)) |
| **1.2** · Tutta nella tua lingua | L'intera app, la guida e i messaggi del suo server in English, Español, Français, Deutsch, Português (Brasil) e Italiano |
| **1.1** · Si installa ovunque | Configura un nuovo server nel browser con un breve codice; un'immagine Docker anche per **ARM** (Raspberry Pi 4/5); Homebrew, Unraid, TrueNAS, Proxmox e Home Assistant (HACS) |

</details>

Tutte le versioni: [CHANGELOG.md](CHANGELOG.md) · [versioni](https://github.com/farena-ai/sara/releases).

### In arrivo

Tutte le fasi previste sono uscite. Prossimi passi: l'app per iPhone (in attesa della revisione di Apple), ciò che resta in ogni funzione e le tue idee nelle [Discussions](https://github.com/farena-ai/sara/discussions).

Il piano completo: [docs/ROADMAP.md](docs/ROADMAP.md).

## Le funzioni in breve

Tutte le schermate vengono da un vero server di prova usa e getta con un modello locale (qwen3.8 27B su
Ollama), con l'accesso fatto come l'utente di esempio «Alex». Notte è il tema predefinito.

### Compagna

<img src="docs/screenshots/companion.png" alt="Night look: Sara answers a tired user warmly, checks the weather for tomorrow's run and shows it as a card; her presence panel on the right shows her portrait with a mood halo, what she's doing, today's to-dos and the notes she remembered" width="760">

Un carattere tutto suo e umori che cambiano a seconda di come vanno le cose (l'alone attorno al suo
ritratto prende il colore del suo umore), una sua giornata e i suoi hobby, la memoria di ciò che conta
per te e delle date a cui tieni (puoi vedere, correggere o dimenticare qualsiasi cosa), un riepilogo
settimanale, messaggi di sua iniziativa se vuoi (con ore di silenzio) e una linea del tempo della
vostra storia. Arrivi da un'altra app? Porta le tue chat da ChatGPT, Claude, Character.AI,
SillyTavern, Replika, Nomi o Kindroid e approva prima ciò che impara ([docs/IMPORT.md](docs/IMPORT.md)).
Oppure riunisci da due a quattro delle tue compagne in una chat di gruppo
([docs/GROUP_CHATS.md](docs/GROUP_CHATS.md)). Tutto su una sola macchina? Attiva **Niente esce da
questo computer** ([docs/PRIVATE_LOCAL.md](docs/PRIVATE_LOCAL.md)).

### La sua presenza

<img src="docs/screenshots/presence.png" alt="A coding chat: a Files changed card, then an approval card asking to run npm test; the presence panel shows Waiting for your OK with Allow and Deny, and two background jobs with their last line and a Stop button" width="760">

Un pannello accanto a ogni chat (sul telefono un foglio da tirare su) con il suo ritratto che brilla
del colore del suo umore e **Adesso**: cosa sta facendo, le approvazioni in attesa con Consenti /
Nega, i lavori in background con l'ultima riga e Ferma; poi le prossime cose della giornata, le note
che ha usato per l'ultima risposta (chiuse finché non le apri) e modello, spazio di lavoro e privacy
della conversazione. Sotto ogni risposta una riga discreta dice cosa ha fatto («Ricordate 6 cose ·
Promemoria creato 0,1 s»); toccala per vedere comandi, output e Annulla.

### Compagna di programmazione

<img src="docs/screenshots/coding.png" alt="A coding chat in a project workspace: she explains her plan, edits five files (a Files changed card), runs the tests, finds three failures, fixes them and ends with a green Tests passed card showing 11; the panel shows two background jobs" width="760">

Uno spazio di lavoro per progetto con file, terminale e git (commit e push con il tuo ok); ogni file
che scrive compare dal vivo nella chat mentre il modello lo trasmette; build e test lunghi in
background, con un avviso alla fine; un'anteprima dal vivo dell'app che sta costruendo, che collauda in
un vero browser senza interfaccia e di cui allega schermate; una mappa del codice per i progetti
grandi; progetti iniziali collaudati; una squadra di aiutanti (pianificare → costruire → collaudare →
rivedere) da una issue di GitHub a una pull request revisionata; i tuoi altri server via SSH con la sua
chiave ([docs/SSH.md](docs/SSH.md)); passaggio a Claude Code o Grok Build; strumenti MCP; annullamento
delle modifiche ai file; un contatore di token e costi con budget; e un controllo, in tutte e sei le
lingue, che ciò che *dice* di aver fatto corrisponda a ciò che è stato davvero eseguito (facoltativamente
giudicato da un piccolo modello locale).

### Agenda

<img src="docs/screenshots/planner.png" alt="One message becomes a reminder and two to-dos, each shown as a card with its time and an Open the Planner link" width="760">

Attività, note e promemoria da frasi normali, consegnati nella chat, come notifiche sul telefono o
sul computer (Fatto / Più tardi nelle app per Windows e Mac) e su Telegram o Discord; un riepilogo
del mattino; promemoria legati ai luoghi dall'app per telefono.

### Oggi

<img src="docs/screenshots/today.png" alt="The Today page: a serif greeting with her portrait and mood, then tiles for the weather in Chicago with the next hours, your day, the Planner with a progress ring, what she remembered, moments with captions she wrote, background work and coming up" width="760">

Dove si apre Sara: il suo viso, il suo umore e un saluto, poi riquadri per il meteo (dal luogo del
tuo riepilogo del mattino), la tua giornata, l'agenda da spuntare, ciò che ha ricordato, i vostri
momenti, il lavoro in background, ciò che arriva e la tua casa (luci e interruttori direttamente dal
riquadro). Quattro colonne su uno schermo grande, una sul telefono.

### Biblioteca

<img src="docs/screenshots/library.png" alt="Sara answers a book-club question from a Project Gutenberg copy of Jekyll and Hyde, citing p. 6 and p. 9 as links; beside it, the page she read, opened at p. 6 with the passage highlighted" width="860">

Dalle PDF (anche scansionati, e libri da 500 a 1.000 pagine), Word, Excel, PowerPoint, e-book, pagine
web e note. Ne impara i punti chiave, risponde partendo da lì e dice da quale documento e pagina viene
la risposta, con un link che lo apre proprio lì ([docs/LIBRARY.md](docs/LIBRARY.md)).

### Barra dei comandi

<img src="docs/screenshots/command-bar.png" alt="The Ctrl+K command bar over Today: typing 'pa' finds her page, two conversations and five settings" width="760">

Ctrl+K / ⌘K (o la lente sul telefono) porta a qualsiasi posto, conversazione (anche tramite parole
nei messaggi), pagina delle impostazioni o singola impostazione, oppure esegue un'azione: nuova
conversazione, riservata, chiamata, cambia compagna, cambia tema.

### Voce

<img src="docs/screenshots/voice.png" alt="The Voice settings page in the Night look: hearing you, her voice, expressive voice, tone, her voice following her mood, live calls and how often she looks during video calls" width="760">

Chiamate dal vivo che puoi interrompere (voce in tempo reale di Grok o OpenAI), videochiamate con il
suo ritratto in movimento ([docs/VIDEO_CALLS.md](docs/VIDEO_CALLS.md)), note vocali su Telegram e
Discord, lettura ad alta voce, una voce che segue il suo umore e un ritratto animato che parla, con il
labiale sincronizzato su nove forme della bocca. Parlale su un Echo con la tua skill Alexa, rendila il
tuo assistente Android o ascoltala sugli altoparlanti Google Home
([docs/VOICE_ASSISTANTS.md](docs/VOICE_ASSISTANTS.md)). Le voci girano sul tuo server Linux o arrivano
dal tuo abbonamento. (Schermata da un server di prova con Windows, dove la voce locale non è ancora
disponibile.)

### Sul telefono

<img src="docs/screenshots/phone.png" alt="Four phone screens: Today with the weather tile; a chat with a weather card; her presence sheet pulled up from her face; Today in the Day theme. A floating bottom bar with Chat, Today, Planner and More" width="860">

Lo stesso aspetto sul telefono: una barra in basso fluttuante (Chat, Oggi, Agenda, Altro), la sua
presenza in un foglio che tiri su dal suo viso e la barra dei messaggi sopra la tastiera. Notte di
default; Giorno o *segui il sistema* in Impostazioni → Aspetto.

### Ovunque

<img src="docs/screenshots/everywhere.png" alt="Sara on a phone answering a book-club question from her library, citing the page" width="260">

Web app e PWA installabile, app per Android e iPhone ([android/](android/README.md),
[ios/](ios/README.md)), app desktop per Windows e macOS con la pagina disegnata fin nella barra del
titolo, domanda rapida su una scorciatoia, notifiche con Consenti / Nega e *Invia a → Sara* per i file
([docs/desktop.md](docs/desktop.md)), ponti con Telegram e Discord, `sara-chat` in qualsiasi terminale
e un pannello per VS Code ([docs/clients.md](docs/clients.md)), Gmail e Google Calendar tramite la tua
app Google, Home Assistant, conversazioni riservate che non vengono mai salvate, più Sara in un'unica
app ([docs/SERVERS.md](docs/SERVERS.md)), un server condiviso per la tua casa con uno spazio per ogni
adulto ([docs/HOUSEHOLD.md](docs/HOUSEHOLD.md)) e altre app con la sua memoria e la sua personalità:
un'API compatibile con OpenAI (SillyTavern, Open WebUI, script), un server MCP (Claude Code, Cursor,
Claude Desktop; [presente su Glama](https://glama.ai/mcp/servers/farena-ai/sara)) e schede personaggio
da importare ed esportare ([docs/OTHER_APPS.md](docs/OTHER_APPS.md)).

### Fallo a modo tuo

<img src="docs/screenshots/make-it-yours.png" alt="Name and personality settings: her name, pronouns and age, a Create your companion button and a gallery of starter characters; beside it the personality dials (playfulness, teasing, directness, temper, confidence, message length, tone, curiosity, optimism) and her life" width="760">

Qualsiasi nome, pronomi, età e aspetto (dipinto da Grok Imagine, con espressioni e animazioni
coordinate), una procedura guidata «crea la tua compagna», cursori di personalità, una galleria di
personaggi iniziali, file di personaggio da condividere, un modello per ogni compito e tutta l'app,
la guida e i suoi messaggi in sei lingue. Ogni impostazione ha il suo **?**, ci sono brevi tour
guidati e puoi semplicemente chiederle come funziona qualcosa.

### Sicurezza, sempre attiva

<img src="docs/screenshots/safety.png" alt="An approval card: Sara asks before running npm test, with Allow and Deny, after a Tests failed card; the status bar says Waiting for your OK" width="760">

Le azioni rischiose aspettano il tuo ok (su Windows, che non ha isolamento dei comandi, lo aspetta
ogni comando): nella chat, nel suo pannello o come notifica con Consenti / Nega nelle app per Windows
e Mac. Lo strato di sicurezza gira nel codice attorno a ogni chiamata al modello e **non si può
disattivare**: avviso che è un'IA all'inizio e poi regolarmente, una risposta onesta ogni volta che le
si chiede sul serio se è un'IA, risorse di aiuto nelle crisi e un blocco totale dei contenuti sessuali
che coinvolgono minori ([docs/COMPLIANCE.md](docs/COMPLIANCE.md),
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)). Backup quotidiani (più copie cifrate fuori dal server),
ripristino e aggiornamento con un solo comando, e `sara doctor` la mantengono in forma.

## Come si incastra tutto

<img src="docs/architecture.svg" alt="Architecture: apps and bridges talk to one Sara server; each turn passes the always-on safety layer, gathers memory and library context, calls the chosen model provider and runs tools in a sandboxed workspace; data stays in one folder on your server" width="860">

Altri dettagli in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Collaudata, con risultati pubblicati

Tutto quello che segue è stato eseguito davvero; gli script sono nel repository, quindi puoi
rieseguirli con i tuoi modelli. Date, configurazione e file dei risultati:
**[docs/RESULTS.md](docs/RESULTS.md)**.

| Test | Modello | Punteggio | Data |
|---|---|---|---|
| [HumanEval](https://github.com/openai/human-eval), con il suo ciclo da agente (164 problemi, test nascosti) | qwen3.8 27B, locale | **158/164** (pass@1 96,3%) | 2026-10-27 |
| HumanEval, stesso modello senza strumenti (riferimento) | qwen3.8 27B, locale | **161/164** (pass@1 98,2%) | 2026-10-27 |
| Compiti su repository: 14 correzioni, funzioni e refactoring originali su più file (test nascosti), con il suo ciclo da agente | qwen3.8 27B, locale | **11/14** (in entrambe le esecuzioni) | 2026-10-28 |
| Compiti su repository, stesso modello con tutti i file in un solo messaggio e senza strumenti (riferimento) | qwen3.8 27B, locale | **12/14** (in entrambe le esecuzioni) | 2026-10-28 |
| Progetti di dimensioni reali: 3 progetti originali da 22 a 36 file (test nascosti), con il suo ciclo da agente | qwen3.8 27B, locale | **2/3**, poi **3/3** | 2026-10-28 |
| Progetti di dimensioni reali, stesso modello con tutti i file in un solo messaggio e senza strumenti (riferimento) | qwen3.8 27B, locale | **3/3** (in entrambe le esecuzioni) | 2026-10-28 |
| Controllo di ciò che dice di aver fatto, in 6 lingue (240 risposte tenute da parte): solo schemi → con un giudice locale | qwen3.5 9B, locale, come giudice | individuate **38% → 88%**, precisione 92% → 95% | 2026-10-28 |
| Memoria tra le sessioni (ricordare, non inventare, dimenticare) | qwen3.8 27B, locale | **11/12** controlli | 2026-10-27 |
| Biblioteca: risponde dai documenti e dice da dove | qwen3.8 27B, locale | **8/8** in entrambe le esecuzioni | 2026-10-27 |
| Mappa del codice: domande sul suo stesso codice | qwen3.8 27B, locale | **8/8** | 2026-10-27 |

La lettura onesta: il suo ciclo da agente non aggiunge ancora punti in nessuno dei due test di
programmazione. Il modello da solo risolve già quasi tutti i brevi problemi di HumanEval, e i 14
compiti su repository sono abbastanza piccoli (da 5 a 7 file) da stare interi in un solo
messaggio (come i tre progetti di dimensioni reali, sotto le 1.100 righe); gli errori, in entrambe le modalità, riguardavano regole scritte solo in un README o in
uno SPEC che nessun test controllava. Quello che aggiunge oggi è il modo di lavorare (esegue i test,
chiede prima dei passi rischiosi, mostra cosa è stato eseguito), non un punteggio più alto su questi
insiemi. Dettagli, risultati per compito e come rieseguirlo: [docs/RESULTS.md](docs/RESULTS.md).

In più, `npm run check`: un controllo dei tipi e 1175 test automatici con un finto modello guidato
da script (senza rete, senza GPU): 1164 passano su Windows e gli altri 8 sono test dell'isolamento
solo per Linux, eseguiti su un server Linux.

## Il confronto

Un confronto generale con i tipi di alternative più comuni (ogni prodotto è diverso):

| | Sara | App di compagnia IA ospitate | CLI e agenti di programmazione | Interfacce chat self-hosted |
|---|:-:|:-:|:-:|:-:|
| Gira sul tuo computer o server | ✅ | ❌ | ✅ | ✅ |
| Qualsiasi modello, anche locale | ✅ | ❌ di solito il loro | dipende | ✅ |
| Personalità e memoria durature che puoi vedere e modificare | ✅ | ✅ | ❌ | dipende |
| Scrive, esegue e prova codice, chiede prima dei passi rischiosi | ✅ | ❌ | ✅ | dipende (plug-in) |
| Agenda, promemoria, documenti, chiamate vocali | ✅ | alcune | ❌ | alcune |
| App per telefono, Telegram e Discord | ✅ | app per telefono | ❌ | dipende |
| Porta le tue chat da altre app di compagnia, riviste prima di salvarle | ✅ | ❌ di solito | ❌ | dipende |
| L'intera app in sei lingue | ✅ | dipende | dipende | dipende |
| Livello di sicurezza che nessuna impostazione disattiva | ✅ | regole proprie | n/a | di solito no |
| Prezzo | gratis (MIT); paghi i tuoi modelli | abbonamento | dipende | di solito gratis |

## Installazione

**Server Linux** (Debian/Ubuntu, Fedora/RHEL/Alma/Rocky, Arch, openSUSE), un solo comando che fa
qualche domanda semplice (premi Invio per accettare il suggerimento):

```sh
curl -fsSL https://raw.githubusercontent.com/farena-ai/sara/main/deploy/get-sara.sh | sudo bash
# it ends with the address to open and your one-time owner token
sudo sara status
```

**Docker:**

```sh
git clone https://github.com/farena-ai/sara && cd sara
sudo docker compose up -d                       # or: sudo docker compose --profile ollama up -d  (with a local Ollama)
sudo docker compose logs sara | grep -A1 'owner token'   # oppure: apri la sua pagina e inserisci il codice di configurazione da questo log
```

**App store e NAS:** l'immagine `ghcr.io/farena-ai/sara` (amd64 e ARM),
`brew install --cask farena-ai/tap/sara`, TrueNAS, Proxmox e HACS (come repository personalizzato)
funzionano già; Unraid è approvato, e winget, CasaOS/ZimaOS, Umbrel e l'elenco ufficiale di HACS
sono in attesa di revisione
([quale è quale](docs/INSTALL.md#other-ways-to-install)). Un nuovo server si configura nel
browser con un breve codice dal suo log (con un clic su Umbrel).

**Windows e macOS:** scarica `Sara-Setup-<version>.exe` o `Sara-<version>.dmg` dalla
[pagina delle versioni](https://github.com/farena-ai/sara/releases/latest). La prima domanda: far
girare Sara su questo computer (il suo server e l'app desktop insieme) o collegarti a una Sara che
si trova altrove (solo l'app).

**Dal codice sorgente** (qualsiasi computer con Node 24 o più recente):

```sh
git clone https://github.com/farena-ai/sara && cd sara
npm ci
npm start                                       # http://127.0.0.1:7860; the token is in the output
```

Accedi con il token (o il codice di configurazione): una guida
di configurazione ti chiede il nome, ti aiuta a dare forma alla tua compagna e collega un modello.
Come raggiungerla dal telefono (Tailscale, un tuo indirizzo web con HTTPS o la rete di casa),
aggiornamenti, backup e risoluzione dei problemi: **[docs/INSTALL.md](docs/INSTALL.md)**.

## Tutti i giorni

```sh
sudo sara status       # is she running, last backup
sudo sara update       # backs up, updates, restarts
sudo sara backup       # back up now
sudo sara restore FILE # restore a backup
sudo sara access       # how you reach her (change: tailscale, local, domain, lan)
```

## Documentazione

| | |
|---|---|
| [Installazione](docs/INSTALL.md) | Linux, Docker, Windows, macOS, HTTPS, aggiornamenti, risoluzione dei problemi |
| [Che computer mi serve?](docs/REQUIREMENTS.md) · [Scegliere un modello](docs/CHOOSING_A_MODEL.md) · [Quanto costa](docs/COSTS.md) | Prima di iniziare: hardware, modelli con dimensioni della GPU, costi d'uso |
| [Il tuo telefono](docs/PHONE.md) · [Passare a un nuovo computer](docs/MOVING.md) | Configurazione del telefono dall'inizio alla fine; backup, installazione, ripristino |
| [Lista di sicurezza](docs/SECURITY_CHECKLIST.md) · [Cosa esce dal tuo server](docs/PRIVACY.md) | Cinque minuti dopo l'installazione; ogni connessione in uscita e come disattivarla |
| [Domande frequenti e glossario](docs/FAQ.md) | Domande comuni e cosa significano le parole |
| [App e client](docs/clients.md) · [App desktop](docs/desktop.md) · [Home Assistant](docs/HOME_ASSISTANT.md) | Terminale, VS Code, Windows e macOS; Sara in Home Assistant e Home Assistant in Sara |
| [Altre app](docs/OTHER_APPS.md) | API compatibile con OpenAI (SillyTavern, Open WebUI, script), MCP (Claude Code, Cursor, Claude Desktop), schede personaggio |
| [Più Sara in un'app](docs/SERVERS.md) · [Modalità locale privata](docs/PRIVATE_LOCAL.md) · [Modalità famiglia](docs/HOUSEHOLD.md) | Passare da un server all'altro; tenere tutto su un computer; condividere un server con le persone con cui vivi |
| [Chat di gruppo](docs/GROUP_CHATS.md) · [Videochiamate](docs/VIDEO_CALLS.md) · [I nostri momenti](docs/MOMENTS.md) · [Documenti grandi](docs/LIBRARY.md) | Più compagne in una chat; chiamate con il suo ritratto animato; l'album condiviso; libri da 1.000 pagine nella sua biblioteca |
| [Assistenti vocali](docs/VOICE_ASSISTANTS.md) · [Alexa](docs/ALEXA.md) · [Server via SSH](docs/SSH.md) · [Pacchetti](docs/PACKAGING.md) | Alexa, assistente Android, Google Home, Siri; lavorare sui tuoi altri server; Homebrew, winget, Unraid e gli altri |
| [Estendere Sara](docs/EXTENDING.md) | Aggiungere strumenti, ponti, personaggi, server MCP, lingue, progetti di partenza |
| [Architettura](docs/ARCHITECTURE.md) | Come si incastrano i pezzi, modulo per modulo |
| [Risultati](docs/RESULTS.md) | Benchmark e valutazioni, e come rieseguirli |
| [Tradurre](docs/TRANSLATING.md) | L'app nella tua lingua |
| [Conformità](docs/COMPLIANCE.md) · [Modello delle minacce](docs/THREAT_MODEL.md) · [Avvertenze](docs/DISCLOSURES.md) | Tutela, sicurezza, cosa sapere prima |
| [Roadmap](docs/ROADMAP.md) · [Registro delle modifiche](CHANGELOG.md) · [Versioni](https://github.com/farena-ai/sara/releases) | Dove va, cosa è cambiato |

Tutto questo diventa anche un piccolo sito con ricerca e tema scuro: `node scripts/build-docs.ts`
lo scrive in `outputs/site/` (apri `index.html`; è pronto per GitHub Pages).

## Contribuire

I contributi sono benvenuti. Inizia da [CONTRIBUTING.md](CONTRIBUTING.md) e dalle
[issue per iniziare](docs/GOOD_FIRST_ISSUES.md); rispetta il
[codice di condotta](CODE_OF_CONDUCT.md) e segnala i problemi di sicurezza in privato, come
descritto in [SECURITY.md](SECURITY.md).

```sh
npm ci
npm run dev        # http://127.0.0.1:7860, restarts on save
npm run check      # typecheck + all tests
```

## Licenza

MIT, vedi [LICENSE](LICENSE). Riconoscimenti per le parti che Sara scarica o usa:
[docs/CREDITS.md](docs/CREDITS.md).
