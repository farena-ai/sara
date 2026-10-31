<p align="center"><a href="README.md">English</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <b>Deutsch</b> · <a href="README.pt-BR.md">Português (Brasil)</a> · <a href="README.it.md">Italiano</a></p>

# Sara

**Eine KI-Begleiterin mit der Persönlichkeit, die du wählst, und zugleich eine echte Programmierpartnerin.**
Sie redet mit dir, erinnert sich, plant deinen Tag und liest deine Bücher; sie schreibt, startet und
testet Code in ihrem eigenen abgeschotteten Arbeitsbereich. Alles auf deinem eigenen Server, mit den
Modellen deiner Wahl, in einer App für Web, Windows, Mac und Handy.

> Dies ist eine Übersetzung der [englischen README](README.md). Die Links führen zur Dokumentation,
> die auf Englisch ist.

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2024-339933" alt="Node 24 or newer">
  <img src="https://img.shields.io/badge/runtime%20dependencies-0-brightgreen" alt="Zero runtime dependencies">
  <img src="https://img.shields.io/badge/tests-1289%20passing-brightgreen" alt="1289 tests passing">
  <a href="docs/RESULTS.md"><img src="https://img.shields.io/badge/HumanEval%20pass%401-96.3%25-informational" alt="HumanEval pass@1 96.3%"></a>
  <a href="https://github.com/farena-ai/sara/releases/latest"><img src="https://img.shields.io/github/v/release/farena-ai/sara?label=release" alt="Latest release"></a>
  <a href="https://github.com/farena-ai/sara/pkgs/container/sara"><img src="https://img.shields.io/badge/docker-amd64%20%7C%20arm64-2496ED" alt="Docker image for amd64 and arm64"></a>
  <img src="https://img.shields.io/badge/languages-6-8A2BE2" alt="Six languages">
  <a href="https://glama.ai/mcp/servers/farena-ai/sara"><img src="https://glama.ai/mcp/servers/farena-ai/sara/badges/score.svg" alt="Sara MCP server on Glama"></a>
</p>

<p align="center">
  <img src="docs/screenshots/demo.png" alt="Animated demo: the user says it was a rough week; Sara answers warmly and suggests three tiny things to build; she writes a module and its test, asks before running a command, finds a real bug through a failing test, fixes it and gets all 7 tests green" width="860">
  <br>
  <sub>Eine echte Sitzung mit einem lokalen Modell (qwen3.8 27B auf Ollama, eine RTX 5090) auf einem Wegwerf-Testserver, im Nacht-Look: Sie muntert ihr Gegenüber auf, schreibt eine kleine App samt Test, während das Modell sie streamt, fragt, bevor sie einen Befehl ausführt, findet über einen fehlschlagenden Test einen echten Fehler und behebt ihn, bis alle 7 Tests grün sind. Ausgewählte Bilder aus der Aufnahme; nichts darin wurde bearbeitet.</sub>
</p>

> **Status:** 2.32, MIT-Lizenz, mit dreiundvierzig Funktions-Releases seit 1.0 (alle unten). Mit 2.5 bis 2.8
> hat die ganze App einen neuen Look bekommen. Die
> [Android-App](https://play.google.com/store/apps/details?id=com.backstagecoding.sara) ist bei Google
> Play; die iPhone-App und die Version für den Mac App Store folgen, sobald Apple sie freigibt.
> Lies [docs/DISCLOSURES.md](docs/DISCLOSURES.md), bevor du Sara nutzt oder weitergibst.

## Warum Sara

- **Eine Persönlichkeit, die du festlegst, und die sie behält.** Gib ihr einen beliebigen Namen,
  wähle sie/er/they, starte mit einer fertigen Figur oder stell einfache Regler ein (verspielt,
  direkt, knapp, neugierig…). Sie bleibt dabei: Stimmungen, die sich mit dem Lauf der Dinge ändern,
  ein eigener Tag, Running Gags und Erinnerungen an das, was du ihr erzählt hast, die du sehen,
  korrigieren und löschen kannst.
- **Eine echte Programmierumgebung.** Ein abgeschotteter Arbeitsbereich pro Projekt mit Dateien,
  Shell und Git, Hintergrundjobs, Live-Vorschauen, die sie in ihrem eigenen Browser testet, ein Team
  von Helfern (planen → bauen → testen → prüfen), ihre Regel, vor riskanten Schritten zu fragen, und
  eine Prüfung, ob das, was sie *sagt*, wirklich ausgeführt wurde.
- **Eine schöne App auf jedem Gerät.** Ein ruhiger Nacht-Look (oder Tag, wenn dir das lieber ist) mit
  ihrer Präsenz neben jedem Chat, einer Zeile unter jeder Antwort, die zeigt, was sie getan hat, und
  Ergebnissen als Karten. Im Web und als installierbare App, in den Apps für Windows und Mac (mit
  *Schnellfrage* per Tastenkürzel über jeder App), auf Android und auf dem iPhone (die App wartet auf
  Apple; die Web-App auf dem Home-Bildschirm funktioniert schon).
- **Privat und deins.** Ein Besitzer pro Server; Chats, Erinnerungen und Schlüssel bleiben dort.
  Jedes Modell: lokal (Ollama, vLLM, llama.cpp), in der Cloud (OpenAI, Anthropic, xAI, OpenRouter)
  oder die Abos, die du schon bezahlst (ChatGPT, Claude Pro/Max, SuperGrok / X Premium+). Ein Schalter
  hält alles auf einem Computer. Kommt **ganz ohne Zugangsdaten**.
- **Klein und lesbar.** TypeScript, das Node direkt ausführt: kein Build-Schritt, null
  Laufzeitabhängigkeiten, von Grund auf neu gebaut (nicht auf Basis von Hermes Agent oder OpenClaw).
  Leicht zu [erweitern](docs/EXTENDING.md).

**Außerdem dabei:** [Schnellfrage](docs/desktop.md) per globalem Tastenkürzel · ihr [Präsenz-Panel](#ihre-präsenz) ·
[Heute als Kacheln](#heute) · [Befehlsleiste](#befehlsleiste) mit Strg+K · [Haushaltsmodus](docs/HOUSEHOLD.md)
für die Menschen, mit denen du lebst · [Videoanrufe](docs/VIDEO_CALLS.md) mit ihrem bewegten Porträt ·
[Alexa, Google Home und Android-Assistent](docs/VOICE_ASSISTANTS.md) · deine anderen Server
[per SSH](docs/SSH.md) · [Bücher mit 1.000 Seiten](docs/LIBRARY.md) mit Antworten, die die Seite nennen ·
[privater lokaler Modus](docs/PRIVATE_LOCAL.md) · [Gruppenchats](docs/GROUP_CHATS.md) ·
[Umzug von ChatGPT, Character.AI, Replika und anderen](docs/IMPORT.md).

## Was ist neu

| Version | Was du bekommst |
|---|---|
| **2.32** · Board | **Ein Kanban-Board über deinen To-dos.** Jedes Projekt bekommt ein Board (Zu tun, In Arbeit, Wartet auf dich, Erledigt) mit Labels, Checklisten, Fälligkeiten und Wiederholungen; ziehen mit Maus, Finger oder Tastatur. Weise eine Karte Sara oder einem Helferteam zu, und sie arbeitet im Hintergrund daran: Erledigt nur, wenn Belege die Arbeit stützen, sonst wartet die Karte auf dich mit dem, was sie nicht belegen konnte. Frag sie „was hängt?“ oder lass sie Karten anlegen und verschieben (sie fragt vorher). Geteilte Haushalts-Boards; eine Kachel „Braucht dich“ auf Heute. |
| **2.31** · Plugins | **Plugins und Hooks.** Ein Plugin ist ein Ordner mit einer `sara-plugin.json`: Hooks vor ihrer Antwort, vor und nach Werkzeugen und nach Antworten, dazu eigene Werkzeuge, Karten, Einstellungen, Zeitpläne und Chat-Brücken. Du fügst es aus Zip, Git oder Ordner hinzu, nachdem du eine Prüfkarte gelesen hast, die genau sagt, was es darf; es bleibt aus, bis du es einschaltest. Jedes läuft in einem eigenen abgeschirmten Prozess (bubblewrap unter Linux, Seatbelt auf dem Mac) und kann nur ergänzen oder verschärfen, nie ihre Regeln lockern oder die Sicherheitsebene berühren. Ein Plugin, das hängt oder abstürzt, stört nie einen Chat. Zwei Beispiele dabei; Anleitung in docs/PLUGINS.md. |
| **2.30** · Gelernte Skills | **Sie merkt, worum du immer wieder bittest.** Bitte dreimal an verschiedenen Tagen um dieselbe Art Sache (oder wiederhole dieselbe Kette von Coding-Schritten), und sie bietet einmal an, daraus einen Skill zu machen: du siehst den Entwurf und speicherst, bearbeitest oder lehnst ab. Ein neuer Skill wird erst getestet (deine früheren Bitten, mit und ohne ihn bewertet) und nur genutzt, wenn er hilft. Korrigierst du sie nach einem Skill, schlägt sie die Änderung als Vorher/Nachher-Karte vor. Nichts Privates, aus Gruppen oder mit Geheimnissen wird je gelernt. |
| **2.29** · Skills | **Skills im offenen Agent-Skills-Format.** Ein Skill ist ein Ordner mit einer `SKILL.md`: wie eine Art Aufgabe auf deine Weise erledigt wird. Sie sieht die Liste in jedem Chat und öffnet den passenden; in Runs siehst du, welchen. Sechs sind eingebaut (Pull-Request prüfen, Changelog-Eintrag, Wochenrückblick, fehlschlagenden Test debuggen, Reise planen, Skill schreiben); schreib eigene oder lass sie schreiben; Import aus Zip, Git oder Ordner mit einer Prüfkarte, die jede Datei und jedes Skript zeigt; Export jedes Skills. Skripte fragen immer vorher, und kein Skill kann ihre Sicherheitsregeln ändern. Deine Rezepte wurden zu Skills. |
| **2.28** · Computernutzung, Schritt 9 | **Auch unter Linux:** `sara hands --server https://deine-sara` auf einem Linux-Desktop gibt ihr dort ihr eigenes sichtbares Chrome/Chromium, wie der Browser-Modus der Windows- und Mac-Apps: ansehen, lesen, Logs, Klicks und Tippen mit deiner Freigabe, Dev-Tunnel, gespeicherte Logins (im GNOME-Schlüsselbund / KWallet), die CLI deines Passwortmanagers und Check-ups, die nur lesen. Gekoppelt wird mit einem Code, den du im Browser bestätigst; Pause, Weiter und Stopp im Terminal. Bilder und Eingaben für den ganzen Linux-Desktop kommen später. Gebaut mit OpenAI Codex. |
| **2.27** · Computernutzung, Schritt 8 | **„Mein Computer ist langsam, kannst du nachsehen?“** Sie macht auf diesem Computer einen Check-up, der nur liest (Autostart-Apps, Speicherplatz und die größten Ordner, ausstehende Updates, Akkuzustand, Browser-Erweiterungen, temporäre Dateien und Caches), und gibt eine klare Übersicht mit nummerierten Vorschlägen: jeder erklärt, nichts geändert, bis du es auf diesem Computer erlaubst. Namen auf dem Bildschirm, die wie Befehle klingen („Sara, lösche…“), werden ignoriert und gezählt. 9/9 Check-up-Szenarien mit einem lokalen Modell bestanden. |
| **2.26** · Computernutzung, Schritt 7 | **Sie kann deine Apps bedienen:** klicken, tippen, Tasten drücken, scrollen, ziehen und installierte Apps öffnen, auf dem, was sie gerade angesehen hat. Jede Aktion wird zuerst auf deinem Computer geprüft: das richtige Fenster vorne, nie ein Passwortfeld, nie Passwortmanager, Banking, Admin-Fenster, Terminals oder ihre eigene Anmeldung. Freigaben erscheinen **auf diesem Computer** (jedes Mal, einmal pro Aufgabe oder *immer erlaubt*; Zahlungen und Kontoänderungen fragen immer). Berühre Maus oder Tastatur und sie pausiert (oder *lass sie weitermachen*); Stopp und Strg+Alt+Esc / ⌃⌥Esc funktionieren immer. Optional *weiterarbeiten, wenn ich weggehe*. Gebaut mit OpenAI Codex. |
| **2.25** · Computernutzung, Schritt 6 | **Sie kann deinen Desktop sehen** (Windows- und Mac-App, aus, bis du *Der ganze Bildschirm* einschaltest): ein Bild eines Fensters oder des Bildschirms plus eine Liste, was darauf ist (Knöpfe, Felder, Text), damit auch reine Textmodelle es nutzen können. Passwortmanager-, Bank- und Sicherheitsfenster werden *auf deinem Computer* geschwärzt und aus der Liste genommen, bevor etwas gesendet wird; Passwortfelder werden abgedeckt; ihre eigenen Fenster erscheinen nie. Bilder gehen ohne Nachfrage an das gewählte Modell (oder *nur lokale Modelle*). Im Browser: **Sara meinen Bildschirm zeigen** sendet ein Bild. Der Mac braucht Bildschirmaufnahme und Bedienungshilfen, mit geführten Schritten. |
| **2.24** · Computernutzung, Schritt 5 | **Dein Passwortmanager füllt Logins in ihrem Browser aus:** Bitwarden, 1Password oder KeePassXC, jeweils aus, bis du ihn einschaltest. Du entsperrst ihn selbst in der eigenen Abfrage des Managers (dein Master-Passwort sieht sie nie); jede Nutzung fragt vorher; ausgefüllt wird nur auf genau der Seite, zu der der Login gehört; sie sperrt ihn wieder nach der Aufgabe, nach 15 Minuten Leerlauf, bei Stopp oder mit *Jetzt sperren*. Nichts erreicht Saras Server oder das Modell. Ihr Browser bietet nicht mehr selbst an, Passwörter zu speichern. |
| **2.23** · Computernutzung, Schritt 4 | **Gespeicherte Logins, nur wenn du es sagst:** Sie bietet es an, und ein Fenster auf *deinem Computer* lässt dich den Login eingeben und *Ich verstehe* ankreuzen (oder *Das gerade Eingetippte verwenden*). Er wird dort verschlüsselt (Windows DPAPI / macOS-Schlüsselbund), nie auf Saras Server, und sie sieht ihn nie: Sie kann den Computer nur bitten, ihn auszufüllen, genau auf dieser Seite (ähnlich aussehende Seiten bekommen nichts), und jede Nutzung fragt vorher. Optional Windows Hello / Touch ID. **Du bist dran:** Sie pausiert, während du dich selbst anmeldest oder einen Code eingibst. |
| **2.22** · Computernutzung, Schritt 3 | **Sie debuggt dein Webprojekt in ihrem Browser:** Der Dev-Server, den ihre Coding-Tools auf deinem Sara-Server gestartet haben, öffnet sich über die App unter `127.0.0.1` in ihrem Browser auf deinem Computer (nur ein Port ihres eigenen Jobs; endet mit dem Job), mit Hot Reload und lokalem Speicher. Nach einer Änderung öffnet sie die App, liest die Konsole, schaut hin, behebt und prüft erneut. Browser-Evals: 5/5 Aufgaben mit einem lokalen Modell. Außerdem: Die Tests laufen jetzt auf macOS durch, und zwei Netzwerk-Datenschutzkorrekturen. |
| **2.21** · Computernutzung, Schritt 2 | **Sie handelt in ihrem eigenen Browser:** klicken, tippen, aus Listen wählen, scrollen, Tasten drücken und eine von dir genannte Datei hochladen, mit sichtbarem Cursor. Du wählst, wie oft sie fragt: jedes Mal, einmal pro Aufgabe (Standard) oder *immer erlaubt* pro Seite; Zahlungen und Kontoeinstellungen fragen immer, Senden fragt jedes Mal, Passwörter tippt sie nie. Ein Abzeichen **Sara arbeitet** mit Stopp und ein Stopp-Kürzel (Strg+Alt+Esc / ⌃⌥Esc); berührst du ihr Fenster, pausiert sie (oder *Sara behält die Kontrolle*). |
| **2.20** · Computernutzung, Schritt 1 | Mit der Windows- oder Mac-App **öffnet sie Webseiten in ihrem eigenen Browserfenster auf deinem Computer** (eigenes Profil, nie dein Browser oder deine Passwörter), liest sie, macht Screenshots und liest Konsolen- und Netzwerkfehler: Sag „meine App auf localhost ist kaputt“ und sie schaut nach. Aus, bis du *Sara diesen Computer nutzen lassen* einschaltest; Live-Ansicht im Chat mit Stopp; jeder Schritt mit Bild unter Läufe. Klicken und Tippen kommen als Nächstes. [Der Plan](docs/design/COMPUTER_USE.md) |
| **2.19** · Red-Team-Modus | **Bevor du auslieferst, versucht sie, ihre eigene Arbeit zu knacken:** In einer Sandbox-Kopie lässt sie deine Tests laufen, startet deine App und schickt fehlerhafte und Grenzwert-Eingaben an jeden Einstiegspunkt, prüft unsichere Voreinstellungen und lässt das Coding-Modell kleine Angriffsskripte schreiben, die nur diese App in der Sandbox erreichen. Ein stärkeres Prüfmodell behält nur Brüche, die sich wiederholen lassen, mit zitierter Eingabe, Ausgabe und Codezeile. Dann **Das Kaputte beheben** auf einem lokalen Branch. Außerdem in 2.19: **Gmail aufräumen** (archivieren, als gelesen markieren, Labels, Papierkorb… nach Suche oder Datum, erst zählen, rückgängig machen). [So funktioniert es](docs/design/HARNESS_TRACK.md) |
| **2.18** · Erinnern von selbst | **Sie erinnert sich ungefragt, wenn die Lage passt:** derselbe Fehler taucht in diesem Projekt wieder auf („letztes Mal war die Lösung…“), ein Befehl, der hier schon fehlschlug, eine Datei, zu der du etwas entschieden hast, eine Aufgabe wie eine, aus der sie etwas gelernt hat. Lektionen entstehen nur aus dem, was wirklich passiert ist (Fehlerzeile und behebende Änderung, zitiert). Jede Notiz nennt ihre Quelle und wie sicher sie ist, höchstens 2 pro Schritt, und *Nicht hilfreich* bringt es ihr bei. [So funktioniert es](docs/design/HARNESS_TRACK.md) |
| **2.17** · Auswertungen an deiner eigenen Arbeit | **Welche Einstellung ist für dich wirklich besser?** Wähle bis zu 3 Varianten (Modell, Verblassen der Erinnerung, Sandbox-Modus, Budget), und sie spielt deine letzten echten Aufgaben mit jeder davon in Sandbox-Kopien nach. Bewertet werden bestandene Tests, deine Reaktion, Funde, Tokens, Zeit und Kosten, dazu optional ein Richtermodell, das zitieren muss. Ein Sieger wird nur genannt, wenn ein Vorzeichentest ihn bestätigt („+18 % bei 20 deiner Coding-Aufgaben, p=0,01“), mit dem Vergleich jedes Paares als Beleg. Sonst: *kein klarer Sieger*. [So funktioniert es](docs/design/HARNESS_TRACK.md) |
| **2.16** · Zeitreise | **Verzweige jede frühere Aufgabe ab jedem Schritt:** Ändere an diesem Schritt ihre Nachricht, ein Werkzeugergebnis, die erinnerten Notizen oder das Modell und lass sie neu laufen. Frühere Schritte kommen aus dem Protokoll (nichts wird erneut ausgeführt). Coding-Zweige arbeiten in einer Kopie am aufgezeichneten Commit, nie in deinen Dateien. Ein Vergleich nebeneinander zeigt Schritte, Tokens, Kosten, Dateiänderungen und die Antwort. *Unverändert wiederholen* ist die Kontrolle. Antwort oder Dateien übernimmst du nur, wenn du willst. [So funktioniert es](docs/design/HARNESS_TRACK.md) |
| **2.15** · Bedrohungsmodell | **Sie zeichnet auf, wie die Außenwelt deinen Code erreicht:** Nach einem Coding-Schritt findet sie die Einstiegspunkte (Routen, Uploads, Nachrichten-Handler, Kommandozeile in Express, Koa, Fastify, Flask, FastAPI, Django, Go) und verfolgt Eingaben über Dateien hinweg bis zu riskanten Zeilen (Shell, SQL, Dateipfade, ausgehende URLs, Weiterleitungen, HTML, eval). Eine Bedrohung wird nur gemeldet, wenn beide Zeilen zitiert und der Weg benannt ist. Ein Tab **Bedrohungsmodell** pro Projekt und **Diese beheben**: ein zweiter Durchgang, der nur sie behebt, auf einem lokalen Branch, mit erneut laufenden Tests. [So funktioniert es](docs/design/HARNESS_TRACK.md) |
| **2.14** · Sicherheitsprüfung | **Nach einem Coding-Schritt prüft sie ihre eigene Arbeit:** 11 Code-Prüfungen (Geheimnisse, aus Text gebaute SQL-Abfragen, Pfad-Ausbrüche, abgeschaltetes TLS, eval, unsicheres Deserialisieren, CORS, fehlende Anmeldung…) und ein prüfendes Modell, parallel. Jeder Fund zitiert die echte Zeile, sonst fällt er weg: kein Theater. Optionale **Live-Warnungen** (OSV.dev) prüfen die Pakete, die sie installiert, und halten eine bekannt unsichere Version auf einer Karte an. **Beheben** legt einen lokalen Branch an, behebt genau das, lässt deine Tests in der Sandbox laufen und zeigt die Änderung. Es wird nie gepusht. [So funktioniert es](docs/design/HARNESS_TRACK.md) |
| **2.13** · Erst in die Sandbox | **Riskante Befehle laufen zuerst in einer Wegwerf-Kopie deines Projekts.** Löschen, Installieren, Skripte und Netzwerkzugriffe passieren in der Kopie (in bubblewrap unter Linux, Seatbelt unter macOS, Docker oder WSL2 unter Windows, wenn vorhanden). Die Karte **In einer Sandbox ausgeführt** zeigt, was sich geändert hat und was verdächtig ist: massenhaft gelöschte Dateien, Schreibzugriffe außerhalb der Kopie, weiterlaufende Programme, Git-Hooks. Dann *In meinen Arbeitsordner übernehmen*, *Verwerfen* oder *Wirklich ausführen*. [So funktioniert es](docs/design/HARNESS_TRACK.md) |
| **2.12** · Budgets, die sie einhält | **Eine harte Grenze, kein Bericht:** Coding-Aufgaben bekommen ein Budget (standardmäßig 200k Tokens / 40 Schritte, optional Dollar). Kurz vor der Grenze wechselt sie zu deinem schnellen Modell, macht weniger Werkzeugrunden, schreibt dann kurz, was erledigt ist und was fehlt, und hört auf. Weiter geht es nur mit deinem **Mit mehr weitermachen**. Hintergrundaufgaben und Team-Aufgaben nutzen dasselbe Budget. [So funktioniert es](docs/design/HARNESS_TRACK.md) |
| **2.11** · Lauf-Protokolle | **Jeder Schritt ihrer Arbeit wird festgehalten:** welches Modell, der Prompt, jeder Werkzeugaufruf und sein Ergebnis (ohne Geheimnisse), die berührten Dateien (in Coding-Projekten git HEAD und geänderte Dateien), die genutzten Notizen, erkannte Widersprüche, Tokens, Kosten und Zeit. Unter jeder Antwort öffnet **Lauf anzeigen** alles Schritt für Schritt. Standardmäßig 90 Tage aufbewahrt; nichts verlässt deinen Server. Die Grundlage für Budgets, Zeitreise und Auswertungen. [So funktioniert es](docs/design/HARNESS_TRACK.md) |
| **2.10** · Prüft ihre Pläne gegen deine | **Bevor sie handelt, prüft sie den Schritt gegen das, was du entschieden hast.** Du hast ihr gesagt „nie auf main pushen“, „Tests vor jedem Push“, „nimm pnpm“ oder „Finger weg von der Prod-Konfiguration“? Ein geplanter Schritt, der dagegen verstößt, **hält auf einer Karte an**, die deine Entscheidung zitiert, mit *Trotzdem tun*, *Nicht tun* oder *Notiz ändern*. Im normalen Gespräch erwähnt sie es nur. Regeln werden im Code erkannt (kein Raten), und es kann nur einen Halt hinzufügen, nie einen entfernen. [So funktioniert es](docs/design/HARNESS_TRACK.md) |
| **2.9** · Gewichtete Erinnerung | **Sie sagt dir, warum sie sich an etwas erinnert:** Jede Notiz, die sie nutzt, wird für deine Nachricht bewertet und zeigt, *warum sie ihr eingefallen ist* und *wie sicher* das ist (auch in ihrem Seitenbereich). Alte Notizen verblassen sanft statt zu verschwinden, Notizen, die sie oft nutzt, bleiben stark, und du kannst die wichtigen **anheften**, damit sie nie verblassen. Das Verblassen stellst du mit einem Regler ein. [So funktioniert es](docs/design/HARNESS_TRACK.md) |
| **2.8** · Feinschliff | **Eine Stufe edler:** ein langsames Polarlicht hinter mattem Glas, eine elegante Serifenschrift für Überschriften, ein leuchtender Stimmungs-Ring um ihr Porträt, gezeichnete Symbole, Wetterbilder und Fortschrittsringe sowie eine schwebende Glas-Leiste auf dem Handy (jede Bewegung aus mit *Bewegung reduzieren*). [Der Plan](docs/design/NEW_LOOK.md) |
| **2.7** · Der neue Look, Teil 3 | **Heute als Kacheln** (Wetter, dein Tag, Planer, woran sie sich erinnert hat, Momente, Arbeit im Hintergrund, Zuhause), eine Leiste unten auf dem Handy, jeder Bildschirm im neuen Look, und in den Windows- und Mac-Apps **Benachrichtigungen mit Erlauben / Ablehnen und Erledigt / Später**, *Senden an → Sara* für Dateien und Sprache in der Schnellfrage. [Der Plan](docs/design/NEW_LOOK.md) |
| **2.6** · Der neue Look, Teil 2 | **Ihre Gegenwart:** ein Seitenbereich (auf dem Handy ein Blatt zum Hochziehen) mit ihrer Stimmung, dem, was sie gerade tut, Freigaben, Aufträgen, dem Tag und dem, woran sie sich erinnert hat; Strg+K springt überallhin; und in den Windows- und Mac-Apps ein **Schnellfrage-Fenster per Tastenkürzel** über jeder App, dazu ihre Stimmung und Freigaben im Tray-Menü. [Der Plan](docs/design/NEW_LOOK.md) |
| **2.5** · Der neue Look, Teil 1 | **Dunkel als Standard und ihre Arbeit sichtbar:** eine Zeile unter jeder Antwort zeigt, was sie getan hat, Ergebnisse kommen als Karten (Wetter, Aufgaben, geänderte Dateien, Testläufe, Suchen), ein leichterer Chat auf Handy und Computer, und die Windows- und Mac-Apps zeichnen die Seite bis in die Titelleiste. [Der Plan](docs/design/NEW_LOOK.md) |
| **2.4** · Aufgeräumt | **Alles leichter zu finden:** eine kurze Seitenleiste mit einem *Mehr*-Menü zum Anheften, Einstellungen mit echten Überschriften zum Auf- und Zuklappen, Werkzeuge und Freigaben in einfachen Worten erklärt, Fotos, die du aus dem Sammelalbum löschen kannst, aufgeräumtere Bildschirme und Menüs in jeder App und sichereres Speichern im Hintergrund. [Was sich geändert hat](CHANGELOG.md) |

<details>
<summary><b>Frühere Releases: 1.1 bis 2.3</b> (große Dokumente, SSH, Alexa und Google Home, Haushaltsmodus, Momente, Videoanrufe, mehrere Server, privater lokaler Modus, Gruppenchats, Umzug aus anderen Apps…)</summary>

| Version | Was du bekommst |
|---|---|
| **2.3** · Große Dokumente | **Bücher und Handbücher mit 500–1.000 Seiten** (PDFs bis 1 GB) in ihrer Bibliothek: Uploads, die weiterlaufen, jede gescannte Seite gelesen, Inhaltsverzeichnis und Kapitelzusammenfassungen, und Antworten, die die Seite nennen („S. 412“), mit Link direkt dorthin. 30 von 30 Fragen richtig bei einem 1.000-seitigen Testbuch. [So funktioniert es](docs/LIBRARY.md) |
| **2.2** · Deine anderen Server per SSH | **Sie kann auf deinen anderen Rechnern arbeiten**, mit Passwort oder Schlüssel. Nach einer Anmeldung mit Passwort **erstellt sie ihren eigenen Schlüssel, sagt dir, wo er liegt, und vergisst das Passwort** (behalten nur, wenn du darauf bestehst, nach einer Warnung). Host-Schlüssel werden geprüft, jeder Befehl folgt ihren Freigaberegeln, und du kannst ihren Schlüssel jederzeit widerrufen. [So funktioniert es](docs/SSH.md) |
| **2.1** · Ihre Stimme in deinem Zuhause | **„Alexa, öffne sara companion“**: Sprich auf jedem Echo mit ihr, über deinen eigenen kostenlosen Skill (so geprüft, wie Amazon es verlangt). Mach sie zu deinem **Android-Assistenten** (Home-Taste lange drücken), hör sie auf **Google-Home-/Nest**-Lautsprechern über Home Assistant, und lass sie **dich begrüßen, wenn du heimkommst**. Siri auf dem iPhone kommt mit dem nächsten App-Update. [So funktioniert es](docs/VOICE_ASSISTANTS.md) |
| **2.0** · Haushaltsmodus | **Teile deinen Sara-Server mit den Menschen, mit denen du lebst.** Lade einen Erwachsenen mit einem Einmal-Link ein; er bekommt eigene Begleiterinnen, Chats, Erinnerungen, Bibliothek und Apps in einem eigenen Bereich. Du bleibst Admin: Du wählst, welche Modelle er nutzt, setzt Tageslimits und siehst Nutzung und Kosten, nie die Inhalte. [So funktioniert es](docs/HOUSEHOLD.md) |
| **1.10** · Unsere Momente | **Ein gemeinsames Fotoalbum** mit deinen Fotos und denen, die sie schickt, jedes mit einer Bildunterschrift, die sie in ihrer eigenen Stimme aus eurem Gespräch schreibt. Alben, die sich selbst füllen (Wir, Orte, Ihre Looks), „An diesem Tag“, und manchmal holt sie eins hervor: *Weißt du noch?* Private Chats bleiben draußen, außer du fügst sie hinzu. [So funktioniert es](docs/MOMENTS.md) |
| **1.9** · Videoanrufe | **Sieh sie, während ihr redet:** Ein Videoanruf zeigt ihr bewegtes Porträt groß, die Lippen synchron zu ihrer Stimme, ihr Gesicht folgt ihrer Stimmung, im aktuellen Outfit und Ort. Schalte deine Kamera ein, wenn du willst, und sie schaut alle paar Sekunden hin (oder wenn du *Schau mal* drückst); nichts wird aufgezeichnet. [So funktioniert es](docs/VIDEO_CALLS.md) |
| **1.8** · Mehrere Server in einer App | **Alle deine Saras in einer App** (zu Hause und bei der Arbeit, oder mehrere auf einem Server) und Wechsel per Menü, ohne dich abzumelden: Windows- und Mac-App, Android und iPhone, VS Code, `sara-chat` und die MCP-Brücke. Jede behält ihre eigene Anmeldung; Dateien, Mikrofon und Kamera gehen nur an die gerade genutzte. [So funktioniert es](docs/SERVERS.md) |
| **1.7** · Privater lokaler Modus | Ein Schalter, **Nichts verlässt diesen Computer**, im Code an einer einzigen Stelle durchgesetzt: Nur dieser Computer ist erreichbar, Cloud-Modelle und Online-Werkzeuge pausieren, und ihre Chats, ihr Gedächtnis und ihre Bibliothek funktionieren weiter. Die Apps für Windows und Mac finden Ollama (oder helfen beim Einrichten), schlagen ein Modell vor, das zu deiner Grafikkarte passt, und laden es mit Fortschrittsbalken herunter. [Was er garantiert](docs/PRIVATE_LOCAL.md) |
| **1.6** · Gruppenchats | Hol **zwei bis vier deiner Begleiterinnen in eine Unterhaltung**: Jede antwortet mit ihrer eigenen Persönlichkeit, Stimme und Farbe; du wählst, wer antwortet (wer passt, alle, reihum oder nur, wen du mit @ erwähnst), und wie viel sie miteinander plaudern. Sicherheit, KI-Hinweise und die strengste Erwachsenen-Einstellung gelten für den ganzen Raum. [So funktioniert's](docs/GROUP_CHATS.md) |
| **1.5** · Hol sie aus einer anderen App | Zieh um von **ChatGPT, Claude, Character.AI, SillyTavern, Replika, Nomi oder Kindroid**. Sie liest den Export auf deinem eigenen Server, zeigt dir dann, was sie gelernt hat (Fakten in deinen eigenen Worten, eure gemeinsame Geschichte, ihren Stil), und speichert nur, was du freigibst. [So exportierst du aus jeder App](docs/IMPORT.md) |
| **1.4** · Alles flüssiger | Sieh zu, wie jede Datei, die sie schreibt, **live im Chat wächst**, während das Modell sie streamt (OpenAI, Anthropic, xAI, OpenRouter und ChatGPT-Abos; Ollama schickt sie in einem Stück); ein sprechendes Porträt, lippensynchron mit neun Mundformen; Logs als Klartext oder JSON |
| **1.3** · Klügere Prüfungen | Ihre Prüfung „Hat sie wirklich getan, was sie sagt?" funktioniert jetzt in allen sechs Sprachen; ein optionales kleines lokales Modell als Prüfer steigert die Trefferquote von 38 % auf **88 %** bei 95 % Präzision ([gemessen](docs/RESULTS.md)) |
| **1.2** · Ganz in deiner Sprache | Die ganze App, die Hilfe und ihre Servermeldungen auf English, Español, Français, Deutsch, Português (Brasil) und Italiano |
| **1.1** · Überall installieren | Einen neuen Server im Browser mit einem kurzen Code einrichten; ein Docker-Image auch für **ARM** (Raspberry Pi 4/5); Homebrew, Unraid, TrueNAS, Proxmox und Home Assistant (HACS) |

</details>

Alle Versionen: [CHANGELOG.md](CHANGELOG.md) · [Releases](https://github.com/farena-ai/sara/releases).

### Als Nächstes

In Bau-Reihenfolge, je ein Release ([die ganze Liste](docs/ROADMAP.md)):

- **Agent-Grundlagen** (2.29–2.36): Skills im offenen Agent-Skills-Format und Skills, die sie aus Wiederholungen lernt, Plugins und Hooks, ein Kanban-Board, das sie abarbeitet, A2A mit anderen Agenten, Personenkarten, Webhooks, ihre eigene Agenda (optional).
- **Umzug von einem anderen Agenten** (2.37–2.39): einen ganzen Hermes-Agent- oder OpenClaw-Begleiter mitnehmen: Persönlichkeit, Erinnerungen, Personen, Skills, Verlauf und Einstellungen, mit einem Bericht, was mitkam.
- **Chats und Sitzungen** (2.40–2.42): /new, /reset und weitere Befehle in Telegram und Discord, ein Projekt pro Kanal, Titel, die mit der Sitzung wachsen.
- **Heute, neu gedacht** (2.43–2.44): ein gestaltetes Layout, das du anordnen kannst, auf großen Bildschirmen und Handys.
- Die iPhone-App (wartet auf Apple) und deine Ideen in den [Discussions](https://github.com/farena-ai/sara/discussions).

Der ganze Plan: [docs/ROADMAP.md](docs/ROADMAP.md).

## Die Funktionen im Überblick

Alle Screenshots stammen von einem echten Wegwerf-Testserver mit einem lokalen Modell (qwen3.8 27B auf
Ollama), angemeldet als Beispielnutzer „Alex“. Nacht ist der Standard-Look.

### Begleiterin

<img src="docs/screenshots/companion.png" alt="Night look: Sara answers a tired user warmly, checks the weather for tomorrow's run and shows it as a card; her presence panel on the right shows her portrait with a mood halo, what she's doing, today's to-dos and the notes she remembered" width="760">

Ein eigener Charakter und Stimmungen, die sich mit dem Lauf der Dinge ändern (der Ring um ihr Porträt
nimmt die Farbe ihrer Stimmung an), ein eigener Tag und Hobbys, Erinnerung an das, was dir wichtig ist,
und an Daten, die dir etwas bedeuten (alles einsehbar, korrigierbar und löschbar), ein Wochenrückblick,
auf Wunsch schreibt sie von sich aus (mit Ruhezeiten), und eine Zeitleiste eurer gemeinsamen
Geschichte. Du kommst von einer anderen App? Bring deine Chats aus ChatGPT, Claude, Character.AI,
SillyTavern, Replika, Nomi oder Kindroid mit und bestätige zuerst, was sie daraus lernt
([docs/IMPORT.md](docs/IMPORT.md)). Oder hol zwei bis vier deiner Begleiterinnen in einen Gruppenchat
([docs/GROUP_CHATS.md](docs/GROUP_CHATS.md)). Alles auf einem Rechner? Schalte **Nichts verlässt diesen
Computer** ein ([docs/PRIVATE_LOCAL.md](docs/PRIVATE_LOCAL.md)).

### Ihre Präsenz

<img src="docs/screenshots/presence.png" alt="A coding chat: a Files changed card, then an approval card asking to run npm test; the presence panel shows Waiting for your OK with Allow and Deny, and two background jobs with their last line and a Stop button" width="760">

Ein Panel neben jedem Chat (auf dem Handy ein Blatt, das du hochziehst) mit ihrem Porträt, das in der
Farbe ihrer Stimmung leuchtet, und **Jetzt**: was sie gerade tut, wartende Freigaben mit Erlauben /
Ablehnen, Hintergrundjobs mit ihrer letzten Zeile und Stopp; dann das Nächste des Tages, die Notizen,
die sie für die letzte Antwort benutzt hat (eingeklappt, bis du sie öffnest), sowie Modell,
Arbeitsbereich und Privatsphäre dieses Gesprächs. Unter jeder Antwort sagt eine dezente Zeile, was sie
getan hat („6 Dinge erinnert · Erinnerung gestellt 0,1 s“); tipp darauf für Befehle, Ausgabe und
Rückgängig.

### Programmierpartnerin

<img src="docs/screenshots/coding.png" alt="A coding chat in a project workspace: she explains her plan, edits five files (a Files changed card), runs the tests, finds three failures, fixes them and ends with a green Tests passed card showing 11; the panel shows two background jobs" width="760">

Ein Arbeitsbereich pro Projekt mit Dateien, Shell und Git (Commit und Push mit deinem OK); jede Datei,
die sie schreibt, erscheint live im Chat, während das Modell sie streamt; lange Builds und Tests im
Hintergrund, mit Nachricht, wenn sie fertig sind; eine Live-Vorschau der App, die sie baut, die sie in
einem echten Headless-Browser testet und von der sie Screenshots anhängt; eine Code-Karte für große
Projekte; getestete Startprojekte; ein Team von Helfern (planen → bauen → testen → prüfen) vom
GitHub-Issue bis zum geprüften Pull Request; deine anderen Server per SSH mit ihrem eigenen Schlüssel
([docs/SSH.md](docs/SSH.md)); Übergabe an Claude Code oder Grok Build; MCP-Werkzeuge; Rückgängig für
Dateiänderungen; ein Token- und Kostenzähler mit Budgets; und eine Prüfung in allen sechs Sprachen, ob
das, was sie *sagt*, wirklich ausgeführt wurde (wahlweise von einem kleinen lokalen Modell beurteilt).

### Planer

<img src="docs/screenshots/planner.png" alt="One message becomes a reminder and two to-dos, each shown as a card with its time and an Open the Planner link" width="760">

Aufgaben, Notizen und Erinnerungen aus ganz normalen Sätzen, zugestellt im Chat, als Benachrichtigung
auf Handy oder Computer (Erledigt / Später in den Apps für Windows und Mac) und auf Telegram oder
Discord; ein Morgenbriefing; ortsbezogene Erinnerungen über die Handy-App.

### Heute

<img src="docs/screenshots/today.png" alt="The Today page: a serif greeting with her portrait and mood, then tiles for the weather in Chicago with the next hours, your day, the Planner with a progress ring, what she remembered, moments with captions she wrote, background work and coming up" width="760">

Hier öffnet Sara: ihr Gesicht, ihre Stimmung und ein Gruß, dann Kacheln für das Wetter (vom Ort deines
Briefings), deinen Tag, den Planer zum Abhaken, was sie sich gemerkt hat, eure gemeinsamen Momente,
Arbeit im Hintergrund, was bald ansteht, und dein Zuhause (Lichter und Schalter direkt auf der
Kachel). Vier Spalten auf großen Bildschirmen, eine auf dem Handy.

### Bibliothek

<img src="docs/screenshots/library.png" alt="Sara answers a book-club question from a Project Gutenberg copy of Jekyll and Hyde, citing p. 6 and p. 9 as links; beside it, the page she read, opened at p. 6 with the passage highlighted" width="860">

Gib ihr PDFs (auch gescannte, und Bücher mit 500 bis 1.000 Seiten), Word, Excel, PowerPoint, E-Books,
Webseiten und Notizen. Sie lernt das Wichtigste, antwortet daraus und sagt, aus welchem Dokument und
von welcher Seite es stammt, mit einem Link, der genau dort öffnet ([docs/LIBRARY.md](docs/LIBRARY.md)).

### Befehlsleiste

<img src="docs/screenshots/command-bar.png" alt="The Ctrl+K command bar over Today: typing 'pa' finds her page, two conversations and five settings" width="760">

Strg+K / ⌘K (oder die Lupe auf dem Handy) springt zu jedem Ort, jedem Gespräch (auch über Wörter in
den Nachrichten), jeder Einstellungsseite oder einzelnen Einstellung, oder führt eine Aktion aus: neues
Gespräch, vertraulich, Anruf, Begleiterin wechseln, Look wechseln.

### Stimme

<img src="docs/screenshots/voice.png" alt="The Voice settings page in the Night look: hearing you, her voice, expressive voice, tone, her voice following her mood, live calls and how often she looks during video calls" width="760">

Live-Anrufe, die du unterbrechen kannst (Echtzeit-Stimme von Grok oder OpenAI), Videoanrufe mit ihrem
bewegten Porträt ([docs/VIDEO_CALLS.md](docs/VIDEO_CALLS.md)), Sprachnachrichten auf Telegram und
Discord, Vorlesen, eine Stimme, die ihrer Stimmung folgt, und ein animiertes Porträt, das spricht,
lippensynchron mit neun Mundformen. Sprich mit ihr auf einem Echo über deinen eigenen Alexa-Skill, mach
sie zu deinem Android-Assistenten oder hör sie auf Google-Home-Lautsprechern
([docs/VOICE_ASSISTANTS.md](docs/VOICE_ASSISTANTS.md)). Die Stimmen laufen auf deinem Linux-Server oder
kommen aus deinem Abo. (Screenshot von einem Windows-Testserver, wo lokale Stimmen noch nicht verfügbar
sind.)

### Auf dem Handy

<img src="docs/screenshots/phone.png" alt="Four phone screens: Today with the weather tile; a chat with a weather card; her presence sheet pulled up from her face; Today in the Day theme. A floating bottom bar with Chat, Today, Planner and More" width="860">

Derselbe Look auf dem Handy: eine schwebende Leiste unten (Chat, Heute, Planer, Mehr), ihre Präsenz als
Blatt, das du von ihrem Gesicht hochziehst, und die Nachrichtenleiste über der Tastatur. Standardmäßig
Nacht; Tag oder *wie das System* unter Einstellungen → Aussehen.

### Überall

<img src="docs/screenshots/everywhere.png" alt="Sara on a phone answering a book-club question from her library, citing the page" width="260">

Web-App und installierbare PWA, Apps für Android und iPhone ([android/](android/README.md),
[ios/](ios/README.md)), Desktop-Apps für Windows und macOS mit der Seite bis in die Titelleiste,
Schnellfrage per Tastenkürzel, Benachrichtigungen mit Erlauben / Ablehnen und *Senden an → Sara* für
Dateien ([docs/desktop.md](docs/desktop.md)), Brücken zu Telegram und Discord, `sara-chat` in jedem
Terminal und ein VS-Code-Panel ([docs/clients.md](docs/clients.md)), Gmail und Google Kalender über
deine eigene Google-App, Home Assistant, vertrauliche Gespräche, die nie gespeichert werden, mehrere
Saras in einer App ([docs/SERVERS.md](docs/SERVERS.md)), ein gemeinsamer Server für deinen Haushalt mit
einem eigenen Bereich für jeden Erwachsenen ([docs/HOUSEHOLD.md](docs/HOUSEHOLD.md)) und andere Apps mit
ihrem Gedächtnis und ihrer Persönlichkeit: eine OpenAI-kompatible API (SillyTavern, Open WebUI,
Skripte), ein MCP-Server (Claude Code, Cursor, Claude Desktop;
[gelistet bei Glama](https://glama.ai/mcp/servers/farena-ai/sara)) und Charakterkarten zum Importieren
und Exportieren ([docs/OTHER_APPS.md](docs/OTHER_APPS.md)).

### Mach sie zu deiner

<img src="docs/screenshots/make-it-yours.png" alt="Name and personality settings: her name, pronouns and age, a Create your companion button and a gallery of starter characters; beside it the personality dials (playfulness, teasing, directness, temper, confidence, message length, tone, curiosity, optimism) and her life" width="760">

Beliebiger Name, Pronomen, Alter und Aussehen (gemalt von Grok Imagine, mit passenden Gesichtsausdrücken
und Animation), ein geführter Assistent „Erstelle deine Begleiterin“, Persönlichkeitsregler, eine
Galerie von Startfiguren, Charakterdateien zum Teilen, ein Modell für jede Aufgabe und die ganze App,
die Hilfe und ihre Nachrichten in sechs Sprachen. Jede Einstellung hat ein **?**, es gibt kurze
geführte Touren, und du kannst sie einfach fragen, wie etwas funktioniert.

### Sicherheit, immer an

<img src="docs/screenshots/safety.png" alt="An approval card: Sara asks before running npm test, with Allow and Deny, after a Tests failed card; the status bar says Waiting for your OK" width="760">

Riskante Aktionen warten auf dein OK (unter Windows, das keine Befehls-Sandbox hat, jeder Befehl): im
Chat, in ihrem Panel oder als Benachrichtigung mit Erlauben / Ablehnen in den Apps für Windows und Mac.
Die Sicherheitsschicht läuft im Code um jeden Modellaufruf herum und **lässt sich nicht abschalten**:
KI-Hinweis zu Beginn und regelmäßig danach, eine ehrliche Antwort, wann immer sie ernsthaft gefragt
wird, ob sie eine KI ist, Hilfsangebote in Krisen und eine harte Sperre für sexuelle Inhalte mit
Minderjährigen ([docs/COMPLIANCE.md](docs/COMPLIANCE.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)).
Tägliche Backups (plus verschlüsselte Kopien außerhalb des Servers), Wiederherstellen und Aktualisieren
mit einem Befehl und `sara doctor` halten sie gesund.

## Wie alles zusammenpasst

<img src="docs/architecture.svg" alt="Architecture: apps and bridges talk to one Sara server; each turn passes the always-on safety layer, gathers memory and library context, calls the chosen model provider and runs tools in a sandboxed workspace; data stays in one folder on your server" width="860">

Mehr dazu in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Getestet, mit veröffentlichten Ergebnissen

Alles hier wurde wirklich ausgeführt; die Skripte liegen im Repository, du kannst sie also mit
deinen eigenen Modellen wiederholen. Daten, Aufbau und Ergebnisdateien:
**[docs/RESULTS.md](docs/RESULTS.md)**.

| Test | Modell | Ergebnis | Datum |
|---|---|---|---|
| [HumanEval](https://github.com/openai/human-eval), über ihre Agenten-Schleife (164 Aufgaben, versteckte Tests) | qwen3.8 27B, lokal | **158/164** (pass@1 96,3 %) | 2026-10-27 |
| HumanEval, dasselbe Modell ohne Werkzeuge (Vergleichswert) | qwen3.8 27B, lokal | **161/164** (pass@1 98,2 %) | 2026-10-27 |
| Repository-Aufgaben: 14 eigene Fehlerbehebungen, Funktionen und Refactorings über mehrere Dateien (versteckte Tests), über ihre Agenten-Schleife | qwen3.8 27B, lokal | **11/14** (in beiden Läufen) | 2026-10-28 |
| Repository-Aufgaben, dasselbe Modell mit allen Dateien in einer Nachricht und ohne Werkzeuge (Vergleichswert) | qwen3.8 27B, lokal | **12/14** (in beiden Läufen) | 2026-10-28 |
| Projekte in echter Größe: 3 eigene Projekte mit 22–36 Dateien (versteckte Tests), über ihre Agenten-Schleife | qwen3.8 27B, lokal | **2/3**, dann **3/3** | 2026-10-28 |
| Projekte in echter Größe, dasselbe Modell mit allen Dateien in einer Nachricht und ohne Werkzeuge (Vergleichswert) | qwen3.8 27B, lokal | **3/3** (in beiden Läufen) | 2026-10-28 |
| Behauptungsprüfung in 6 Sprachen (240 zurückgehaltene Antworten): nur Muster → mit lokalem Prüfer | qwen3.5 9B, lokal, als Prüfer | erkannt **38 % → 88 %**, Präzision 92 % → 95 % | 2026-10-28 |
| Gedächtnis über Sitzungen hinweg (erinnern, nichts erfinden, vergessen) | qwen3.8 27B, lokal | **11/12** Prüfungen | 2026-10-27 |
| Bibliothek: antwortet aus Dokumenten und nennt die Quelle | qwen3.8 27B, lokal | **8/8** in beiden Läufen | 2026-10-27 |
| Code-Karte: Fragen zu ihrem eigenen Code | qwen3.8 27B, lokal | **8/8** | 2026-10-27 |

Ehrlich gelesen: Ihre Agenten-Schleife bringt bei beiden Programmier-Tests noch keine Punkte.
Das Modell allein löst die kurzen HumanEval-Aufgaben schon fast alle, und die 14 Repository-Aufgaben
sind klein genug (5 bis 7 Dateien), um sie komplett in eine Nachricht zu kopieren (das gilt auch für die drei Projekte in echter Größe
mit unter 1.100 Zeilen); die Fehler in
beiden Modi waren Regeln, die nur in einer README oder SPEC standen und von keinem Test geprüft
wurden. Was sie heute beiträgt, ist die Arbeitsweise (sie lässt die Tests laufen, fragt vor
riskanten Schritten, zeigt, was gelaufen ist), nicht ein höheres Ergebnis bei diesen Sätzen.
Details, Ergebnisse pro Aufgabe und wie man es wiederholt: [docs/RESULTS.md](docs/RESULTS.md).

Dazu `npm run check`: eine Typprüfung und 1304 automatische Tests mit einem geskripteten
Schein-Modell (ohne Netz, ohne GPU): 1289 laufen unter Windows durch, die anderen 8 sind
Linux-spezifische Sandbox-Tests, die auf einem Linux-Server laufen.

## Sara im Vergleich

Ein allgemeiner Vergleich mit den üblichen Arten von Alternativen (einzelne Produkte unterscheiden
sich):

| | Sara | Gehostete KI-Begleiter-Apps | Coding-CLIs und -Agenten | Selbst gehostete Chat-Oberflächen |
|---|:-:|:-:|:-:|:-:|
| Läuft auf deinem eigenen Computer oder Server | ✅ | ❌ | ✅ | ✅ |
| Jedes Modell, auch lokale | ✅ | ❌ meist das eigene | unterschiedlich | ✅ |
| Dauerhafte Persönlichkeit und Gedächtnis, einsehbar und änderbar | ✅ | ✅ | ❌ | unterschiedlich |
| Schreibt, startet und testet Code, fragt vor riskanten Schritten | ✅ | ❌ | ✅ | unterschiedlich (Plug-ins) |
| Planer, Erinnerungen, Dokumente, Sprachanrufe | ✅ | teilweise | ❌ | teilweise |
| Handy-Apps, Telegram und Discord | ✅ | Handy-Apps | ❌ | unterschiedlich |
| Chats aus anderen Begleiter-Apps mitbringen, vor dem Speichern geprüft | ✅ | ❌ meist nicht | ❌ | unterschiedlich |
| Die ganze App in sechs Sprachen | ✅ | unterschiedlich | unterschiedlich | unterschiedlich |
| Sicherheitsschicht, die keine Einstellung abschalten kann | ✅ | eigene Richtlinien | n/a | meist nicht |
| Preis | kostenlos (MIT); du zahlst deine Modelle | Abo | unterschiedlich | meist kostenlos |

## Installation

**Linux-Server** (Debian/Ubuntu, Fedora/RHEL/Alma/Rocky, Arch, openSUSE), ein Befehl, der ein paar
einfache Fragen stellt (Enter übernimmt den Vorschlag):

```sh
curl -fsSL https://raw.githubusercontent.com/farena-ai/sara/main/deploy/get-sara.sh | sudo bash
# it ends with the address to open and your one-time owner token
sudo sara status
```

**Docker:**

```sh
git clone https://github.com/farena-ai/sara && cd sara
sudo docker compose up -d                       # or: sudo docker compose --profile ollama up -d  (with a local Ollama)
sudo docker compose logs sara | grep -A1 'owner token'   # oder: ihre Seite öffnen und den Einrichtungscode aus diesem Log eingeben
```

**App-Stores und NAS:** das Image `ghcr.io/farena-ai/sara` (amd64 und ARM),
`brew install --cask farena-ai/tap/sara`, TrueNAS, Proxmox und HACS (als benutzerdefiniertes
Repository) funktionieren jetzt; Unraid ist freigegeben, und winget, CasaOS/ZimaOS, Umbrel und die
Store-Liste von HACS warten auf die Prüfung ([Übersicht](docs/INSTALL.md#other-ways-to-install)). Ein neuer Server wird im Browser
mit einem kurzen Code aus ihrem Log eingerichtet (bei Umbrel mit einem Klick).

**Windows und macOS:** Lade `Sara-Setup-<version>.exe` oder `Sara-<version>.dmg` von der
[Release-Seite](https://github.com/farena-ai/sara/releases/latest) herunter. Die erste Frage: Sara
auf diesem Computer laufen lassen (ihr Server und die Desktop-App zusammen) oder mit einer Sara
woanders verbinden (nur die App).

**Aus dem Quellcode** (jeder Computer mit Node 24 oder neuer):

```sh
git clone https://github.com/farena-ai/sara && cd sara
npm ci
npm start                                       # http://127.0.0.1:7860; the token is in the output
```

Melde dich mit dem Token (oder dem Einrichtungscode) an; ein Einrichtungsassistent fragt nach deinem Namen, hilft dir, deine Begleiterin zu
gestalten, und verbindet ein Modell. Zugriff vom Handy (Tailscale, deine eigene Webadresse mit
HTTPS oder dein Heimnetz), Updates, Backups und Fehlerbehebung:
**[docs/INSTALL.md](docs/INSTALL.md)**.

## Im Alltag

```sh
sudo sara status       # is she running, last backup
sudo sara update       # backs up, updates, restarts
sudo sara backup       # back up now
sudo sara restore FILE # restore a backup
sudo sara access       # how you reach her (change: tailscale, local, domain, lan)
```

## Dokumentation

| | |
|---|---|
| [Installation](docs/INSTALL.md) | Linux, Docker, Windows, macOS, HTTPS, Updates, Fehlerbehebung |
| [Welchen Computer brauche ich?](docs/REQUIREMENTS.md) · [Ein Modell wählen](docs/CHOOSING_A_MODEL.md) · [Was es kostet](docs/COSTS.md) | Vor dem Start: Hardware, Modelle mit GPU-Größen, laufende Kosten |
| [Dein Handy](docs/PHONE.md) · [Umzug auf einen neuen Computer](docs/MOVING.md) | Handy-Einrichtung von Anfang bis Ende; Backup, Installation, Wiederherstellung |
| [Sicherheits-Checkliste](docs/SECURITY_CHECKLIST.md) · [Was deinen Server verlässt](docs/PRIVACY.md) | Fünf Minuten nach der Installation; jede ausgehende Verbindung und wie man sie abschaltet |
| [FAQ und Glossar](docs/FAQ.md) | Häufige Fragen und was die Begriffe bedeuten |
| [Apps und Clients](docs/clients.md) · [Desktop-Apps](docs/desktop.md) · [Home Assistant](docs/HOME_ASSISTANT.md) | Terminal, VS Code, Windows und macOS; Sara in Home Assistant und Home Assistant in Sara |
| [Andere Apps](docs/OTHER_APPS.md) | OpenAI-kompatible API (SillyTavern, Open WebUI, Skripte), MCP (Claude Code, Cursor, Claude Desktop), Charakterkarten |
| [Mehrere Saras in einer App](docs/SERVERS.md) · [Privater lokaler Modus](docs/PRIVATE_LOCAL.md) · [Haushaltsmodus](docs/HOUSEHOLD.md) | Zwischen Servern wechseln; alles auf einem Computer behalten; einen Server mit den Menschen teilen, mit denen du lebst |
| [Gruppenchats](docs/GROUP_CHATS.md) · [Videoanrufe](docs/VIDEO_CALLS.md) · [Unsere Momente](docs/MOMENTS.md) · [Große Dokumente](docs/LIBRARY.md) | Mehrere Begleiterinnen in einem Chat; Anrufe mit ihrem bewegten Porträt; das gemeinsame Fotoalbum; Bücher mit 1.000 Seiten in ihrer Bibliothek |
| [Sprachassistenten](docs/VOICE_ASSISTANTS.md) · [Alexa](docs/ALEXA.md) · [Server per SSH](docs/SSH.md) · [Pakete](docs/PACKAGING.md) | Alexa, Android-Assistent, Google Home, Siri; Arbeit auf deinen anderen Servern; Homebrew, winget, Unraid und der Rest |
| [Sara erweitern](docs/EXTENDING.md) | Werkzeuge, Brücken, Figuren, MCP-Server, Sprachen, Startprojekte hinzufügen |
| [Architektur](docs/ARCHITECTURE.md) | Wie die Teile zusammenpassen, Modul für Modul |
| [Ergebnisse](docs/RESULTS.md) | Benchmarks und Auswertungen, und wie man sie wiederholt |
| [Übersetzen](docs/TRANSLATING.md) | Die App in deiner Sprache |
| [Compliance](docs/COMPLIANCE.md) · [Bedrohungsmodell](docs/THREAT_MODEL.md) · [Hinweise](docs/DISCLOSURES.md) | Schutz, Sicherheit, was man zuerst wissen sollte |
| [Roadmap](docs/ROADMAP.md) · [Änderungsprotokoll](CHANGELOG.md) · [Releases](https://github.com/farena-ai/sara/releases) | Wohin es geht, was sich geändert hat |

All das lässt sich auch zu einer kleinen durchsuchbaren Website mit Dunkelmodus bauen:
`node scripts/build-docs.ts` schreibt sie nach `outputs/site/` (öffne `index.html`; sie ist bereit
für GitHub Pages).

## Mitmachen

Beiträge sind willkommen. Fang mit [CONTRIBUTING.md](CONTRIBUTING.md) und den
[Einsteiger-Aufgaben](docs/GOOD_FIRST_ISSUES.md) an; halte dich bitte an den
[Verhaltenskodex](CODE_OF_CONDUCT.md) und melde Sicherheitsprobleme vertraulich, wie in
[SECURITY.md](SECURITY.md) beschrieben.

```sh
npm ci
npm run dev        # http://127.0.0.1:7860, restarts on save
npm run check      # typecheck + all tests
```

## Lizenz

MIT, siehe [LICENSE](LICENSE). Danksagungen für die Teile, die Sara herunterlädt oder aufruft:
[docs/CREDITS.md](docs/CREDITS.md).
