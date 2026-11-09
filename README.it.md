<p align="center"><a href="README.md">English</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português (Brasil)</a> · <b>Italiano</b></p>

<p align="center">
  <img src="docs/images/brand/sara-hero.webp" alt="Sara: una donna illustrata con capelli ramati mossi, lentiggini e un maglione color crema sorride accanto al logo Sara e alle parole in inglese Your companion. Your coding partner. Your server. (La tua compagna. La tua partner di codice. Il tuo server.) e Self-hosted AI companion &amp; agent harness" width="100%">
</p>

<p align="center"><b>Sara è una compagna IA che ospiti tu, con una personalità che plasmi e una memoria che controlli, e un vero ambiente di programmazione che chiede prima dei passi rischiosi e mostra cosa è stato eseguito davvero.</b></p>

<p align="center">
  <a href="https://github.com/farena-ai/sara/releases/latest"><img src="https://img.shields.io/badge/Scarica-B4436C?style=for-the-badge" alt="Scarica"></a>
  <a href="docs/INSTALL.md"><img src="https://img.shields.io/badge/Guida%20all%E2%80%99installazione-315C66?style=for-the-badge" alt="Guida all’installazione"></a>
  <a href="https://github.com/farena-ai/sara"><img src="https://img.shields.io/badge/%E2%98%85%20Stella%20su%20GitHub-8A6422?style=for-the-badge" alt="★ Stella su GitHub"></a>
</p>

<p align="center">
  <a href="docs/INSTALL.md">Windows · macOS · Linux · Docker</a> ·
  <a href="LICENSE">MIT</a> ·
  <a href="https://github.com/farena-ai/sara/releases/latest"><img src="https://img.shields.io/github/v/release/farena-ai/sara?label=release" alt="Latest release"></a>
  <br>
  <sub>Gratis e open source · Sul tuo server · Con i tuoi modelli. Sara è gratis; hardware, hosting e fornitori di modelli facoltativi possono avere un costo. <a href="docs/COSTS.md">Quanto costa</a>.</sub>
</p>

**Provala subito:** Docker `git clone https://github.com/farena-ai/sara && cd sara && sudo docker compose up -d` (immagine `ghcr.io/farena-ai/sara`, amd64 e ARM) · un server Linux con un solo comando, Windows, macOS e telefoni: [guida all’installazione](docs/INSTALL.md) · installer: [ultima versione](https://github.com/farena-ai/sara/releases/latest).

**Aggiornare:** su un server Linux `sudo sara update` (prima fa un backup e torna indietro se lei non risponde) · Docker: `sudo git pull && sudo docker compose up -d --build` · app per Windows e Mac: Impostazioni → Dati e salute → Aggiornamenti · Android: Google Play. [Come aggiornare](docs/INSTALL.md#upgrading).

> **Stato:** 3.1.0, [La posta oltre Gmail](https://github.com/farena-ai/sara/releases/tag/v3.1.0). Outlook, Microsoft 365, Yahoo, iCloud e qualsiasi server di posta, più caselle, quelle di ogni membro. [Scopri le novità](#novità)
>
> Installer Windows: non firmato ([guida SmartScreen](docs/INSTALL.md)). Il processo di rilascio macOS richiede download firmati e autenticati da Apple; ogni build viene verificata separatamente. Android: [Google Play](https://play.google.com/store/apps/details?id=com.backstagecoding.sara). iPhone: [app web nella schermata Home](docs/PHONE.md).

<p align="center">
  <a href="docs/START_HERE.md"><img src="https://img.shields.io/badge/L%27ho%20appena%20installata%2C%20e%20adesso%3F-B4436C?style=for-the-badge" alt="L'ho appena installata, e adesso?" height="34"></a>
  <a href="docs/FOR_CODERS.md"><img src="https://img.shields.io/badge/Sono%20qui%20per%20programmare-6E4BD8?style=for-the-badge" alt="Sono qui per programmare" height="34"></a>
</p>

Sara è una IA. Leggi le [informazioni da conoscere](docs/DISCLOSURES.md) prima di usarla o condividerla. La modalità locale mantiene le chiamate al modello sul tuo computer; le funzioni cloud inviano dati ai fornitori che scegli ([privacy](docs/PRIVACY.md)).

**Sei qui con un team?** Usa la [configurazione aziendale separata](docs/BUSINESS_OPERATIONS.md): passkey individuali, ruoli espliciti e spazi condivisi. È un’installazione manuale con una cartella dati dedicata; gli installer personali non convertono la tua compagna né il tuo nucleo domestico.

> Questa è una traduzione del [README in inglese](README.md). I link portano alla documentazione,
> che è in inglese.

## Cosa fa Sara

<p align="center">
  <img src="docs/screenshots/v3-chat-dark.webp" alt="A companion chat in the 3.0 look: the live status strip across the top, her presence orb beside her replies, to-do and reminder cards for a calmer week, and At a glance on the right with spend today, workers, her memory map and today" width="860">
  <br>
  <sub>L’aspetto della 3.0: grafite con un colore d’accento a tua scelta (qui il Blu predefinito). Screenshot veri da un server di prova usa e getta con un modello scriptato e dati inventati: pianifica una settimana più tranquilla e aggiunge le attività e un promemoria come schede; la barra di stato mostra cosa è in corso e <i>In breve</i> mostra la spesa, i lavoratori, la sua mappa della memoria e la giornata.</sub>
</p>

Prima il nuovo aspetto in immagini, poi una riga per area; ogni link porta alla guida. Altri screenshot: **[Le funzioni in breve](docs/FEATURES.md)**.

### Il nuovo aspetto

<img src="docs/images/brand/sara-new-look.webp" alt="Illustrazione con l’etichetta Sara · the new look: Sara sorride alla sua scrivania la sera accanto a un grande monitor con un’app scura: barra laterale, fumetti di chat, schede e un pannello laterale" width="860">

La 3.0 fa sembrare Sara un sistema vivo, sopra tutto quello che c’era già (nessuna pagina, impostazione, progetto o tipo di chat è sparito): una barra di stato dal vivo (lavoratori, esecuzioni, trigger, il modello che risponde, la spesa di oggi; un chip solo quando è reale), la sua sfera di presenza che ascolta, pensa e parla con lei, una cronologia dal vivo sotto le sue risposte con la scheda di approvazione dentro l’esecuzione e *verificato* solo quando una prova in sandbox o controlli puliti hanno dimostrato il passo, una mappa di ciò che ricorda e *In breve* accanto alla chat. Un solo colore d’accento (sei predefiniti o qualsiasi colore, sempre leggibile), il nome che le hai dato ovunque, il movimento dello sfondo che puoi spegnere, e Sara Classico resta com’era. La home *Tutte le impostazioni* e il launcher Ctrl K della 2.79 sono sempre a un tasto.

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/screenshots/v3-chat-light.webp" alt="The same chat in the Day look: light sidebar, chat and At a glance, with the to-do and reminder cards" width="420"><br><sub>L’aspetto Giorno segue il tuo sistema</sub></td>
    <td width="50%" align="center"><img src="docs/screenshots/v3-coding.webp" alt="A coding project chat: Sara reads two files, edits src/duration.js, shows the diff, and a security pass and threat model report nothing found" width="420"><br><sub>Un progetto di codice: legge, corregge, mostra il diff; un controllo di sicurezza verifica la modifica</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/screenshots/v3-approval.webp" alt="An approval card for a git commit inside the live run, with three buttons: Allow, Always allow this tool and Deny" width="420"><br><sub>Schede di approvazione: <i>Consenti</i>, <i>Consenti sempre questo strumento</i> o <i>Nega</i></sub></td>
    <td width="50%" align="center"><img src="docs/screenshots/v3-launcher.webp" alt="The Ctrl K launcher with look typed: a matching conversation, settings such as Look and Appearance, and the action Reset the look to the defaults" width="420"><br><sub>Ctrl K: luoghi, chat, impostazioni e azioni in un’unica casella</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/screenshots/v3-settings.webp" alt="Settings opened on All settings: every page listed under its group (Her, You, Add-ons, Coding) with a line on what each page does" width="420"><br><sub><i>Tutte le impostazioni</i>: ogni pagina nel suo gruppo, a un clic</sub></td>
    <td width="50%" align="center"><img src="docs/screenshots/v3-appearance.webp" alt="The Appearance page: palette cards (Graphite, Midnight, Slate, Nord, Solarized, Paper, Ember, High contrast, Sara Classic), Night or Day, accent colours (Blue, Rose, Violet, Emerald, Amber, Cyan or any colour), background motion and a live preview" width="420"><br><sub>Aspetto: schede delle palette, Notte o Giorno, il tuo colore, anteprima dal vivo</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/screenshots/v3-pictures.webp" alt="Pictures from her: her portraits and new pictures, a picture engine choice, and Pictures on her own with how often and a monthly limit" width="420"><br><sub>Foto da lei: Grok, OpenAI, ComfyUI o un altro strumento di immagini</sub></td>
    <td width="50%" align="center"><img src="docs/screenshots/v3-addons.webp" alt="Add-ons, Get more: the signed Sara Store with Weather alerts, Focus, ComfyUI and Webhook notes cards, each with a Get button" width="420"><br><sub>Componenti aggiuntivi → Scopri altro: il Sara Store firmato; niente si accende da solo</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/screenshots/v3-today.webp" alt="Today: Good morning, Alex with the presence orb and her mood, How do I…?, Getting started (2 of 7 done) and routines to add" width="420"><br><sub>Oggi: la tua giornata, cosa ti aspetta, routine e Per iniziare</sub></td>
    <td width="50%" align="center"><img src="docs/screenshots/v3-planner.webp" alt="The Planner on the To-do tab: tasks with due dates and priorities, plus Board, Reminders, Notes, Her plans, Repeats and Routines tabs" width="420"><br><sub>Agenda: attività, bacheca, promemoria, note e routine</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/screenshots/v3-phone.webp" alt="Two phone screens side by side: the chat with to-do and reminder cards, and Today with the Now card, both with the bottom bar" width="420"><br><sub>Sul telefono: la chat e Oggi</sub></td>
  </tr>
</table>

### Per farti compagnia

<img src="docs/images/brand/sara-for-company.webp" alt="Illustrazione con l’etichetta Sara · for company: Sara ride su un divano con una tazza di tè, un’agenda e il telefono accanto, nella luce calda di una lampada" width="860">

| Area | Cosa ottieni |
|---|---|
| **Compagna** | Qualsiasi nome, lei/lui/loro e un aspetto, una personalità da cursori semplici o da un personaggio iniziale, umori, la sua giornata, battute ricorrenti e ricordi di ciò che le hai raccontato, che puoi vedere, correggere e dimenticare. Può mandarti foto di sé fatte con Grok, OpenAI, il tuo workflow ComfyUI o un altro strumento di immagini e, se lo attivi, ogni tanto una di sua iniziativa. [Inizia da qui](docs/START_HERE.md) · [Persone](docs/PEOPLE.md) · [Momenti](docs/MOMENTS.md) · [Foto](docs/PHOTOS.md) |
| **Voce e chiamate** | Chiamate dal vivo che puoi interrompere, videochiamate con il suo ritratto animato, «Hey Sara» a mani libere nell’app per Windows, e Alexa, Google Home o il tuo assistente Android. [Videochiamate](docs/VIDEO_CALLS.md) · [Hey Sara](docs/HEY_SARA.md) · [Assistenti vocali](docs/VOICE_ASSISTANTS.md) |
| **Agenda, routine e sorveglianza** | Cose da fare, note e promemoria da frasi normali, una bacheca, Oggi come schermata iniziale, una galleria di routine (briefing del mattino, resoconto settimanale…), promemoria per quando salta fuori una persona o un argomento, e avvisi facoltativi quando un log mostra una riga come ERROR. [Oggi](docs/TODAY.md) · [Routine](docs/ROUTINES.md) · [Bacheca](docs/BOARD.md) · [Sorvegliare un file](docs/WATCHES.md) |
| **Biblioteca e lettura** | PDF (anche scansioni, e libri da 500 a 1.000 pagine), Word, Excel, PowerPoint, e-book, pagine web e note; le risposte dicono da quale documento e pagina vengono. [Biblioteca](docs/LIBRARY.md) |
| **Scene e gioco di ruolo** | Una scena di gioco di ruolo condivisa tra le tue chat web, Telegram e Discord più una stanza condivisa, con fatti del canone che aggiungi, modifichi o ritiri; chat di gruppo con da due a quattro compagne; pacchetti compagna e schede personaggio. [Scene condivise](docs/SCENES.md) · [Chat di gruppo](docs/GROUP_CHATS.md) · [Pacchetti compagna](docs/PACKS.md) |

### Per programmare

<img src="docs/images/brand/sara-for-coding.webp" alt="Illustrazione con l’etichetta Sara · for coding: Sara a una scrivania di notte, il mento sulla mano, sorride al codice sul portatile accanto a un caffè e una lampada da tavolo" width="860">

| Area | Cosa ottieni |
|---|---|
| **Progetti di codice** | Uno spazio di lavoro isolato per progetto con file, terminale e git; scrive il codice, chiede prima di eseguire un comando e mostra i risultati dei test come schede; anteprime dal vivo che prova nel suo browser. I comandi rischiosi possono girare prima in una copia isolata. Le schede di approvazione offrono *Consenti sempre questo strumento* quando ti fidi di uno strumento, e ogni server di strumenti ha un’unica scelta di approvazione. [Per chi programma](docs/FOR_CODERS.md) |
| **Lavoro che si dimostra** | Una riga sotto ogni risposta mostra ogni comando e il suo output, e un controllo confronta ciò che *dice* di aver fatto con ciò che è stato eseguito davvero. Gli obiettivi finiscono solo quando passa il tuo controllo, le sue modifiche passano il controllo dei tipi, le affermazioni visive richiedono uno screenshot e i controlli non più attuali vengono ripetuti. [Obiettivi](docs/GOALS.md) · [Controlli](docs/CHECKS.md) · [Controlli visivi](docs/FOR_CODERS.md#web-pages-look-fix-look-again) |
| **Lavoro lungo e condiviso** | Lavori in background, una squadra di aiutanti (pianificare → costruire → testare → rivedere), punti di ripresa del progetto, budget che fermano un’attività lunga dove dici tu, e gli altri tuoi server via SSH. [Punti di ripresa](docs/FOR_CODERS.md#project-checkpoints) · [Server via SSH](docs/SSH.md) |
| **Nei tuoi strumenti** | GitHub, `sara-chat` in qualsiasi terminale, un pannello di VS Code, MCP per Claude Code e Cursor, e un’API compatibile con OpenAI, sempre con la sua memoria e la sua personalità. [App e client](docs/clients.md) · [Altre app](docs/OTHER_APPS.md) |

### Per entrambe le cose

<img src="docs/images/brand/sara-everywhere.webp" alt="Illustrazione con l’etichetta Sara · everywhere: Sara cammina per una strada di città al tramonto con gli auricolari, sorride al telefono, con un tablet nell’altra mano" width="860">

| Area | Cosa ottieni |
|---|---|
| **App su ogni piattaforma** | App web e PWA installabile, app per Windows e Mac con la domanda veloce su una scorciatoia, [Android su Google Play](https://play.google.com/store/apps/details?id=com.backstagecoding.sara), l’app web nella schermata Home dell’iPhone, Telegram, Discord, Signal ed email, e WhatsApp, Matrix e iMessage come plugin facoltativi. [App desktop](docs/desktop.md) · [Il tuo telefono](docs/PHONE.md) · [Comandi della chat](docs/CHATS.md) |
| **Componenti aggiuntivi** | Plugin, abilità e server di strumenti (MCP) dal Sara Store firmato o da una tua cartella; ognuno passa da una scheda di revisione e resta spento finché non lo accendi tu. Sfogliali e installali in Impostazioni → Componenti aggiuntivi → Scopri altro; per la 2.80 ogni server di strumenti e componente aggiuntivo è stato installato, usato e rimosso su Linux e Windows reali. [Sara Store](docs/STORE.md) · [Libreria dei componenti aggiuntivi](docs/ADDONS_LIBRARY.md) · [Abilità](docs/SKILLS.md) |
| **Casa e azienda** | La modalità famiglia dà a ogni adulto con cui vivi uno spazio tutto suo sul tuo server; gli spazi aziendali sono un’installazione separata con passkey, ruoli e spazi condivisi. [Modalità famiglia](docs/HOUSEHOLD.md) · [Azienda](docs/BUSINESS.md) |
| **Privacy, modelli locali e sicurezza** | Qualsiasi modello: locale (Ollama, vLLM, llama.cpp), nel cloud (OpenAI, Anthropic, xAI, OpenRouter) o i piani che paghi già (ChatGPT, Claude Pro/Max, SuperGrok / X Premium+). Un proprietario per server; chat, ricordi e chiavi restano lì. Un interruttore tiene tutto su un solo computer; arriva **senza credenziali di alcun tipo**; uno strato di sicurezza che non si può disattivare. [Modalità locale privata](docs/PRIVATE_LOCAL.md) · [Scegliere un modello](docs/CHOOSING_A_MODEL.md) · [Controllo di sicurezza](docs/SAFETY_CHECKUP.md) |
| **Aspetto e navigazione** | Una home *Tutte le impostazioni* con ogni pagina a un clic e percorso di navigazione, Ctrl K per andare a qualsiasi luogo, chat, impostazione o azione, nove palette in Notte e Giorno (Graphite di default), il tuo colore d’accento, spaziatura compatta e decorazione completa o ridotta, con anteprima dal vivo. 3.0: barra di stato dal vivo, la sua sfera di presenza, cronologia dal vivo di ogni esecuzione, mappa della memoria e *In breve*; un accento (Blu, Rosa, Viola, Smeraldo, Ambra, Ciano o qualsiasi colore) e il movimento dello sfondo che puoi spegnere. [Aspetto](docs/APPEARANCE.md) |
| **Aiuto e trasloco** | Un riquadro *Come faccio a…?* in ogni pagina, brevi visite guidate e il trasloco da ChatGPT, Claude, Character.AI, SillyTavern, Replika, Nomi, Kindroid, Hermes Agent o OpenClaw, controllato prima che venga salvato qualcosa. [Come faccio a…?](docs/HOW_DO_I.md) · [Portala da un’altra app](docs/IMPORT.md) · [Guida al trasloco](docs/MOVE_IN_GUIDE.md) |

## Inizia da qui

Due percorsi brevi per i primi dieci minuti. Scegli il tuo; tutte le funzioni restano disponibili in entrambi.

### L'ho appena installata, e adesso?

<img src="docs/screenshots/first-run.webp" alt="Passo 1 di 4 della configurazione: un campo con il nome Alex e tre schede per quello che farai soprattutto con lei: Compagnia, Programmazione o Entrambi" width="560">

1. **Accedi** con il codice di configurazione dal suo log (o con il tuo token da proprietario).
2. **Dille il tuo nome** e scegli *Compagnia* quando ti chiede cosa farete soprattutto insieme.
3. **Collega un cervello:** ti propone un modello per il tuo computer e controlla che risponda (*Collegato ✓*), oppure usa un piano che paghi già.
4. **Saluta:** tocca *Organizza la mia giornata con me* o scrivi e basta. Dopo la sua prima risposta arriva un breve tour.
5. **Rendila tua** con i cursori della personalità, poi lascia che *Primi passi* su Oggi ti guidi tra la sua voce, il telefono e un riepilogo del mattino.

La guida completa, con immagini: **[Start here](docs/START_HERE.md)**. Tutte le risposte dei riquadri *Come faccio a…?* dell'app in un elenco: **[How do I…?](docs/HOW_DO_I.md)** (in inglese).

### Sono qui per programmare

<img src="docs/screenshots/connect-brain.webp" alt="Passo 3 di 4, Collega un cervello: quattro schede (Su questo computer, Un altro computer di casa, Nel cloud, Il mio abbonamento), Ollama trovato su questo computer con 2 modelli e una scheda Scelto per te con il modello locale gemma4:12b e Collegato" width="560">

1. **Scegli *Programmazione*** nella configurazione: ti propone un modello bravo con il codice (*Buono per programmare*) o il tuo piano Claude Code, Codex o Grok Build.
2. **Apri un progetto** con *+ Progetto*: una cartella di lavoro dove ha file, una shell e git.
3. **Chiedile qualcosa di vero.** Scrive i file, chiede prima di eseguire un comando e mostra i risultati dei test come schede.
4. **Leggi la riga sotto ogni risposta** per ogni comando e il suo output; i comandi rischiosi possono girare prima in una copia isolata.
5. **Portala nei tuoi strumenti:** GitHub, `sara-chat`, VS Code, MCP per Claude Code e Cursor, e budget che fermano un compito lungo dove dici tu.

La guida per chi programma: **[For coders](docs/FOR_CODERS.md)** (in inglese). Dal codice sorgente in tre comandi: [Installazione](#installazione).

## Video tutorial

Guide di un minuto, registrate su un server di prova con un modello locale (in inglese). <a href="https://www.youtube.com/playlist?list=PLGtrs9BqXtM8">Tutti in una playlist</a>.

<table>
  <tr>
    <td align="center" width="25%"><a href="https://www.youtube.com/watch?v=DTAIW75y7i4&list=PLGtrs9BqXtM8&index=1"><img src="https://i.ytimg.com/vi/DTAIW75y7i4/mqdefault.jpg" alt="Installare Sara" width="200"></a><br><sub>Installare Sara</sub></td>
    <td align="center" width="25%"><a href="https://www.youtube.com/watch?v=_X69x9E3W_k&list=PLGtrs9BqXtM8&index=2"><img src="https://i.ytimg.com/vi/_X69x9E3W_k/mqdefault.jpg" alt="Memoria e schede delle persone" width="200"></a><br><sub>Memoria e schede delle persone</sub></td>
    <td align="center" width="25%"><a href="https://www.youtube.com/watch?v=wrvNcHkc9O4&list=PLGtrs9BqXtM8&index=3"><img src="https://i.ytimg.com/vi/wrvNcHkc9O4/mqdefault.jpg" alt="La bacheca" width="200"></a><br><sub>La bacheca</sub></td>
    <td align="center" width="25%"><a href="https://www.youtube.com/watch?v=7i48NiAq-jw&list=PLGtrs9BqXtM8&index=4"><img src="https://i.ytimg.com/vi/7i48NiAq-jw/mqdefault.jpg" alt="Programmare con Sara" width="200"></a><br><sub>Programmare con Sara</sub></td>
  </tr>
</table>

## Novità

<!-- sara:recent-releases:start -->

Versioni recenti · 6 novembre 2026. [Registro completo](CHANGELOG.md) · [Tutti i download](https://github.com/farena-ai/sara/releases).

| Versione | Cosa cambia per te |
|---|---|
| **[3.1.0](https://github.com/farena-ai/sara/releases/tag/v3.1.0)** | **[La posta oltre Gmail](docs/EMAIL.md)** — Outlook.com e Microsoft 365 (posta e calendario), Yahoo, AOL, iCloud, Fastmail, Zoho, GMX, WEB.DE, Proton Mail e qualsiasi altro server: cerca, legge le conversazioni, trova ciò che attende risposta, scrive bozze, invia e riordina con le approvazioni e l'Annulla di Gmail. Più caselle con una predefinita; ogni membro della casa può collegare le proprie, private. |
| **[3.0.3](https://github.com/farena-ai/sara/releases/tag/v3.0.3)** | **[Più veloce, più stabile, più facile da trovare](docs/DEVICE_APPROVAL.md)** — Le impostazioni si aprono subito, c'è una sola ricerca e un'approvazione è sempre a portata (rispondi dalla barra sopra la casella del messaggio o con Ctrl K). Salvare le proprie abilità non chiede più, un punto rosso segna le chat che hanno bisogno di te e la sua risposta dice quanti nuovi ricordi ha salvato. Aggiungere un telefono o un computer è facile da trovare, e il modello scelto all'installazione resta quello predefinito. |
| **[3.0.2](https://github.com/farena-ai/sara/releases/tag/v3.0.2)** | **[Rifiniture, viola e un trasloco facile](docs/MOVE_IN_GUIDE.md)** — Le impostazioni si aprono al centro, il viola è il colore predefinito e una palette ripristina il proprio colore. La decorazione completa è più ricca e Oggi si muove con discrezione (spento con il movimento ridotto). Quattro relazioni non romantiche, un trasloco in cinque passi da Hermes Agent o OpenClaw con il comando esatto per il tuo sistema, e Tess, l'aggiustatutto pratica, nella galleria (grazie a @Guilsc). |
| **[3.0.1](https://github.com/farena-ai/sara/releases/tag/v3.0.1)** | **[Ogni pagina con il nuovo aspetto](docs/APPEARANCE.md)** — Oggi, Agenda, Libreria, Memoria, Valutazioni e Impostazioni con l'aspetto 3.0, con il suo orb di presenza su Oggi. Un'unica lista di progetti nella barra laterale: cartelle che si aprono sulle loro chat con un punto di stato ciascuna, app di chat comprese. La sua immagine può essere l'orb, il suo ritratto o una tua foto con un anello vivo. Le schede delle attività si chiudono su una riga e si aprono da sole quando qualcosa ha bisogno di te; la riga della memoria dice quanti ricordi ha usato. |
| **[3.0.0](https://github.com/farena-ai/sara/releases/tag/v3.0.0)** | **[Sara 3.0: l'aspetto di un sistema vivo](docs/APPEARANCE.md)** — Un aspetto nuovo su ogni pagina, senza togliere nulla: una barra di stato dal vivo con ciò che sta facendo, un orb di presenza che respira, ascolta, pensa e parla, le esecuzioni degli strumenti come cronologia dal vivo con le approvazioni dentro e un segno di verificato solo dove un controllo è davvero passato, una mappa di ciò che sa, un colore d'accento a tua scelta e il suo nome scelto ovunque. Sara Classica non cambia. Su Android, Hey Sara ora funziona sul telefono. |
| **[2.88.0](https://github.com/farena-ai/sara/releases/tag/v2.88.0)** | **[Spazio di codice, Spotify, pagine del team](docs/CODING_DEPTH.md)** — Le attività di codice possono girare in un branch e una cartella propri con Unisci, Apri PR o Scarta alla fine, diagnostica e vai alla definizione con i language server, commit in co-autoria e una vista Spazio con file, editor, terminale e chat. Spotify si collega con la tua app da sviluppatore. Gli spazi aziendali hanno pagine del team con cronologia, commenti e menzioni. Hey Sara ora ascolta su Mac, Android e Linux con lo stesso motore offline di Windows, e la sua connessione agli editor è stata provata con Zed. |

<!-- sara:recent-releases:end -->

<details>
<summary><b>Versioni 2.6x precedenti</b>: dalla 2.87.0 alla 2.61.5</summary>

| Versione | Cosa cambia per te |
|---|---|
| **[2.87.0](https://github.com/farena-ai/sara/releases/tag/v2.87.0)** | **[Lavoratori fissi, controllo della spesa, aggiornamenti più sicuri](docs/WORKERS.md)** — Porta la tua compagna da Character.AI, Replika, Kindroid o Nomi. I prezzi compaiono prima dei passi a pagamento, con limiti giornalieri e mensili e una modalità Risparmio token, e i componenti aggiuntivi possono aggiornarsi da soli e tornare indietro. Gli aggiornamenti per Windows e Mac sono verificati con un avviso firmato e rimettono la versione precedente se la nuova non parte. I lavoratori che restano hanno il proprio thread, una coda di lavori duratura, lavori falliti ripetibili e un solo avviso "ha bisogno di te". Le schede della bacheca possono aspettare la tua risposta, un nuovo dispositivo aspetta un codice che approvi e lei impara come ti piace lavorare senza mai dedurre salute, religione, politica o sessualità. |
| **[2.86.0](https://github.com/farena-ai/sara/releases/tag/v2.86.0)** | **[Imparare un argomento, trigger, app degli strumenti](docs/LEARN.md)** — Chiedile di imparare qualcosa, o dalle un sito: fa ricerche con fonti citate, lo conserva come abilità e lo aggiorna ogni giorno, settimana o mese dicendoti cosa è cambiato. I trigger "Quando succede questo" avviano un'attività o una squadra da un'email, un messaggio Slack o Teams, un webhook o un evento di un server di strumenti, con limiti, budget e approvazioni. Le app dei server MCP compaiono nella chat, isolate dalla pagina, sulla versione attuale di MCP. Altre app possono usare l'API Open Responses, e un chart Helm la esegue su Kubernetes. Accesso aziendale, SCIM, metriche, fonti di segreti, sandbox in container e link di condivisione sono stati verificati con il software reale. |
| **[2.85.0](https://github.com/farena-ai/sara/releases/tag/v2.85.0)** | **[Riunioni, telefono come aiuto, lei al lavoro](docs/MEETINGS.md)** — Una sala riunioni in cui annuncia di essere un'IA che prende appunti e scrive un riassunto con decisioni e azioni (anche da una registrazione). Il tuo telefono può prestarle fotocamera, posizione o una schermata, con Consenti una volta o Nega ogni volta. Al lavoro ha nome, tono, memoria e strumenti propri in Slack e Teams, senza le funzioni da compagna. Più chat ricevono risposte insieme, i membri della casa possono condividere le proprie chat, gli amministratori aziendali hanno un report di spesa e il blocco legale conserva il testo precedente di ciò che viene modificato. |
| **[2.84.0](https://github.com/farena-ai/sara/releases/tag/v2.84.0)** | **[Controlli aziendali, editor, modalità codice](docs/SECRET_SOURCES.md)** — Le chiavi possono stare in HashiCorp Vault, 1Password, variabili d'ambiente, file di segreti o nel portachiavi di sistema. Zed e JetBrains possono usare Sara come agente di codice tramite l'Agent Client Protocol, con le approvazioni nell'editor. Le istanze aziendali accettano SCIM da Entra ID o Okta; conservazione, blocco legale ed esportazione o eliminazione per persona coprono ogni via di eliminazione. Un report di fiducia confronta ciò che ha detto con ciò che è stato eseguito, le voci dello Store mostrano dove sono state verificate, una pagina di prontezza avvia con un clic una prova di ripristino, la modalità codice esegue uno script isolato invece di molte chiamate e un SDK TypeScript senza dipendenze copre la sua API. |
| **[2.83.0](https://github.com/farena-ai/sara/releases/tag/v2.83.0)** | **[Ricerca, Teams, squadre](docs/RESEARCH.md)** — Fai una domanda di ricerca e ricevi un report in cui ogni frase cita una pagina che ha letto (PDF, Word o Markdown). Microsoft Teams si aggiunge a Slack. Le squadre sono gruppi fissi di aiutanti con un capo e orari; un riordino notturno facoltativo della memoria unisce i doppioni, con Annulla per ogni modifica. I comandi possono girare in un container Podman o Docker senza root ed essere limitati ai siti consentiti; le conversazioni si possono condividere come link in sola lettura che scadono; i report di uso e costo coprono ogni persona, spazio e progetto. |
| **[2.82.0](https://github.com/farena-ai/sara/releases/tag/v2.82.0)** | **[Programmi con un clic, 21 compagni](docs/PREREQUISITES.md)** — Quando un componente ha bisogno di un programma che il computer non ha, le Impostazioni dicono cosa manca e offrono *Installalo per me*: approvi il comando esatto, lo vedi eseguire e l'installazione del componente continua (solo il proprietario, registrato nell'audit, disattivabile da un criterio). Ventuno compagni con ritratto, voce e limiti chiari sono nello Store firmato, da tutor di lingue e un allenatore a una compagna di scrittura, un cofondatore di startup e una capitana di nave celeste. Su Linux i server di strumenti per browser trovano il Chrome installato. |
| **[2.81.0](https://github.com/farena-ai/sara/releases/tag/v2.81.0)** | **[Pronta per il lavoro e i team](docs/SLACK.md)** — Sara arriva su Slack con messaggi diretti, menzioni, thread, pulsanti Consenti e Nega e file in entrambe le direzioni. Le istanze aziendali possono accedere con Entra ID, Google Workspace, Okta o Keycloak (solo su invito per impostazione predefinita; la passkey del proprietario funziona sempre). Un'unica traccia di audit a prova di manomissione si esporta in CSV o JSONL, un amministratore può bloccare impostazioni che il server fa rispettare e gli operatori hanno metriche Prometheus e tracce OpenTelemetry senza testo della chat. |
| **[2.80.0](https://github.com/farena-ai/sara/releases/tag/v2.80.0)** | **[Ogni installatore verificato da cima a fondo](docs/ADDONS_LIBRARY.md)** — Ogni server di strumenti e componente nativo delle Impostazioni è stato installato, configurato, collegato, usato e rimosso su un vero server Linux e un vero PC Windows. Aggiornare un server di strumenti mantiene le sue impostazioni, il server Files parte nell’isolamento di Linux, gli errori di accesso e di connessione sono spiegati in parole semplici, un componente dello Store rimosso si può reinstallare e ritirare una compagna appena aggiunta non ferma più il server. |
| **[2.79.0](https://github.com/farena-ai/sara/releases/tag/v2.79.0)** | **[Aspetto avanzato e immagini come una persona](docs/PHOTOS.md)** — Una home Tutte le impostazioni con ogni pagina a un clic, percorsi di navigazione, un avvio Ctrl K, un aspetto raffinato di vetro e luce e una pagina Aspetto più ricca. *Consenti sempre questo strumento* sulle schede di approvazione e un’unica scelta di approvazioni per server di strumenti; le sue foto con Grok, OpenAI, il tuo flusso ComfyUI o un altro strumento di immagini, e ogni tanto un’immagine di sua iniziativa se lo attivi. Le immagini dei server di strumenti arrivano in chat e non dice più di aver mandato qualcosa mai allegato. |
| **[2.78.0](https://github.com/farena-ai/sara/releases/tag/v2.78.0)** | **[Aspetto professionale completo e più componenti](docs/APPEARANCE.md)** — L’aspetto professionale è completo: nome, ora e durata su ogni turno, un’unica etichetta modello · spazio di lavoro con indicatore del contesto, Impostazioni come pannello a tutta altezza, Progetti nella barra laterale e tabelle vere per uso ed esecuzioni. Documentation Doctor, Release Readiness e Repository Onboarding eseguono i comandi documentati come lavori che approvi in una copia usa e getta; su Windows un lavoro fermato termina subito. |
| **[2.77.0](https://github.com/farena-ai/sara/releases/tag/v2.77.0)** | **[Un aspetto professionale](docs/APPEARANCE.md)** — Un aspetto sobrio, denso e preciso (Impostazioni → Tu → Aspetto): 9 palette in Notte e Giorno, un colore d’accento tuo, spaziatura compatta e Meno decorazioni; Sara Classic mantiene l’aspetto di oggi. Inoltre: i feed in Leggere insieme, Test Doctor e Flaky Test Lab, 2 connessioni locali per sviluppatori, e le approvazioni tardive dei plugin non eseguono più nulla. |
| **[2.76.0](https://github.com/farena-ai/sara/releases/tag/v2.76.0)** | **[Componenti per sviluppatori](docs/ADDONS_LIBRARY.md)** — Diciannove componenti per sviluppatori si aggiungono ai dodici flussi in Impostazioni → Plugin (scanner di segreti, verificatore di accessibilità, generatore di SBOM, guardiano dei contratti API, banco HTTP e webhook e altro); li esamini uno per uno e si installano spenti. Gli avvisi sui file possono arrivare anche nella tua chat Telegram o Discord (spento per impostazione predefinita). |
| **[2.75.0](https://github.com/farena-ai/sara/releases/tag/v2.75.0)** | **[Le chiamate come la chat](docs/VIDEO_CALLS.md#what-she-knows-and-can-do-on-a-call)** — In una chiamata vocale o video ha gli stessi ricordi, il contesto delle altre chat e la regola della modalità adulti di quando scrivi, e le chiamate dal vivo possono usare i suoi strumenti (niente comandi, mani o SSH). Ciò che richiede il tuo OK mostra una scheda sullo schermo della chiamata a cui risponde solo un tocco; riattaccare o parlarle sopra la annulla. |
| **[2.74.0](https://github.com/farena-ai/sara/releases/tag/v2.74.0)** | **[Leggere insieme](docs/LIBRARY.md#read-together)** — Apri un documento di testo o Markdown della tua biblioteca, premi Condividi questo passaggio (o attiva Segui il punto in cui sono) e lei commenta esattamente quel testo in quella versione; se è cambiato te lo dice. Ferma lo interrompe subito. Inoltre: le schede dei suggerimenti ora mostrano che la pressione è in corso. |
| **[2.73.0](https://github.com/farena-ai/sara/releases/tag/v2.73.0)** | **[Sorvegliare un file](docs/WATCHES.md)** — Scegli un log o un file in uno dei tuoi spazi di lavoro (o il suo log) e alcune parole come ERROR; Sara invia una scheda in chat e una notifica quando compare una nuova riga corrispondente, al massimo 12 al giorno. Controlla ora, Pausa e Ferma; la lettura non usa modelli e non corregge mai nulla da sola. |
| **[2.72.0](https://github.com/farena-ai/sara/releases/tag/v2.72.0)** | **[Verifiche visive oneste](docs/FOR_CODERS.md#web-pages-look-fix-look-again)** — Nel lavoro web Sara modifica, mostra l’anteprima, fa screenshot desktop e telefono, corregge ciò che appare sbagliato e ricontrolla. Dire di aver controllato la larghezza telefono richiede uno screenshot a quella larghezza, e "è risolto" richiede una verifica dopo l’ultima modifica; altrimenti la risposta è segnata come non verificata. |
| **[2.71.0](https://github.com/farena-ai/sara/releases/tag/v2.71.0)** | **[Continuità dei progetti](docs/FOR_CODERS.md#project-now-other-chats-and-current-checks)** — Le tue chat di codice sullo stesso progetto vedono cosa fanno le altre (titoli e file, mai il testo dei messaggi), e ogni risultato di verifica, obiettivo o checkpoint indica aggiornato, superato o base sconosciuta. Sara ripete una verifica superata prima di dire che passa. |
| **[2.70.0](https://github.com/farena-ai/sara/releases/tag/v2.70.0)** | **[Scene di gioco di ruolo condivise](docs/SCENES.md)** — Una storia nelle tue chat web, Telegram e Discord più una stanza condivisa, con fatti versionati che aggiungi, modifichi o ritiri. Gli ospiti mantengono tutte le regole da partner; le loro parole contano solo quando scegli Aggiungi alla scena. Eliminare o dimenticare una riga cancella ciò che ne deriva; i controlli di sicurezza valgono per ogni scena. |
| **[2.69.0](https://github.com/farena-ai/sara/releases/tag/v2.69.0)** | **[Componenti nelle Impostazioni](docs/ADDONS_LIBRARY.md)** — Dodici flussi su dati forniti usano la normale verifica di file e permessi e partono disattivati. Sette anteprime di ricette MCP, quattordici indagini bloccate e sei guide spiegano requisiti, costi e limiti. Nessuna installazione, connessione o attivazione automatica; la disponibilità nello store firmato resta separata. |
| **[2.68.0](https://github.com/farena-ai/sara/releases/tag/v2.68.0)** | **[Contesto tra le tue conversazioni](docs/SESSION_CONTINUITY.md)** — Contesto recente tra chat consentite del proprietario con la stessa compagna, lettura limitata della cronologia, note interne e passi ordinati del fornitore. Controllo del proprietario, ispezione e cancellazione confermata del solo destinatario scelto; privacy e approvazioni degli strumenti restano valide. Scene condivise, coordinamento dei progetti e piena parità di voce e video restano sviluppi futuri. |
| **[2.67.0](https://github.com/farena-ai/sara/releases/tag/v2.67.0)** | **[Segnali recenti e aggiornamenti sugli eventi](docs/ATTUNEMENT.md)** — Segnali espliciti e circoscritti del proprietario in sei lingue e domande sugli eventi basate su fonti verificate. I **[punti di ripresa del progetto](docs/FOR_CODERS.md#project-checkpoints)** conservano logica, blocchi e fino a tre prossimi passi, con cinque versioni e controlli per consultare, sostituire o cancellare; il contesto storico non esegue comandi e non trasferisce vecchie approvazioni. |
| **[2.65.0](https://github.com/farena-ai/sara/releases/tag/v2.65.0)** | **[Configurazione aziendale guidata](docs/BUSINESS.md)** — Primo utilizzo e amministrazione guidati, cronologia degli inviti nel proprio ambito autorizzato, revoca, verifica della configurazione in sola lettura ed esercitazioni ripetibili di browser e ripristino. |
| **[2.64.0](https://github.com/farena-ai/sara/releases/tag/v2.64.0)** | **[Spazi aziendali separati](docs/BUSINESS_OPERATIONS.md)** — Passkey individuali, ruoli, testi e documenti condivisi, limiti dei modelli controllati dall’operatore e ripristino cifrato. Dati personali e domestici restano separati. |
| **[2.63.1](https://github.com/farena-ai/sara/releases/tag/v2.63.1)** | **[Gestione misurata](docs/OPERATIONS.md)** — Misure HTTP e di preparazione solo per il proprietario, archiviazione sicura delle consegne risolte, backup senza bloccare l’app e verifiche locali ripetibili. |
| **[2.62.0](https://github.com/farena-ai/sara/releases/tag/v2.62.0)** | **[Ripristino senza ripetizioni alla cieca](docs/RECOVERY.md)** — Rivedi i lavori interrotti prima di riavviarli; gli invii nativi Telegram/Discord incerti restano visibili, senza reinvio automatico. |
| **[2.61.5](https://github.com/farena-ai/sara/releases/tag/v2.61.5)** | **[Trova il prossimo passo](docs/START_HERE.md)** — Ricerca mirata nelle Impostazioni, percorso più semplice al primo messaggio e navigazione migliore con tastiera, tocco e movimento ridotto. |

Inoltre in 2.67.0: accesso affidabile ai Progetti di codice dalla ricerca nelle Impostazioni, bozze conservate e gestione delle risposte obsolete, privacy delle conoscenze del progetto nelle chat senza registrazione e controllo locale di aggiornamento delle sei pagine di versione. Nessuna CI né controllo ricorrente dei rilasci. I punti di ripresa sono riservati al proprietario e al relativo spazio/progetto; eliminare, modificare o dimenticare i contenuti di origine coperti invalida i record derivati. Le azioni di codice in attesa, comprese quelle degli assistenti del team e l’applicazione delle modifiche della sandbox, ricontrollano i permessi attuali e il contesto della conversazione e dello spazio di lavoro prima dell’esecuzione; un cambio di contesto ferma l’azione obsoleta invece di spostarla.

La versione 2.67.0 distingue inoltre le critiche al codice dai conflitti rivolti a Sara, ricontrolla le fonti dei segnali e delle domande sugli eventi immediatamente prima della normale chiamata al fornitore e chiude automaticamente gli elementi di Agenda solo con prove chiare dell’evento, del risultato e della domanda corrispondente. Vita interiore resta il controllo di attivazione; non ci sono diagnosi emotive, chiamate aggiuntive a un classificatore o nuovi profili dell’umore del proprietario. I nuovi segnali escludono chat private o senza registrazione, membri, gruppi, contesti esterni, riproduzione e lavoro senza supervisione. Prompt registrati, esportazioni e backup possono conservare note con i controlli abituali; la riproduzione omette i nuovi extra transitori registrati e segnala che gli input sono cambiati. Questa versione corregge anche l’identificazione automatica della revisione sorgente dell’installer Windows.

</details>

<!-- sara:release-history:start -->

<details>
<summary><b>Novità precedenti · 2.61, 2.60 e 2.59</b></summary>

- **2.61** ·  Configurare le app di chat è più semplice: una scheda guidata per WhatsApp, Matrix, iMessage, Signal, email e Telegram, ogni passo verificato, con soluzioni chiare; i plugin di Sara chiedono solo un OK, non un avviso per sviluppatori.
- **2.60** · Pacchetti compagna: condividi carattere, aspetto, voce e skill iniziali di una compagna come file o sul Sara Store, senza mai condividere i tuoi ricordi o le tue chat; si importano anche le schede personaggio.
- **2.59** · «Hey Sara»: di' il suo nome per parlare a mani libere nell'app per Windows (un piccolo modello sul tuo computer ascolta solo quello), una scorciatoia per parlare ovunque, e ascolto e voci locali su Windows.

</details>

<details>
<summary><b>Cronologia delle versioni</b>: cosa ha portato ogni versione dalla 2.4</summary>

| Versione | Cosa ottieni |
|---|---|
| **2.61.4** · [v2.61.4](https://github.com/farena-ai/sara/releases/tag/v2.61.4) | **[Configurazione più affidabile](docs/SECURITY_CHECKLIST.md)** — Riprendi la configurazione del modello dopo averla saltata, mantieni il focus mobile al posto giusto e distingui l’approvazione dei comandi dall’isolamento di esecuzione. |
| **2.60** · Pacchetti compagna | **Condividila:** Impostazioni → Lei → ⋯ → *Condividila* crea un pacchetto con esattamente ciò che spunti (carattere, cursori, aspetto, guardaroba, voce, primo messaggio, skill, routine suggerite) e mostra cosa non esce mai: ricordi, chat, persone, chiavi, il tuo nome (diventa `{{user}}`), le tue note sulla relazione e i tuoi limiti. **Installa un pacchetto** come nuova compagna, mai sopra una che hai già, tramite una scheda di revisione; gli aggiornamenti mostrano cosa ha cambiato l'autore e tengono le tue modifiche. Le schede personaggio V1/V2/V3 (PNG, JSON, CHARX) si importano come pacchetti, e un lorebook diventa poche righe di sfondo, mai ricordi. Il controllo sui minori avviene alla creazione, alla revisione e all'installazione, senza eccezioni; le classificazioni seguono la modalità adulti. Quattro compagne iniziali nel negozio: Juniper, Rowan, Vesper e Jax. Sistemato anche: esportare una scheda personaggio non include più il tuo nome né le tue note. |
| **2.59** · «Hey Sara» | **Di' il suo nome e parla** nell'app per Windows: un modello da 5 MB sul tuo computer ascolta solo «Hey Sara» (o parole tue per ogni compagna), e non viene inviato nulla finché non le dici; la registrazione parte dopo la frase, l'audio non viene mai conservato e un punto sull'icona nella barra mostra quando ascolta. Spento finché non lo accendi, su ogni dispositivo; in pausa a schermo bloccato; se due dispositivi ti sentono, risponde uno. **Parla con Sara** con Ctrl+Alt+Spazio o dalla barra, e su Android con un pulsante Parla nella notifica e un riquadro nelle impostazioni rapide. L'avviso IA viene detto per primo e l'aiuto in caso di crisi letto per intero. **Ascolto e voci locali su Windows:** `sara voice install` (circa 650 MB, ogni file controllato), prima solo su Linux. Mac, Linux e il rilevatore Android sempre in ascolto arrivano dopo. |
| **2.58** · Prendine altri | **Impostazioni → Abilità → Prendine altri:** sfoglia e cerca nel Sara Store, apri un elemento e installalo con un clic tramite la solita scheda di revisione (niente si accende da solo). I server di strumenti hanno una scheda con il comando esatto (e la sua forma per Windows), cosa serve, cosa può raggiungere e se è isolato; le chiavi vanno nella cassaforte. **Gli aggiornamenti** mostrano esattamente cosa cambia, con i nuovi permessi evidenziati, e puoi tornare indietro. **I miei componenti** elenca tutto con la provenienza. **Invia i tuoi:** `sara pack` controlla un plugin, una skill o un server di strumenti sul tuo computer (manifest, permessi, ricerca di segreti, prova rapida isolata, screenshot), poi *Invia* nelle impostazioni o `sara submit` lo spedisce, firmato con la tua chiave d'autore. Il team di Sara lo controlla prima di pubblicarlo, e in *I miei invii* puoi seguirlo e rispondere. Segnalazioni e rimozioni spengono un componente, non lo cancellano mai. |
| **2.57** · Apre il Sara Store | **Uno scaffale firmato** su [backstagecoding.com/sara/store](https://backstagecoding.com/sara/store/): Avvisi meteo, Concentrazione, Scene di casa, Riepilogo GitHub, Lista di lettura e Note webhook, più server di strumenti per ComfyUI, Blender, un browser (Playwright), GitHub, i file di questo computer e la documentazione (Context7), ognuno con una versione esatta fissata. Sara controlla la firma della lista, l'impronta di ogni file e la scadenza prima di mostrare qualcosa; una lista danneggiata, vecchia o ritirata viene rifiutata e si tiene l'ultima buona. Sfogliare non invia identificativi né cookie. Le installazioni passano sempre dalla solita scheda di revisione e niente si accende da solo; ciò che viene ritirato dal negozio si spegne, non si cancella mai. **Riordino delle skill:** quelle inutilizzate si possono archiviare e riprendere. Prossimamente: installare da Sara e inviare le tue. |
| **2.56** · Leggera e ordinata | **Una lista corta di strumenti per passo:** scelta nel codice (senza chiamare modelli) in base a cosa stai facendo: la modalità, le tue parole, i riferimenti `@`, l'uso recente, una skill caricata, i giri precedenti di un obiettivo, più gli strumenti sempre tenuti per sicurezza. Il resto lo trova lei con *find tools*, e ogni chiamata è sempre controllata contro tutto ciò che le è permesso. Misurato: un'installazione nuova passa da 11.871 a 5.471 token per passo (−54 %); con quattro server MCP, da 23.476 a 5.438 (−77 %). `/tools` mostra cosa viene offerto. **`/compact`:** riassume la parte vecchia di una chat lunga, scritto prima su questo computer (le chat private non lo lasciano mai). I tuoi messaggi restano nel filo, con *Mostra riassunto* e *Annulla*; parte anche da solo vicino al limite e i messaggi di crisi restano parola per parola. Funziona in ogni app di chat. |
| **2.55.3** · MCP su Windows | Corretto: su Windows i server MCP avviati con `npx` (compresi i modelli integrati) non partivano. |
| **2.55.2** · iMessage | **iMessage tramite BlueBubbles** (Impostazioni → Collegamenti → iMessage, un plugin facoltativo): scrivile da Messaggi sul tuo iPhone. Serve un Mac con BlueBubbles e un ID Apple tutto suo (Sara si rifiuta di usare il tuo, vedrebbe tutte le tue chat). Otto passi guidati controllati con un ✓, soluzioni semplici, testo, foto e file, e recupera ciò che è arrivato mentre era offline. Puntini di scrittura e tapback solo se la Private API di BlueBubbles è già attiva; Sara non ti chiede mai di abbassare la sicurezza del Mac per questo. |
| **2.55.1** · Matrix | **Matrix** (Impostazioni → Collegamenti → Matrix, un plugin facoltativo): parlale in Element o in qualsiasi app Matrix tramite un suo account Matrix. Cinque passi guidati, ognuno controllato con un ✓, e soluzioni semplici per ogni errore. Testo, foto e messaggi vocali; solo tu a meno che non permetta ad altri (anche interi server); gli inviti di sconosciuti vengono rifiutati. Solo stanze senza crittografia end-to-end: in una stanza cifrata spiega perché non può leggerla ed esce. |
| **2.55** · WhatsApp | **WhatsApp** (Impostazioni → Collegamenti → WhatsApp, un plugin facoltativo): scrivile tramite l'API WhatsApp Cloud ufficiale di Meta, con un account e un numero Meta tuoi. Una scheda guidata in 10 passi indica le schermate esatte di Meta, controlla ogni passo con un ✓ e trasforma ogni errore in una frase semplice con la soluzione. Foto e file in entrambe le direzioni, puntini di scrittura e una riga *Ci sto lavorando* con Ferma per i lavori lunghi, solo tu a meno che aggiunga altri numeri, e i suoi primi messaggi solo nella finestra di 24 ore di WhatsApp. Le condizioni di Meta limitano gli assistenti IA generici su WhatsApp, quindi resta spento finché non lo installi e confermi di averle lette. |
| **2.54** · Routine e un controllo di sicurezza | **Galleria di routine** (Agenda → Routine): briefing del mattino, resoconto settimanale, promemoria per sgranchirsi e per andare a letto, uscire in tempo, controllare la CI di un repo, nuove issue, controllo dei backup, smistare la posta e avviso prezzo. Ogni scheda dice cosa fa, cosa le serve e quanto costa, calcolato nel codice (quasi tutte gratis), mostra un'anteprima senza chiamare modelli e ha un interruttore; quelle a pagamento finiscono alla data che scegli. Gli strumenti mantengono le tue impostazioni di approvazione. **Controllo di sicurezza** (Impostazioni → Dati e salute): 17 controlli in sola lettura, un verdetto a parole (*Sembra sicuro*, *Quasi tutto sicuro*, *Sistema prima questi*) e correzioni in un clic che possono solo rendere tutto più sicuro, ognuna dicendo se si può annullare. I cambiamenti su come si raggiunge Sara sono guidati, mai in un clic. Anche `sara doctor --safety`. |
| **2.53** · Precisione nel codice | **Controlli dopo le sue modifiche:** quando cambia il codice, Sara esegue il controllo del progetto (tsc, pyright o mypy, cargo check, go vet, eslint), già installato, mai `npx`, senza installare niente, e le passa solo gli errori nuovi nello stesso turno, compresi i file che la modifica ha rotto altrove. Li sistema prima di rispondere (al massimo due solleciti) e la risposta mostra *✓ types clean (tsc)* o cosa resta. Un OK per progetto. **Riferimenti @:** scrivi `@` nella chat per `@file` (con righe), `@folder`, `@diff`, `@branch`, `@problem` o `@url`; le etichette mostrano cosa riceverà e quanto pesa, e funziona come testo in Telegram, Discord e le altre app. I file segreti vengono rifiutati e le chat private non aprono mai pagine web. |
| **2.52.1** · Collegare un server è facile, foto sistemate | *Collega un server* chiede solo indirizzo e utente; Sara crea la sua chiave, trova la porta e il modo più semplice per entrare (un token cPanel che cancella lei, la tua password una volta o una riga da incollare) e spiega ogni errore con parole semplici. Le foto arrivano sempre a un modello che le vede. |
| **2.52** · Quando se ne parla | **Promemoria che aspettano una persona o un argomento:** «quando salta fuori Dan, ricordami che mi deve 20 $» o «la prossima volta che parlo dell'orto, chiedi dei pomodori». Lo tira fuori una volta, nella sua risposta, con *Fatto*, *Ancora la prossima volta* o *Dimentica*. Il riconoscimento usa le tue schede persona e parole semplici, senza chiamare nessuna IA, e tra due Dan non tira mai a indovinare. Scattano solo sui tuoi messaggi nelle tue chat, mai dove Dan potrebbe leggere, e ciò che invierebbe a qualcun altro contenendone uno chiede prima. **Riprendere una chat in un'altra app:** inizia su Telegram, apri l'app e *Continua qui* porta con sé quella chat (`/continue` ovunque), con *Mostra* e *Annulla*; non si copia niente. |
| **2.51** · Continua finché è fatto | **Obiettivi con prova:** «fai passare i test, fatto quando `npm test` è verde»: lavora un giro dopo l'altro entro dei limiti (giri, minuti, token, dollari) e Sara esegue il tuo controllo, non lei, quindi *fatto* vuol dire che è passato davvero. Un verde arrivato solo dopo aver modificato i test finisce come *fatto, da rivedere*; lo stesso errore due volte la mette in pausa come *bloccata*. **`/loop every 10m: check the deploy`**: in silenzio finché non cambia niente, un messaggio quando cambia, si ferma con *until* (con prova), dopo due errori, all'ora di fine o a un limite giornaliero, e non chiede mai approvazioni senza di te. Le schede della bacheca possono avere un controllo *Fatto quando*. Dopo un riavvio tutto torna in pausa. Sistemato anche: modificare file con fine riga Windows falliva. |
| **2.50** · Signal ed email | **Altri due modi per raggiungerla, già inclusi.** *Signal* tramite signal-cli sul tuo computer: gruppi come stanze con aggiornamento, 👀 quando prende la tua nota, un messaggio di avanzamento dal vivo, file nei due sensi e il tuo numero di sicurezza fissato, così una chiave cambiata mette in pausa i suoi strumenti finché non confermi. *Email* nella sua casella: una sessione per conversazione, risposte nella conversazione, la tua posta conta come tua solo se supera il controllo del mittente del tuo provider, agli sconosciuti non risponde mai, la posta inoltrata fa chiedere prima ogni strumento e risposte automatiche, newsletter e rimbalzi non creano mai cicli. Sara tiene le connessioni di questi plugin, solo verso gli indirizzi che hai inserito. Sistemato anche: una risposta di una chat via plugin oltre i 5 minuti veniva tagliata. |
| **2.49** · Parlarle mentre lavora | **Niente più attese finché non ha finito.** Scrivi mentre lavora e scegli: *Diglielo ora* (lo legge prima del passo successivo e cambia rotta; non può mai approvare niente), *Dopo* (aspetta e parte come turno a sé) o *Solo una domanda* (`/btw`: una risposta veloce a parte, non si salva nulla, il lavoro continua). Lo stesso su Telegram e Discord (`/queue`, `/btw`). Un **blocco dei cicli** la ferma dopo tre chiamate identiche fallite e la costringe a cambiare approccio. |
| **2.48** · Le app di chat si mettono in pari | **Foto e file nei due sensi su Telegram e Discord:** mandale una foto (con didascalia, un album o come file) o un documento e lo legge; chiedile un selfie, un grafico o un file e arriva (`send_file`). Le foto di altre persone in una stanza restano spente finché non le attivi, e allora vede solo una descrizione. **Un solo messaggio di avanzamento** si aggiorna mentre lavora, ha un pulsante Ferma e finisce come una riga di riepilogo. Anche i ponti dei plugin possono portare file. |
| **2.47.3** · Inizia da qui | **Due ingressi:** [Inizia da qui](docs/START_HERE.md) per «l'ho installata, e adesso?» e [Per chi programma](docs/FOR_CODERS.md), entrambi con i video (in inglese). Schermate nuove, il giro delle funzioni diviso in *Per compagnia*, *Per programmare* e *Per entrambi*, tutte le risposte *Come faccio a…?* in un indice (nella guida e sul sito della documentazione) e un sito della documentazione riorganizzato. |
| **2.47.2** · Un solo stile e aiuto in ogni pagina | **Ogni pagina ora ha un riquadro *Come faccio…?*** con risposte passo passo (123, con *Mostrami*), e le pagine vuote dicono cosa ci va con un passo chiaro. Un solo stile di scheda, icone al posto delle emoji, spaziature e angoli uniformi, un menu delle impostazioni che apre un gruppo alla volta, il telefono più ordinato e senza scorrimento laterale, una prima schermata di accesso più chiara, e la configurazione per programmare preferisce un modello capace sul tuo computer. |
| **2.47.1** · Un primo avvio su misura | **La configurazione fa una domanda: compagnia, programmazione o entrambe.** Ricevi un modello consigliato con una vera prova *Connesso ✓*, un tour di sei tappe adatto (quello completo resta in Aiuto), suggerimenti per iniziare in una chat vuota e una lista dei primi passi nell'ordine giusto per te. Le finestre non si sovrappongono più, e la nota sul segnale anonimo è nell'ultimo passo. |
| **2.47** · Una personalità che si vede | **I suoi regolatori di personalità ora mostrano cosa fanno:** estremi chiari («Tiene le distanze ↔ Apertamente affettuosa»), una parola per la posizione e una frase con la sua voce che cambia mentre lo sposti (125, senza chiamare nessuna IA). Gruppi con nomi semplici, un riepilogo «La tua Sara finora» e parole chiare su ogni altro cursore. Sistemato anche: Oggi si aggiorna dopo la configurazione, lo stesso numero di modelli ovunque con una scelta raggruppata, importare una persona la rinomina ovunque in una volta e *Parti alle* viene prima del suo evento. |
| **2.46** · Segnala un problema da Sara | **Aiuto → Segnala un problema o Suggerisci qualcosa** (o `/bug` e `/idea` in qualsiasi chat, o *Segnala* su un errore): senza account GitHub. La diagnostica facoltativa nasce sul tuo computer, viene mostrata per intero con una casella per parte e ripulita da chiavi, email e percorsi prima di inviare. *Le mie segnalazioni* mostra lo stato e le nostre risposte. Sara invia anche un piccolo segnale anonimo al giorno (versione, Windows/Mac/Linux, quali funzioni sono attive) per aiutarti e pianificare; non conserviamo IP, nome o chat. *Mostra cosa viene inviato* o spegnilo in Impostazioni → Dati e stato → Privacy. |
| **2.45** · Oggi sul telefono | **Sul telefono, Oggi si apre con una scheda Adesso** (le prossime due cose e fra quanto, quando partire, il meteo e il suo umore), poi *Ti aspetta*, poi la tua giornata. Le sezioni si chiudono con un riassunto e restano come le hai lasciate su quel dispositivo, *Con lei* e *Lavoro* diventano righe da scorrere (anche con pulsanti) e il trascina per aggiornare funziona nel browser e nelle due app. I tablet hanno due colonne. Facoltativo: una frase sua su cosa è successo mentre eri via. |
| **2.44** · Oggi, progettato | **Oggi è organizzato con cura:** *La tua giornata* (una linea del tempo con eventi, promemoria e cose da fare, il meteo e cosa arriva), *Ti aspetta* (approvazioni, errori, scadenze passate e la posta), *Con lei*, *Lavoro* e *Casa e altro*. Le righe sono sempre allineate, i riquadri vuoti si chiudono e *Personalizza* sposta, ridimensiona o nasconde ogni riquadro (trascinando o da tastiera), salvato per compagna su ogni dispositivo. La posta mostra la casella, il cambiamento da ieri e cosa ha sistemato lei, con Annulla, e si aggiorna da sola dopo una pulizia. Un riquadro Stanze opzionale mostra cosa succede nelle stanze che segue. |
| **2.43** · Segue la stanza | **Nei canali Discord e nei gruppi Telegram segue tutta la conversazione** (si accende per stanza; una scheda col piano mostra prima il modello e il limite giornaliero). Quando qualcuno la chiama sa di cosa si parla adesso, chi c'è e cosa è cambiato dal suo ultimo intervento, così entra nell'argomento attuale e non in uno di un'ora fa. Ogni settimana viene archiviata nella sua Biblioteca come trascrizione ricercabile e riassunta in una memoria della stanza con note sulle persone (schede persona proposte). *Dimentica questa stanza* cancella tutto. 12 canali affollati riprodotti in 6 lingue: argomento attuale 12/12. |
| **2.42** · Titoli che crescono | **Titoli che dicono di cosa parlava la chat.** Il primo è provvisorio; dopo qualche scambio, quando l'argomento cambia chiaramente e a `/new`, un piccolo modello sul tuo computer le ridà un nome («Iniziare un orto» → «Dichiarazione dei redditi da freelance»). I titoli che scegli tu non cambiano mai, i precedenti restano nelle info della chat, niente di sensibile o privato finisce in un titolo, e c'è un limite giornaliero. 40 sessioni di prova: 0,90 sull'argomento con un modello locale da 12B. |
| **2.41** · Un elenco di sessioni ordinato | **Ogni app di chat ha il suo progetto.** Telegram, Discord e ogni ponte plugin (WhatsApp, Signal…) hanno un progetto integrato che raccoglie le loro chat, così le tue conversazioni web e app restano nei tuoi progetti. Le chat esistenti vengono sistemate una volta, con Annulla. Le stanze mostrano il loro vero nome (#general · Server), le sessioni precedenti stanno sotto la loro chat e le liste lunghe mostrano le più recenti con *Mostra altro*. Rinomina o nascondi un progetto di canale; raggruppa per stanza quello più affollato. |
| **2.40** · Comandi in chat | **`/new`, `/reset`, `/stop`, `/status`, `/help`, `/model` e `/remember` ovunque:** in Telegram e Discord (nei loro menu dei comandi, registrati per te, nella tua lingua), nell'app web e come «Sara, nuova» dove la barra non è comoda. `/new` apre una sessione nuova e tiene la vecchia (riassunta); `/status` mostra il modello, quanto è piena la sessione e il consumo; quando una sessione è quasi piena è lei a proporre `/new`. I comandi riservati al proprietario sono rifiutati a chiunque altro, ogni volta. |
| **2.39** · Trasloco: impostazioni e resoconto | **Il resto della vecchia configurazione.** Modelli e fornitori, voce, fuso orario, canali di chat, approvazioni e regole del vecchio agente diventano schede da confermare una per una (le chiavi non vengono mai copiate: le reinserisci tu, al sicuro). Hook e codice dei plugin vengono letti come testo, mai eseguiti, e spiegati in parole semplici con un equivalente in Sara (una regola sulla sua scheda, un controllo che chiede prima, una funzione già presente o un piano per rifarlo come plugin di Sara). Le copie doppie dei database vengono riconosciute e importate una volta sola. Alla fine un resoconto: cosa è arrivato, cosa ti aspetta, cosa è rimasto e dove vive ora in Sara ogni vecchia funzione (scaricalo, o annulla tutto). |
| **2.38** · Trasloco: i suoi database | **Arrivano anche gli archivi di memoria fatti in casa.** Se il vecchio agente teneva la memoria in un suo database SQLite o Postgres, Sara lo legge (Postgres in sola lettura, con un suo client, o un file `pg_dump`), salta log e telemetria e propone per ogni gruppo di tabelle cos'è e dove va (note, persone e fatti, conversazioni, attività, obiettivi, diario). Confermi ogni scheda; prima non si importa nulla. Le corrispondenze confermate vengono salvate, e Annulla toglie comunque tutto. |
| **2.37** · Trasloco | **Porta con te il tuo agente.** Arrivi da Hermes Agent o OpenClaw? Un piccolo file (Python, niente da installare) gira sulla vecchia macchina e ti mostra prima il suo piano; i segreti non vengono mai impacchettati e i dati medici o intimi restano lì se non decidi altrimenti. Sara poi mostra tutto con numeri ed esempi: la personalità (decidi tu), le note e cosa sapeva di te, le chat passate, abilità, pianificazioni e bacheche. Un clic importa tutto in un solo lotto, e Annulla toglie esattamente quel lotto per 30 giorni. |
| **2.36** · I suoi piani | **A scelta: tiene i suoi piani.** Domande di seguito su ciò che le hai detto («com'è andato il colloquio?») e obiettivi da portare avanti insieme, presi solo dalle tue parole e sempre con il punto in cui l'hai detto. Spento di default; acceso, Agenda → *I suoi piani* mostra tutto, condivide con i suoi primi messaggi il limite giornaliero, le ore di silenzio e la regola della pausa, ha un piccolo budget giornaliero, si ferma dopo un momento difficile, e un solo interruttore ferma tutto subito, anche a metà frase. Gli obiettivi aspettano il tuo *Usalo*. |
| **2.35** · Webhook | **Altri servizi possono svegliarla.** Dai a GitHub, Stripe, Home Assistant o a qualsiasi cosa parli Standard Webhooks il suo indirizzo firmato; scegli quando conta (condizioni senza codice, con modelli) e cosa fa lei: avvisarti, aggiungere un'attività, eseguire un'abilità o passarlo a un plugin. Le firme si controllano sui byte originali, consegne vecchie o ripetute vengono rifiutate e il contenuto non è affidabile: ciò che cambia qualcosa chiede ancora a te. Registro delle consegne e pulsante di prova su ogni scheda; copie in uscita firmate se vuoi. |
| **2.34** · Persone | **Tiene traccia delle persone della tua vita.** Una scheda per ogni persona di cui parli (rapporto, compleanno, cosa sa con le tue parole), costruita dai suoi ricordi. Le nuove aspettano il tuo *Va bene*; correggi, unisci, dividi o dimentica chi vuoi (dimenticare cancella davvero). Due Jeff? Chiede quale. Il privato resta nelle chat private e il sensibile viene ripiegato. Le schede non arrivano mai ad altre app, altri agenti, plugin, chat di gruppo o di coppia; ogni membro della casa ha le sue. |
| **2.33** · Altri agenti (A2A) | **Parla con altri agenti IA** con il protocollo aperto Agent2Agent, in entrambe le direzioni, scritto dalla specifica. Dai a un agente la sua chiave e scegli cosa può chiedere; lei può interrogare gli agenti che aggiungi (un'altra Sara o qualsiasi agente A2A), seguirne le risposte in diretta, fermarli o assegnar loro una scheda della bacheca che torna con le prove. Ciò che un agente chiede e che cambia qualcosa richiede il tuo OK; le sue parole non sono affidabili; nulla di privato, di coppia o di gruppo esce; dice di essere un'IA. 61/61 controlli del protocollo. |
| **2.32** · Bacheca | **Una bacheca Kanban sulle tue attività.** Ogni progetto ha una bacheca (Da fare, In corso, Aspetta te, Fatto) con etichette, checklist, scadenze e ripetizioni; trascina con mouse, dito o tastiera. Assegna una scheda a Sara o a un team di aiutanti e lei ci lavora in background: va in Fatto solo se le prove sostengono il lavoro, altrimenti ti aspetta con ciò che non ha potuto dimostrare. Chiedile «cosa è bloccato?» o di aggiungere e spostare schede (chiede prima). Bacheche condivise della casa; un riquadro Serve a te in Oggi. |
| **2.31** · Plugin | **Plugin e hook.** Un plugin è una cartella con un `sara-plugin.json`: hook prima della sua risposta, prima e dopo gli strumenti e dopo le risposte, più strumenti, schede, impostazioni, pianificazioni e ponti chat propri. Lo aggiungi da zip, git o cartella dopo aver letto una scheda che spiega cosa può fare; resta spento finché non lo accendi. Ognuno gira in un proprio processo isolato (bubblewrap su Linux, Seatbelt sul Mac) e può solo aggiungere o restringere, mai allentare le sue regole o toccare il livello di sicurezza. Un plugin che si blocca o va in crash non rompe mai una chat. Due esempi inclusi; guida in docs/PLUGINS.md. |
| **2.30** · Abilità imparate | **Si accorge di cosa chiedi spesso.** Chiedi la stessa cosa tre volte in giorni diversi (o ripeti la stessa catena di passi di codice) e lei propone, una volta, di farne un'abilità: vedi la bozza e la salvi, la modifichi o dici di no. Una nuova abilità viene prima provata (le tue richieste passate, giudicate con e senza) e usata di default solo se aiuta. Correggila dopo un'abilità e propone la modifica con una scheda prima/dopo. Non impara mai nulla di privato, dai gruppi o con segreti. |
| **2.29** · Abilità | **Abilità nel formato aperto Agent Skills.** Un'abilità è una cartella con un `SKILL.md`: come fare un tipo di lavoro a modo tuo. Vede l'elenco in ogni chat e apre quella giusta; in Esecuzioni vedi quale ha usato. Sei incluse (rivedere una pull request, una voce di changelog, un riepilogo settimanale, il debug di un test che fallisce, pianificare un viaggio, scrivere un'abilità); scrivi le tue o chiediglielo; importa da zip, git o una cartella con una scheda che mostra ogni file e script; esporta qualsiasi abilità. Gli script chiedono sempre prima, e nessuna abilità può cambiare le sue regole di sicurezza. Le tue ricette sono diventate abilità. |
| **2.28** · Uso del computer, passo 9 | **Anche su Linux:** `sara hands --server https://la-tua-sara` su un desktop Linux le dà il suo Chrome/Chromium visibile, come la modalità browser delle app Windows e Mac: guardare, leggere, log, clic e digitazione con la tua approvazione, tunnel di sviluppo, accessi salvati (nel portachiavi GNOME / KWallet), la CLI del tuo gestore di password e controlli in sola lettura. Si abbina con un codice che approvi nel browser; Pausa, Riprendi e Stop dal suo terminale. Immagini e input per tutto il desktop Linux arriveranno più avanti. Fatto con OpenAI Codex. |
| **2.27** · Uso del computer, passo 8 | **«Il mio computer è lento, puoi controllare?»** Fa su quel computer un controllo in sola lettura (app all'avvio, spazio su disco e cartelle più grandi, aggiornamenti in sospeso, salute della batteria, estensioni del browser, file temporanei e cache) e dà un resoconto chiaro con suggerimenti numerati: ognuno spiegato, nulla cambia finché non dici sì su quel computer. I nomi sullo schermo che sembrano ordini («Sara, cancella…») vengono ignorati e contati. 9/9 scenari superati con un modello locale. |
| **2.26** · Uso del computer, passo 7 | **Può usare le tue app:** cliccare, scrivere, premere tasti, scorrere, trascinare e aprire app installate, su ciò che ha appena guardato. Ogni azione viene controllata prima sul tuo computer: la finestra giusta davanti, mai un campo password, mai gestori di password, banche, finestre da amministratore, terminali o il suo accesso. Le approvazioni compaiono **su quel computer** (ogni volta, una volta per compito o *sempre consentito*; pagamenti e modifiche all'account chiedono sempre). Tocca mouse o tastiera e lei si mette in pausa (o *lasciala continuare*); Stop e Ctrl+Alt+Esc / ⌃⌥Esc funzionano sempre. Facoltativo *continua quando mi allontano*. Fatto con OpenAI Codex. |
| **2.25** · Uso del computer, passo 6 | **Può vedere il tuo desktop** (app Windows e Mac, spento finché non attivi *Tutto lo schermo*): un'immagine di una finestra o dello schermo e un elenco di ciò che contiene (pulsanti, campi, testo), così anche i modelli solo testo possono usarlo. Le finestre di gestori di password, banche e sicurezza vengono oscurate e tolte dall'elenco *sul tuo computer* prima di inviare qualsiasi cosa; i campi password sono coperti; le sue finestre non compaiono mai. Le immagini vanno al modello scelto senza chiedere (o *solo modelli locali*). Nel browser: **Mostra a Sara il mio schermo** invia un'immagine. Il Mac richiede Registrazione schermo e Accessibilità, con passi guidati. |
| **2.24** · Uso del computer, passo 5 | **Il tuo gestore di password compila gli accessi nel suo browser:** Bitwarden, 1Password o KeePassXC, ognuno spento finché non lo accendi. Lo sblocchi tu nella finestra del gestore (lei non vede mai la tua password principale); ogni uso chiede prima; compila solo sul sito esatto dell'accesso; lei lo riblocca dopo il compito, dopo 15 minuti di inattività, con Stop o con *Blocca ora*. Nulla arriva al server di Sara né al modello. Il suo browser non propone più di salvare le password da solo. |
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

</details>

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

<!-- sara:release-history:end -->

Tutte le versioni: [CHANGELOG.md](CHANGELOG.md) · [versioni](https://github.com/farena-ai/sara/releases).

### In arrivo

Consulta il [piano pubblico](docs/ROADMAP.md) per il lavoro rimasto e [Discussions](https://github.com/farena-ai/sara/discussions) per le idee. Gli spazi aziendali sono disponibili; validarli sul tuo dominio, con colleghi reali e una prova di ripristino, è un passo separato. Su iPhone, usa l’[app web nella schermata Home](docs/PHONE.md).

## Per sviluppatori

<img src="docs/images/brand/sara-for-developers.webp" alt="Illustrazione con l’etichetta Sara · for developers: Sara a un banco da officina mentre inserisce pezzi di puzzle luminosi e ingranaggi d’ottone in una piccola macchina" width="860">

Piccola e leggibile: TypeScript che Node esegue direttamente, nessuna fase di build, zero dipendenze a runtime, costruita da zero (non basata su Hermes Agent né su OpenClaw).

| Vuoi… | Parti da |
|---|---|
| Vedere come si incastra tutto | [Architettura](docs/ARCHITECTURE.md), modulo per modulo (schema qui sotto) |
| Aggiungere uno strumento, un ponte, un personaggio, un server MCP, una lingua, un progetto iniziale o un fornitore di modelli | [Estendere Sara](docs/EXTENDING.md) |
| Creare un componente aggiuntivo per lo Store o una ricetta di server di strumenti | [Libreria dei componenti aggiuntivi](docs/ADDONS_LIBRARY.md) · [Sara Store: invia il tuo](docs/STORE.md) · [Plugin](docs/PLUGINS.md) |
| Eseguire i controlli | `npm run check` (controllo dei tipi e tutti i test, con un modello scriptato e senza chiamate ai provider) · `node scripts/check-links.ts` · [CONTRIBUTING.md](CONTRIBUTING.md) |
| Scrivere un plugin o un’abilità | [Plugin](docs/PLUGINS.md) (`sara-plugin.json`, hook, processi isolati) · [Abilità](docs/SKILLS.md) (il formato aperto Agent Skills) · [Inviare allo Store](docs/STORE.md) |
| Chiamare Sara dal tuo codice | [Altre app](docs/OTHER_APPS.md): API compatibile con OpenAI e server MCP · [Altri agenti (A2A)](docs/A2A.md) · [Webhook](docs/WEBHOOKS.md) |
| Controllare i numeri | [Risultati](docs/RESULTS.md): benchmark e valutazioni, e come ripeterli |
| Contribuire | [CONTRIBUTING.md](CONTRIBUTING.md) · [Issue per iniziare](docs/GOOD_FIRST_ISSUES.md) · [Tradurre](docs/TRANSLATING.md) · [Politica di sicurezza](SECURITY.md) |

### Come si incastra tutto

<img src="docs/architecture.svg" alt="Architecture: apps and bridges talk to one Sara server; each turn passes the always-on safety layer, gathers memory and library context, calls the chosen model provider and runs tools in a sandboxed workspace; data stays in one folder on your server" width="860">

Altri dettagli in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Collaudata, con risultati pubblicati

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

<details>
<summary><b>Validazione delle versioni</b>: 2.69.0, 2.67.0 e 2.65.0</summary>

Qualificazione del codice di 2.69.0: controllo dei tipi e **3033 test automatici**; Windows **3017 superati / 0 falliti / 16 saltati**, Linux **3018 superati / 0 falliti / 15 saltati**, più tredici percorsi isolati del browser su desktop e mobile. I pacchetti reali Windows e Mac, quest’ultimo firmato e notarizzato, hanno superato i rispettivi profili di ripristino e regressione e le verifiche dei componenti; le immagini container di entrambe le architetture hanno superato i controlli di stato; Windows non è firmato. Le verifiche usano dati sintetici e modelli simulati. Esecuzione fisica Intel/Rosetta, accettazione su dispositivi e lettori di schermo, tono naturale con modelli reali e ripristino di produzione restano verifiche separate.

Qualificazione della versione 2.67.0 (5 novembre 2026): controllo dei tipi e 2632 test automatici; Windows **2616 superati / 0 falliti / 16 saltati**, Linux **2617 superati / 0 falliti / 15 saltati**. I pacchetti reali Windows, Mac ed entrambe le architetture dei container hanno superato ciascuno il ripristino cifrato, 12 casi di riconvalida delle autorizzazioni e 286 regressioni E2, con hash dei contenuti corrispondenti. Il pacchetto universale Mac è firmato e notarizzato; Windows non è firmato. Si usano dati sintetici e modelli simulati. Esecuzione fisica Intel/Rosetta, dispositivi e lettori di schermo, tono del modello reale e ripristino di produzione restano verifiche separate.

Risultati della versione precedente — Validazione di **2.65.0**: controllo dei tipi e 2.153 test automatizzati con un modello simulato (senza chiamate ai fornitori): **2.137 superati / 0 falliti / 16 saltati su Windows** e **2.138 superati / 0 falliti / 15 saltati su Linux**. Sono verifiche tecniche, non una garanzia per ogni modello o installazione.

</details>

### Contribuire

I contributi sono benvenuti. Inizia da [CONTRIBUTING.md](CONTRIBUTING.md) e dalle
[issue per iniziare](docs/GOOD_FIRST_ISSUES.md); rispetta il
[codice di condotta](CODE_OF_CONDUCT.md) e segnala i problemi di sicurezza in privato, come
descritto in [SECURITY.md](SECURITY.md).

```sh
npm ci
npm run dev        # http://127.0.0.1:7860, restarts on save
npm run check      # typecheck + all tests
```

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

**Telefoni:** l’[app Android](https://play.google.com/store/apps/details?id=com.backstagecoding.sara) è su Google Play; abbinala scansionando il codice QR in
Impostazioni → Connessioni → Dispositivi e accesso → Aggiungi un telefono o un computer. Su iPhone, aggiungi Sara alla schermata Home da Safari ([guida al telefono](docs/PHONE.md)).

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

### Tutti i giorni

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
| [Start here](docs/START_HERE.md) · [For coders](docs/FOR_CODERS.md) · [How do I…?](docs/HOW_DO_I.md) · [Videos](docs/VIDEOS.md) | I primi dieci minuti, per compagnia o per programmare; tutte le risposte dei riquadri di aiuto; i video tutorial |
| [Today](docs/TODAY.md) · [Chat commands](docs/CHATS.md) · [Report a problem](docs/SUPPORT.md) | La tua schermata iniziale; `/new`, `/status` e gli altri in ogni chat; aiuto da dentro Sara |
| [Installazione](docs/INSTALL.md) | Linux, Docker, Windows, macOS, HTTPS, aggiornamenti, risoluzione dei problemi |
| [Che computer mi serve?](docs/REQUIREMENTS.md) · [Scegliere un modello](docs/CHOOSING_A_MODEL.md) · [Quanto costa](docs/COSTS.md) | Prima di iniziare: hardware, modelli con dimensioni della GPU, costi d'uso |
| [Il tuo telefono](docs/PHONE.md) · [Passare a un nuovo computer](docs/MOVING.md) | Configurazione del telefono dall'inizio alla fine; backup, installazione, ripristino |
| [Lista di sicurezza](docs/SECURITY_CHECKLIST.md) · [Cosa esce dal tuo server](docs/PRIVACY.md) | Cinque minuti dopo l'installazione; ogni connessione in uscita e come disattivarla |
| [Domande frequenti e glossario](docs/FAQ.md) | Domande comuni e cosa significano le parole |
| [App e client](docs/clients.md) · [App desktop](docs/desktop.md) · [Home Assistant](docs/HOME_ASSISTANT.md) | Terminale, VS Code, Windows e macOS; Sara in Home Assistant e Home Assistant in Sara |
| [Altre app](docs/OTHER_APPS.md) · [Portala da un’altra app](docs/IMPORT.md) | API compatibile con OpenAI (SillyTavern, Open WebUI, script), MCP (Claude Code, Cursor, Claude Desktop), schede personaggio; importare chat da Character.AI, SillyTavern, Replika, Nomi, Kindroid, ChatGPT o Claude |
| [Più Sara in un'app](docs/SERVERS.md) · [Modalità locale privata](docs/PRIVATE_LOCAL.md) · [Modalità famiglia](docs/HOUSEHOLD.md) | Passare da un server all'altro; tenere tutto su un computer; condividere un server con le persone con cui vivi |
| [Chat di gruppo](docs/GROUP_CHATS.md) · [Videochiamate](docs/VIDEO_CALLS.md) · [I nostri momenti](docs/MOMENTS.md) · [Documenti grandi](docs/LIBRARY.md) | Più compagne in una chat; chiamate con il suo ritratto animato; l'album condiviso; libri da 1.000 pagine nella sua biblioteca |
| [Assistenti vocali](docs/VOICE_ASSISTANTS.md) · [Alexa](docs/ALEXA.md) · [Server via SSH](docs/SSH.md) · [Pacchetti](docs/PACKAGING.md) | Alexa, assistente Android, Google Home, Siri; lavorare sui tuoi altri server; Homebrew, winget, Unraid e gli altri |
| [Estendere Sara](docs/EXTENDING.md) | Aggiungere strumenti, ponti, personaggi, server MCP, lingue, progetti di partenza |
| [Architettura](docs/ARCHITECTURE.md) | Come si incastrano i pezzi, modulo per modulo |
| [Risultati](docs/RESULTS.md) | Benchmark e valutazioni, e come rieseguirli |
| [Tradurre](docs/TRANSLATING.md) | L'app nella tua lingua |
| [Conformità](docs/COMPLIANCE.md) · [Modello delle minacce](docs/THREAT_MODEL.md) · [Avvertenze](docs/DISCLOSURES.md) | Tutela, sicurezza, cosa sapere prima |
| [Roadmap](docs/ROADMAP.md) · [Registro delle modifiche](CHANGELOG.md) · [Versioni](https://github.com/farena-ai/sara/releases) | Dove va, cosa è cambiato |
| [Spazi aziendali](docs/BUSINESS.md) · [Gestione aziendale](docs/BUSINESS_OPERATIONS.md) | [Ripristino](docs/RECOVERY.md) · [Gestione](docs/OPERATIONS.md) |
| [Le funzioni in breve](docs/FEATURES.md) | Ogni area con screenshot reali |

Tutto questo diventa anche un piccolo sito con ricerca e tema scuro: `node scripts/build-docs.ts`
lo scrive in `outputs/site/` (apri `index.html`; è pronto per GitHub Pages).

## Fiducia, sicurezza e note legali

- **Sara è una IA.** Leggi le [informazioni da conoscere](docs/DISCLOSURES.md) prima di usarla o condividerla; l’avviso in cima a questa pagina dice cosa resta sul tuo computer e cosa va ai fornitori che scegli.
- **Sicurezza, sempre attiva.** Le azioni rischiose aspettano il tuo ok: nella chat, nel suo pannello o come notifica con Consenti / Nega nelle app per Windows e Mac. Lo strato di sicurezza gira nel codice attorno a ogni chiamata al modello e **non si può disattivare**: avviso che è un'IA all'inizio e poi regolarmente, una risposta onesta ogni volta che le si chiede sul serio se è un'IA, risorse di aiuto nelle crisi e un blocco totale dei contenuti sessuali che coinvolgono minori ([docs/COMPLIANCE.md](docs/COMPLIANCE.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)). Backup quotidiani (più copie cifrate fuori dal server), ripristino e aggiornamento con un solo comando, e `sara doctor` la mantengono in forma.
- **I contenuti per adulti** stanno dietro l’interruttore **Modalità adulti** (Impostazioni → Tu → Modalità adulti), spento di default. Per accenderlo serve un’autoconferma «Ho 18 anni o più» in un browser web; è una conferma data dal proprietario, non una verifica dell’identità ([conformità](docs/COMPLIANCE.md#adult-content)).
- **Cosa esce dal tuo server:** ogni connessione in uscita e come spegnerla, compreso il piccolo segnale anonimo giornaliero che puoi disattivare: [docs/PRIVACY.md](docs/PRIVACY.md). Cinque minuti dopo l’installazione: la [lista di controllo della sicurezza](docs/SECURITY_CHECKLIST.md).
- **Problemi di sicurezza:** segnalali in privato, come spiegato in [SECURITY.md](SECURITY.md).

## Licenza

MIT, vedi [LICENSE](LICENSE). Riconoscimenti per le parti che Sara scarica o usa:
[docs/CREDITS.md](docs/CREDITS.md).

---

**Rendila tua.** [Scarica Sara](https://github.com/farena-ai/sara/releases/latest), segui la [guida all’installazione](docs/INSTALL.md) e premi **Star** in cima a [questo repository](https://github.com/farena-ai/sara) se ti piace il progetto. Forse il suo linguaggio dell’amore sono le stelle di GitHub.
