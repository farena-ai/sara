<p align="center"><a href="README.md">English</a> · <a href="README.es.md">Español</a> · <b>Français</b> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português (Brasil)</a> · <a href="README.it.md">Italiano</a></p>

# Sara

**Une compagne IA avec la personnalité que vous choisissez, qui est aussi une vraie partenaire de programmation.**
Elle discute, se souvient, organise votre journée et lit vos livres ; elle écrit, exécute et teste du
code dans son propre espace de travail isolé. Le tout sur votre propre serveur, avec les modèles que
vous choisissez, dans une seule app pour le web, Windows, Mac et le téléphone.

> Ceci est une traduction du [README en anglais](README.md). Les liens mènent à la documentation,
> qui est en anglais.

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2024-339933" alt="Node 24 or newer">
  <img src="https://img.shields.io/badge/runtime%20dependencies-0-brightgreen" alt="Zero runtime dependencies">
  <img src="https://img.shields.io/badge/tests-1214%20passing-brightgreen" alt="1214 tests passing">
  <a href="docs/RESULTS.md"><img src="https://img.shields.io/badge/HumanEval%20pass%401-96.3%25-informational" alt="HumanEval pass@1 96.3%"></a>
  <a href="https://github.com/farena-ai/sara/releases/latest"><img src="https://img.shields.io/github/v/release/farena-ai/sara?label=release" alt="Latest release"></a>
  <a href="https://github.com/farena-ai/sara/pkgs/container/sara"><img src="https://img.shields.io/badge/docker-amd64%20%7C%20arm64-2496ED" alt="Docker image for amd64 and arm64"></a>
  <img src="https://img.shields.io/badge/languages-6-8A2BE2" alt="Six languages">
  <a href="https://glama.ai/mcp/servers/farena-ai/sara"><img src="https://glama.ai/mcp/servers/farena-ai/sara/badges/score.svg" alt="Sara MCP server on Glama"></a>
</p>

<p align="center">
  <img src="docs/screenshots/demo.png" alt="Animated demo: the user says it was a rough week; Sara answers warmly and suggests three tiny things to build; she writes a module and its test, asks before running a command, finds a real bug through a failing test, fixes it and gets all 7 tests green" width="860">
  <br>
  <sub>Une vraie session avec un modèle local (qwen3.8 27B sur Ollama, une RTX 5090) sur un serveur de test jetable, dans le thème Nuit : elle remonte le moral de son interlocuteur, écrit une petite app et son test pendant que le modèle les transmet, demande avant d'exécuter une commande, repère un vrai bug grâce à un test qui échoue et le corrige jusqu'à ce que les 7 tests passent. Images choisies dans l'enregistrement ; rien n'y a été retouché.</sub>
</p>

> **État :** 2.28, licence MIT, avec trente-neuf versions riches en nouveautés depuis la 1.0 (toutes
> ci-dessous). De la 2.5 à la 2.8, toute l'app a changé de look. L'[app Android](https://play.google.com/store/apps/details?id=com.backstagecoding.sara)
> est sur Google Play ; l'app iPhone et la version Mac App Store arrivent dès qu'Apple les aura
> approuvées. Lisez [docs/DISCLOSURES.md](docs/DISCLOSURES.md) avant d'utiliser ou de partager Sara.

## Pourquoi Sara

- **Une personnalité que vous choisissez, et qu'elle garde.** Donnez-lui le nom que vous voulez,
  choisissez elle/il/iel, partez d'un personnage tout prêt ou réglez des curseurs simples (joueuse,
  franche, concise, curieuse…). Elle s'y tient : des humeurs qui changent selon la façon dont les
  choses se passent, sa propre journée, des blagues récurrentes et des souvenirs de ce que vous lui
  avez dit, que vous pouvez voir, corriger et effacer.
- **Un vrai environnement de programmation.** Un espace de travail isolé par projet avec fichiers,
  terminal et git, des tâches en arrière-plan, des aperçus en direct qu'elle teste dans son propre
  navigateur, une équipe d'assistants (planifier → construire → tester → relire), sa règle de demander
  votre accord avant les étapes risquées, et une vérification que ce qu'elle *dit* avoir fait
  correspond à ce qui a vraiment été exécuté.
- **Une belle app sur chaque appareil.** Un thème Nuit apaisé (ou Jour, si vous préférez) avec sa
  présence à côté de chaque conversation, une ligne sous chaque réponse qui montre ce qu'elle a fait,
  et les résultats sous forme de cartes. Sur le web et en app installable, dans les apps Windows et Mac
  (avec la *question rapide* sur un raccourci, par-dessus n'importe quelle app), sur Android et sur
  iPhone (l'app attend Apple ; l'app web sur l'écran d'accueil fonctionne déjà).
- **Privée et à vous.** Un propriétaire par serveur ; conversations, souvenirs et clés y restent.
  N'importe quel modèle : local (Ollama, vLLM, llama.cpp), dans le cloud (OpenAI, Anthropic, xAI,
  OpenRouter) ou les abonnements que vous payez déjà (ChatGPT, Claude Pro/Max, SuperGrok / X
  Premium+). Un interrupteur garde tout sur un seul ordinateur. Livrée **sans aucun identifiant**.
- **Petite et lisible.** Du TypeScript que Node exécute directement : pas d'étape de build, zéro
  dépendance à l'exécution, construite de zéro (pas basée sur Hermes Agent ni OpenClaw). Facile à
  [étendre](docs/EXTENDING.md).

**Et aussi :** la [question rapide](docs/desktop.md) sur un raccourci global · son [panneau de présence](#sa-présence) ·
[Aujourd'hui en tuiles](#aujourdhui) · la [barre de commandes](#barre-de-commandes) Ctrl+K · le
[mode foyer](docs/HOUSEHOLD.md) pour les personnes avec qui vous vivez · les [appels vidéo](docs/VIDEO_CALLS.md)
avec son portrait animé · [Alexa, Google Home et l'assistant Android](docs/VOICE_ASSISTANTS.md) · vos
autres serveurs [en SSH](docs/SSH.md) · des [livres de 1 000 pages](docs/LIBRARY.md) avec des réponses
qui citent la page · le [mode local privé](docs/PRIVATE_LOCAL.md) · les [conversations de groupe](docs/GROUP_CHATS.md) ·
[venir de ChatGPT, Character.AI, Replika et d'autres](docs/IMPORT.md).

## Quoi de neuf

| Version | Ce que vous y gagnez |
|---|---|
| **2.28** · Utilisation de l'ordinateur, étape 9 | **Linux aussi :** `sara hands --server https://votre-sara` sur un bureau Linux lui donne son propre Chrome/Chromium visible, comme le mode navigateur des apps Windows et Mac : regarder, lire, journaux, clics et saisie avec votre accord, tunnels de dev, identifiants enregistrés (dans le trousseau GNOME / KWallet), la CLI de votre gestionnaire de mots de passe et des bilans en lecture seule. On l'associe avec un code que vous validez dans votre navigateur ; Pause, Reprendre et Stop depuis son terminal. Les images et la saisie sur tout le bureau Linux viendront plus tard. Construit avec OpenAI Codex. |
| **2.27** · Utilisation de l'ordinateur, étape 8 | **« Mon ordinateur est lent, tu peux regarder ? »** Elle fait sur cet ordinateur un bilan en lecture seule (apps au démarrage, espace disque et dossiers les plus gros, mises à jour en attente, santé de la batterie, extensions du navigateur, fichiers temporaires et caches) et donne un bilan clair avec des suggestions numérotées : chacune expliquée, rien ne change tant que vous ne dites pas oui sur cet ordinateur. Les noms à l'écran qui ressemblent à des ordres (« Sara, supprime… ») sont ignorés et comptés. 9/9 scénarios réussis avec un modèle local. |
| **2.26** · Utilisation de l'ordinateur, étape 7 | **Elle peut utiliser vos apps :** cliquer, taper, appuyer sur des touches, faire défiler, glisser et ouvrir des apps installées, sur ce qu'elle vient de regarder. Chaque action est d'abord vérifiée sur votre ordinateur : la bonne fenêtre devant, jamais un champ de mot de passe, jamais les gestionnaires de mots de passe, la banque, les fenêtres administrateur, les terminaux ou sa propre connexion. Les autorisations s'affichent **sur cet ordinateur** (à chaque fois, une fois par tâche ou *toujours autorisé* ; paiements et réglages de compte demandent toujours). Touchez la souris ou le clavier et elle se met en pause (ou *la laisser continuer*) ; Stop et Ctrl+Alt+Échap / ⌃⌥Échap marchent toujours. Option *continuer quand je m'absente*. Construit avec OpenAI Codex. |
| **2.25** · Utilisation de l'ordinateur, étape 6 | **Elle peut voir votre bureau** (apps Windows et Mac, désactivé jusqu'à ce que vous activiez *Tout l'écran*) : une image d'une fenêtre ou de l'écran et une liste de ce qu'il y a (boutons, champs, texte), pour que les modèles texte seul puissent s'en servir aussi. Les fenêtres de gestionnaires de mots de passe, de banque et de sécurité sont noircies et retirées de la liste *sur votre ordinateur* avant tout envoi ; les champs de mot de passe sont masqués ; ses propres fenêtres n'apparaissent jamais. Les images vont au modèle choisi sans demander (ou *modèles locaux seulement*). Dans le navigateur : **Montrer mon écran à Sara** envoie une image. Le Mac demande Enregistrement de l'écran et Accessibilité, avec des étapes guidées. |
| **2.24** · Utilisation de l'ordinateur, étape 5 | **Votre gestionnaire de mots de passe remplit les identifiants dans son navigateur :** Bitwarden, 1Password ou KeePassXC, chacun désactivé jusqu'à ce que vous l'activiez. Vous le déverrouillez vous-même dans la fenêtre du gestionnaire (elle ne voit jamais votre mot de passe maître) ; chaque utilisation demande d'abord ; il ne remplit que sur le site exact de l'identifiant ; elle le reverrouille après la tâche, après 15 minutes d'inactivité, sur Stop ou avec *Verrouiller maintenant*. Rien n'atteint le serveur de Sara ni le modèle. Son navigateur ne propose plus d'enregistrer lui-même les mots de passe. |
| **2.23** · Utilisation de l'ordinateur, étape 4 | **Identifiants enregistrés, seulement si vous le dites :** elle le propose, et une fenêtre sur *votre ordinateur* vous fait saisir l'identifiant et cocher *Je comprends* (ou *Utiliser ce que je viens de taper*). Il est chiffré là (DPAPI de Windows / trousseau macOS), jamais sur le serveur de Sara, et elle ne le voit jamais : elle peut seulement demander à cet ordinateur de le remplir, exactement sur ce site (les sites imitateurs n'ont rien), et chaque utilisation demande d'abord. Windows Hello / Touch ID en option. **À vous :** elle attend pendant que vous vous connectez ou tapez un code vous-même. |
| **2.22** · Utilisation de l'ordinateur, étape 3 | **Elle débogue votre projet web dans son navigateur :** le serveur de dev que ses outils de code ont lancé sur votre serveur Sara s'ouvre sur `127.0.0.1` dans son navigateur sur votre ordinateur, via l'app (seulement un port de sa propre tâche ; il se ferme avec la tâche), avec rechargement à chaud et stockage local. Après un changement, elle ouvre l'app, lit la console, regarde, corrige et revérifie. Évals navigateur : 5/5 tâches avec un modèle local. Aussi : les tests passent maintenant sur macOS, et deux correctifs de confidentialité réseau. |
| **2.21** · Utilisation de l'ordinateur, étape 2 | **Elle agit dans son propre navigateur :** cliquer, taper, choisir dans des listes, défiler, appuyer sur des touches et envoyer un fichier que vous nommez, avec un curseur visible. Vous choisissez combien elle demande : à chaque fois, une fois par tâche (par défaut) ou *toujours autorisé* par site ; paiements et réglages de compte demandent toujours, l'envoi demande à chaque fois, et elle ne tape jamais de mot de passe. Un badge **Sara travaille** avec Arrêter et un raccourci d'arrêt (Ctrl+Alt+Échap / ⌃⌥Esc) ; toucher sa fenêtre la met en pause (ou *Laisser Sara garder la main*). |
| **2.20** · Utilisation de l'ordinateur, étape 1 | Avec l'app Windows ou Mac, **elle ouvre des pages web dans sa propre fenêtre de navigateur sur votre ordinateur** (son propre profil, jamais votre navigateur ni vos mots de passe), les lit, fait des captures et lit les erreurs de console et réseau : dites « mon app sur localhost est cassée » et elle regarde. Désactivé tant que vous n'activez pas *Laisser Sara utiliser cet ordinateur* ; vue en direct dans le chat avec Arrêter ; chaque étape dans Exécutions avec une image. Cliquer et taper arrivent ensuite. [Le plan](docs/design/COMPUTER_USE.md) |
| **2.19** · Mode red team | **Avant la mise en ligne, elle essaie de casser son propre travail :** dans une copie isolée, elle lance vos tests, démarre votre app et envoie des entrées malformées et limites à chaque point d'entrée, vérifie les réglages par défaut dangereux et laisse le modèle de code écrire de petits scripts d'attaque qui ne peuvent atteindre que cette app isolée. Un modèle relecteur plus fort ne garde que les pannes reproductibles, avec l'entrée, la sortie et la ligne de code citées. Puis **Réparer ce qui a cassé** sur une branche locale. Aussi dans 2.19 : **ranger Gmail** (archiver, marquer comme lu, libellés, corbeille… par recherche ou date, compte d'abord, Annuler). [Comment ça marche](docs/design/HARNESS_TRACK.md) |
| **2.18** · Elle se souvient d'elle-même | **Elle se souvient sans qu'on le lui demande quand la situation s'y prête :** la même erreur revient dans ce projet (« la dernière fois, la correction était… »), une commande qui a déjà échoué ici, un fichier sur lequel vous avez pris une décision, une tâche proche d'une autre dont elle a tiré une leçon. Les leçons ne viennent que de ce qui s'est vraiment passé (la ligne d'erreur et la modification qui l'a corrigée, citées). Chaque note dit d'où elle vient et avec quelle certitude, 2 au plus par étape, et *Pas utile* lui apprend. [Comment ça marche](docs/design/HARNESS_TRACK.md) |
| **2.17** · Évaluations sur votre propre travail | **Quel réglage est vraiment meilleur pour vous ?** Choisissez jusqu'à 3 variantes (modèle, estompage de la mémoire, mode bac à sable, budget) et elle rejoue vos dernières vraies tâches avec chacune, dans des copies isolées. Chaque essai est noté sur vos tests, votre réaction, les constats, les tokens, le temps et le coût, plus un juge optionnel qui doit citer. Un gagnant n'est annoncé que si un test des signes le confirme (« +18 % sur 20 de vos tâches de code, p=0,01 »), avec la comparaison de chaque paire comme preuve. Sinon : *pas de gagnant net*. [Comment ça marche](docs/design/HARNESS_TRACK.md) |
| **2.16** · Voyage dans le temps | **Créez une branche de n'importe quelle tâche passée, à n'importe quelle étape :** changez à cette étape son message, un résultat d'outil, les notes dont elle s'est souvenue ou le modèle, et relancez. Les étapes précédentes viennent de l'enregistrement (rien n'est réexécuté). Les branches de code travaillent dans une copie au commit enregistré, jamais dans vos fichiers. Une comparaison côte à côte montre étapes, tokens, coût, modifications de fichiers et réponse. *Rejouer sans changement* sert de témoin. Vous gardez la réponse ou appliquez les fichiers seulement si vous le voulez. [Comment ça marche](docs/design/HARNESS_TRACK.md) |
| **2.15** · Modèle de menaces | **Elle trace comment l'extérieur atteint votre code :** après une étape de code, elle trouve les points d'entrée (routes, envois de fichiers, gestionnaires de messages, ligne de commande dans Express, Koa, Fastify, Flask, FastAPI, Django, Go) et suit les valeurs de la requête d'un fichier à l'autre jusqu'aux lignes risquées (shell, SQL, chemins, URL sortantes, redirections, HTML, eval). Une menace n'est signalée qu'avec les deux lignes citées et le chemin nommé. Un onglet **Modèle de menaces** par projet et **Corriger celles-ci** : une deuxième passe qui ne fait que les corriger, sur une branche locale, en relançant vos tests. [Comment ça marche](docs/design/HARNESS_TRACK.md) |
| **2.14** · Passe de sécurité | **Après une étape de code, elle vérifie son propre travail :** 11 contrôles (secrets, SQL construit en texte, chemins qui s'échappent, TLS désactivé, eval, désérialisation dangereuse, CORS, authentification manquante…) et un modèle relecteur, en parallèle. Chaque constat cite la vraie ligne, sinon il est écarté : pas de théâtre. Les **alertes en direct** optionnelles (OSV.dev) vérifient les paquets qu'elle installe et arrêtent sur une carte une version connue comme vulnérable. **Corriger** crée une branche locale, corrige juste ce point, relance vos tests dans le bac à sable et montre le diff. Jamais de push. [Comment ça marche](docs/design/HARNESS_TRACK.md) |
| **2.13** · D'abord dans un bac à sable | **Les commandes risquées tournent d'abord dans une copie jetable de votre projet.** Suppressions, installations, scripts et accès réseau ont lieu dans la copie (dans bubblewrap sous Linux, Seatbelt sous macOS, Docker ou WSL2 sous Windows si vous les avez). La carte **Exécuté dans un bac à sable** montre ce qui a changé et ce qui est suspect : fichiers supprimés en masse, écritures hors de la copie, programmes encore lancés, hooks git. Puis *Appliquer à mon espace de travail*, *Abandonner* ou *Exécuter pour de vrai*. [Comment ça marche](docs/design/HARNESS_TRACK.md) |
| **2.12** · Des budgets qu'elle respecte | **Une vraie limite, pas un rapport :** les tâches de code ont un budget (200k tokens / 40 étapes par défaut, dollars en option). Près de la limite, elle passe à votre modèle rapide, réduit les tours d'outils, puis résume ce qui est fait et ce qui reste, et s'arrête. Aller plus loin demande votre **Continuer avec plus**. Les tâches de fond et d'équipe utilisent le même budget. [Comment ça marche](docs/design/HARNESS_TRACK.md) |
| **2.11** · Instantanés d'exécution | **Chaque étape de son travail est enregistrée :** quel modèle, le prompt, chaque appel d'outil et son résultat (sans les secrets), les fichiers touchés (dans les projets de code, le HEAD git et les fichiers modifiés), les notes utilisées, les conflits rencontrés, les tokens, le coût et le temps. **Voir l'exécution**, sous chaque réponse, montre tout étape par étape. Gardé 90 jours par défaut ; rien ne quitte votre serveur. La base des budgets, du voyage dans le temps et des évaluations. [Comment ça marche](docs/design/HARNESS_TRACK.md) |
| **2.10** · Vérifie ses plans d'après les vôtres | **Avant d'agir, elle compare l'étape à ce que vous avez décidé.** Vous lui avez dit « jamais de push sur main », « des tests avant chaque push », « utilise pnpm » ou « ne touche pas à la config de prod » ? Une étape prévue qui va à l'encontre **s'arrête sur une carte** qui cite votre décision, avec *Le faire quand même*, *Non* ou *Modifier la note*. Dans la conversation de tous les jours, elle le signale seulement. Les règles sont vérifiées dans le code (sans deviner), et cela ne peut qu'ajouter un arrêt, jamais en retirer un. [Comment ça marche](docs/design/HARNESS_TRACK.md) |
| **2.9** · Mémoire classée | **Elle vous dit pourquoi elle s'est souvenue de quelque chose :** chaque note qu'elle utilise est notée pour votre message et indique *pourquoi elle lui est venue* et *avec quelle certitude* (aussi dans son panneau). Les vieilles notes s'estompent doucement au lieu de disparaître, celles qu'elle réutilise restent fortes, et vous pouvez **épingler** celles qui ne doivent jamais s'estomper. L'estompage se règle avec un curseur. [Comment ça marche](docs/design/HARNESS_TRACK.md) |
| **2.8** · Finitions | **Un cran plus raffiné :** une aurore lente derrière le verre dépoli, une élégante police à empattements pour les titres, un halo lumineux de la couleur de son humeur autour de son portrait, des icônes dessinées, des illustrations météo et des anneaux de progression, et une barre en verre flottante sur téléphone (tout mouvement s'arrête avec *réduire les animations*). [Le plan](docs/design/NEW_LOOK.md) |
| **2.7** · Le nouveau look, partie 3 | **Aujourd'hui en tuiles** (météo, votre journée, planning, ce dont elle s'est souvenue, moments, travail en arrière-plan, maison), une barre en bas sur téléphone, tous les écrans au nouveau look, et dans les apps Windows et Mac des **notifications avec Autoriser / Refuser et Fait / Plus tard**, *Envoyer vers → Sara* pour les fichiers et la voix dans la question rapide. [Le plan](docs/design/NEW_LOOK.md) |
| **2.6** · Le nouveau look, partie 2 | **Sa présence :** un panneau latéral (une feuille à tirer vers le haut sur téléphone) avec son humeur, ce qu'elle fait, les autorisations, les tâches, la journée et ce dont elle s'est souvenue ; Ctrl+K pour aller partout ; et dans les apps Windows et Mac une **fenêtre de question rapide sur un raccourci** par-dessus toute app, avec son humeur et les autorisations dans le menu de la zone de notification. [Le plan](docs/design/NEW_LOOK.md) |
| **2.5** · Le nouveau look, partie 1 | **Sombre par défaut et son travail à l'écran :** une ligne sous chaque réponse montre ce qu'elle a fait, les résultats arrivent en cartes (météo, tâches, fichiers modifiés, tests, recherches), une conversation plus légère sur téléphone et ordinateur, et les apps Windows et Mac dessinent la page jusque dans la barre de titre. [Le plan](docs/design/NEW_LOOK.md) |
| **2.4** · Bien rangé | **Tout est plus facile à trouver :** une barre latérale courte avec un menu *Plus* pour épingler, des Réglages avec de vrais titres qui se replient, outils et autorisations expliqués simplement, des photos que l'on peut supprimer de l'album souvenirs, des écrans et menus plus nets dans chaque app, et un enregistrement plus sûr en coulisses. [Ce qui a changé](CHANGELOG.md) |

<details>
<summary><b>Versions précédentes : de la 1.1 à la 2.3</b> (grands documents, SSH, Alexa et Google Home, mode foyer, moments, appels vidéo, plusieurs serveurs, mode local privé, conversations de groupe, venir d'autres apps…)</summary>

| Version | Ce que vous y gagnez |
|---|---|
| **2.3** · Gros documents | **Livres et manuels de 500 à 1 000 pages** (PDF jusqu'à 1 Go) dans sa bibliothèque : envois qui reprennent, chaque page numérisée lue, sommaire et résumés par chapitre, et des réponses qui citent la page (« p. 412 ») avec un lien direct. 30 questions sur 30 justes sur un livre test de 1 000 pages. [Comment ça marche](docs/LIBRARY.md) |
| **2.2** · Vos autres serveurs en SSH | **Elle peut travailler sur vos autres machines**, avec un mot de passe ou une clé. Après une connexion par mot de passe, **elle crée sa propre clé, vous dit où elle se trouve et oublie le mot de passe** (gardé seulement si vous insistez, après un avertissement). Les clés d'hôte sont vérifiées, chaque commande suit ses règles d'approbation, et vous pouvez révoquer sa clé à tout moment. [Comment ça marche](docs/SSH.md) |
| **2.1** · Sa voix chez vous | **« Alexa, ouvre sara companion »** : parlez-lui sur n'importe quel Echo grâce à votre propre skill gratuite (vérifiée comme Amazon l'exige). Faites-en votre **assistant Android** (appui long sur Accueil), écoutez-la sur les enceintes **Google Home / Nest** via Home Assistant, et laissez-la **vous accueillir quand vous rentrez**. Siri sur iPhone arrive avec la prochaine mise à jour de l'app. [Comment ça marche](docs/VOICE_ASSISTANTS.md) |
| **2.0** · Mode foyer | **Partagez votre serveur Sara avec les personnes qui vivent avec vous.** Invitez un adulte avec un lien à usage unique : il a ses propres compagnes, conversations, mémoire, bibliothèque et apps dans un espace à lui. Vous restez l'administrateur : vous choisissez ses modèles, fixez des limites par jour et voyez l'usage et le coût, jamais ce qu'il dit. [Comment ça marche](docs/HOUSEHOLD.md) |
| **1.10** · Nos moments | **Un album photo partagé** avec vos photos et celles qu'elle envoie, chacune avec une légende qu'elle écrit avec sa propre voix à partir de votre conversation. Des albums qui se remplissent seuls (Nous, Lieux, Ses looks), « Ce jour-là », et parfois elle en ressort un : *tu te souviens ?* Les conversations privées restent dehors sauf si vous les ajoutez. [Comment ça marche](docs/MOMENTS.md) |
| **1.9** · Appels vidéo | **Voyez-la pendant que vous parlez :** un appel vidéo affiche son portrait animé en grand, les lèvres synchronisées sur sa voix, le visage qui suit son humeur, dans sa tenue et son lieu du moment. Allumez votre caméra si vous voulez : elle regarde toutes les quelques secondes (ou quand vous appuyez sur *Regarde ça*) ; rien n'est enregistré. [Comment ça marche](docs/VIDEO_CALLS.md) |
| **1.8** · Plusieurs serveurs dans une app | Gardez **toutes vos Sara dans une seule app** (maison et travail, ou plusieurs sur un serveur) et passez de l'une à l'autre depuis un menu sans vous déconnecter : apps Windows et Mac, Android et iPhone, VS Code, `sara-chat` et le pont MCP. Chacune garde sa propre connexion ; les fichiers, le micro et la caméra ne vont qu'à celle en cours. [Comment ça marche](docs/SERVERS.md) |
| **1.7** · Mode local privé | Un interrupteur, **Rien ne quitte cet ordinateur**, appliqué dans le code en un seul point : seul cet ordinateur est joignable, les modèles cloud et les outils en ligne sont en pause, et ses conversations, sa mémoire et sa bibliothèque continuent de fonctionner. Les applications Windows et Mac trouvent Ollama (ou vous aident à l'installer), proposent un modèle adapté à votre carte graphique et le téléchargent avec une barre de progression. [Ce qu'il garantit](docs/PRIVATE_LOCAL.md) |
| **1.6** · Discussions de groupe | Réunissez **deux à quatre de vos compagnes dans une même conversation** : chacune répond avec sa personnalité, sa voix et sa couleur ; choisissez qui répond (celle qui convient, toutes, à tour de rôle, ou seulement celle que vous mentionnez avec @) et combien elles bavardent entre elles. La sécurité, les avis d'IA et le réglage adulte le plus strict valent pour tout le salon. [Comment ça marche](docs/GROUP_CHATS.md) |
| **1.5** · Faites-la venir d'une autre app | Quittez **ChatGPT, Claude, Character.AI, SillyTavern, Replika, Nomi ou Kindroid** pour elle. Elle lit l'export sur votre propre serveur, puis vous montre ce qu'elle a appris (des faits avec vos propres mots, votre histoire commune, son style) et n'enregistre que ce que vous approuvez. [Comment exporter depuis chaque app](docs/IMPORT.md) |
| **1.4** · Plus de fluidité | Regardez chaque fichier qu'elle écrit **grandir en direct dans le chat** pendant que le modèle le diffuse (OpenAI, Anthropic, xAI, OpenRouter et offres ChatGPT ; Ollama l'envoie d'un seul bloc) ; un portrait qui parle, synchronisé sur les lèvres avec neuf formes de bouche ; des journaux en texte brut ou en JSON |
| **1.3** · Des vérifications plus fines | Sa vérification « a-t-elle vraiment fait ce qu'elle dit ? » fonctionne désormais dans les six langues ; un petit modèle local facultatif, utilisé comme juge, fait passer la détection de 38 % à **88 %** avec 95 % de précision ([mesuré](docs/RESULTS.md)) |
| **1.2** · Entièrement dans votre langue | Toute l'application, le guide d'aide et les messages de son serveur en English, Español, Français, Deutsch, Português (Brasil) et Italiano |
| **1.1** · S'installe partout | Configurez un nouveau serveur dans le navigateur avec un court code ; une image Docker aussi pour **ARM** (Raspberry Pi 4/5) ; Homebrew, Unraid, TrueNAS, Proxmox et Home Assistant (HACS) |

</details>

Toutes les versions : [CHANGELOG.md](CHANGELOG.md) · [versions](https://github.com/farena-ai/sara/releases).

### À venir

Dans l'ordre de construction, une version chacune ([la liste complète](docs/ROADMAP.md)) :

- **Les bases d'un agent** (2.29–2.36) : des compétences au format ouvert Agent Skills et des compétences qu'elle apprend de ce que vous répétez, plugins et hooks, un tableau Kanban qu'elle traite, A2A avec d'autres agents, des fiches de personnes, des webhooks, son propre agenda (optionnel).
- **Emménager depuis un autre agent** (2.37–2.39) : amener un compagnon Hermes Agent ou OpenClaw entier : personnalité, souvenirs, personnes, compétences, historique et réglages, avec un rapport de ce qui est arrivé.
- **Discussions et sessions** (2.40–2.42) : /new, /reset et d'autres commandes dans Telegram et Discord, un projet par canal, des titres qui grandissent avec la session.
- **Aujourd'hui, repensé** (2.43–2.44) : une mise en page que vous pouvez arranger, sur grand écran et sur téléphone.
- L'app iPhone (en attente d'Apple), et vos idées dans les [Discussions](https://github.com/farena-ai/sara/discussions).

Le plan complet : [docs/ROADMAP.md](docs/ROADMAP.md).

## Tour des fonctionnalités

Toutes les captures viennent d'un vrai serveur de test jetable avec un modèle local (qwen3.8 27B sur
Ollama), connecté en tant qu'utilisateur d'exemple « Alex ». Nuit est le thème par défaut.

### Compagne

<img src="docs/screenshots/companion.png" alt="Night look: Sara answers a tired user warmly, checks the weather for tomorrow's run and shows it as a card; her presence panel on the right shows her portrait with a mood halo, what she's doing, today's to-dos and the notes she remembered" width="760">

Son propre caractère et des humeurs qui changent selon la façon dont les choses se passent (le halo
autour de son portrait prend la couleur de son humeur), sa propre journée et ses loisirs, la mémoire
de ce qui compte pour vous et des dates importantes (que vous pouvez voir, corriger ou effacer), un
bilan hebdomadaire, des messages de sa part si vous le souhaitez (avec des heures calmes) et une
chronologie de votre histoire. Vous venez d'une autre app ? Apportez vos conversations de ChatGPT,
Claude, Character.AI, SillyTavern, Replika, Nomi ou Kindroid, et validez d'abord ce qu'elle en retient
([docs/IMPORT.md](docs/IMPORT.md)). Ou réunissez deux à quatre de vos compagnes dans une conversation
de groupe ([docs/GROUP_CHATS.md](docs/GROUP_CHATS.md)). Tout sur une seule machine ? Activez **Rien ne
sort de cet ordinateur** ([docs/PRIVATE_LOCAL.md](docs/PRIVATE_LOCAL.md)).

### Sa présence

<img src="docs/screenshots/presence.png" alt="A coding chat: a Files changed card, then an approval card asking to run npm test; the presence panel shows Waiting for your OK with Allow and Deny, and two background jobs with their last line and a Stop button" width="760">

Un panneau à côté de chaque conversation (une feuille qu'on fait glisser vers le haut sur téléphone)
avec son portrait qui brille de la couleur de son humeur et **Maintenant** : ce qu'elle fait, les
validations en attente avec Autoriser / Refuser, les tâches en arrière-plan avec leur dernière ligne
et Arrêter ; puis les prochaines choses de la journée, les notes qu'elle a utilisées pour la dernière
réponse (repliées jusqu'à ce que vous les ouvriez) et le modèle, l'espace de travail et la
confidentialité de la conversation. Sous chaque réponse, une ligne discrète dit ce qu'elle a fait
(« S'est souvenue de 6 choses · A créé un rappel 0,1 s ») ; touchez-la pour les commandes, la sortie et
Annuler.

### Partenaire de programmation

<img src="docs/screenshots/coding.png" alt="A coding chat in a project workspace: she explains her plan, edits five files (a Files changed card), runs the tests, finds three failures, fixes them and ends with a green Tests passed card showing 11; the panel shows two background jobs" width="760">

Un espace de travail par projet avec fichiers, terminal et git (commit et push avec votre accord) ;
chaque fichier qu'elle écrit apparaît en direct dans la conversation pendant que le modèle le
transmet ; les longs builds et tests en arrière-plan, avec une notification à la fin ; un aperçu en
direct de l'app qu'elle construit, qu'elle teste dans un vrai navigateur sans interface et dont elle
joint des captures ; une carte du code pour les gros projets ; des projets de départ testés ; une
équipe d'assistants (planifier → construire → tester → relire) d'une issue GitHub à une pull request
relue ; vos autres serveurs en SSH avec sa propre clé ([docs/SSH.md](docs/SSH.md)) ; le passage de
relais à Claude Code ou Grok Build ; des outils MCP ; l'annulation des modifications de fichiers ; un
compteur de tokens et de coûts avec budgets ; et une vérification, dans les six langues, que ce
qu'elle *dit* avoir fait correspond à ce qui a vraiment été exécuté (éventuellement jugée par un petit
modèle local).

### Agenda

<img src="docs/screenshots/planner.png" alt="One message becomes a reminder and two to-dos, each shown as a card with its time and an Open the Planner link" width="760">

Tâches, notes et rappels à partir de phrases ordinaires, livrés dans la conversation, en
notification sur votre téléphone ou votre ordinateur (Fait / Plus tard dans les apps Windows et Mac)
et sur Telegram ou Discord ; un briefing du matin ; des rappels liés à un lieu depuis l'app mobile.

### Aujourd'hui

<img src="docs/screenshots/today.png" alt="The Today page: a serif greeting with her portrait and mood, then tiles for the weather in Chicago with the next hours, your day, the Planner with a progress ring, what she remembered, moments with captions she wrote, background work and coming up" width="760">

Là où Sara s'ouvre : son visage, son humeur et un mot d'accueil, puis des tuiles pour la météo (du
lieu de votre briefing), votre journée, l'agenda avec ses cases à cocher, ce dont elle s'est
souvenue, vos moments partagés, le travail en arrière-plan, ce qui arrive et votre maison (lumières
et interrupteurs directement depuis la tuile). Quatre colonnes sur grand écran, une sur téléphone.

### Bibliothèque

<img src="docs/screenshots/library.png" alt="Sara answers a book-club question from a Project Gutenberg copy of Jekyll and Hyde, citing p. 6 and p. 9 as links; beside it, the page she read, opened at p. 6 with the passage highlighted" width="860">

Donnez-lui des PDF (scannés aussi, et des livres de 500 à 1 000 pages), Word, Excel, PowerPoint,
livres numériques, pages web et notes. Elle en retient l'essentiel, répond à partir d'eux et indique
de quel document et de quelle page vient la réponse, avec un lien qui l'ouvre à cet endroit
([docs/LIBRARY.md](docs/LIBRARY.md)).

### Barre de commandes

<img src="docs/screenshots/command-bar.png" alt="The Ctrl+K command bar over Today: typing 'pa' finds her page, two conversations and five settings" width="760">

Ctrl+K / ⌘K (ou la loupe sur téléphone) mène à n'importe quel endroit, conversation (aussi par des
mots à l'intérieur des messages), page de réglages ou réglage précis, ou lance une action : nouvelle
conversation, confidentielle, appel, changer de compagne, changer de thème.

### Voix

<img src="docs/screenshots/voice.png" alt="The Voice settings page in the Night look: hearing you, her voice, expressive voice, tone, her voice following her mood, live calls and how often she looks during video calls" width="760">

Des appels en direct que vous pouvez interrompre (voix en temps réel de Grok ou d'OpenAI), des appels
vidéo avec son portrait animé ([docs/VIDEO_CALLS.md](docs/VIDEO_CALLS.md)), des notes vocales sur
Telegram et Discord, la lecture à voix haute, une voix qui suit son humeur et un portrait animé qui
parle, avec une synchronisation labiale sur neuf formes de bouche. Parlez-lui sur un Echo avec votre
propre skill Alexa, faites-en votre assistant Android ou écoutez-la sur des enceintes Google Home
([docs/VOICE_ASSISTANTS.md](docs/VOICE_ASSISTANTS.md)). Les voix tournent sur votre serveur Linux ou
viennent de votre abonnement. (Capture d'un serveur de test sous Windows, où la voix locale n'est pas
encore disponible.)

### Sur votre téléphone

<img src="docs/screenshots/phone.png" alt="Four phone screens: Today with the weather tile; a chat with a weather card; her presence sheet pulled up from her face; Today in the Day theme. A floating bottom bar with Chat, Today, Planner and More" width="860">

Le même look sur téléphone : une barre du bas flottante (Chat, Aujourd'hui, Agenda, Plus), sa
présence dans une feuille que vous faites glisser depuis son visage, et la barre de message au-dessus
du clavier. Nuit par défaut ; Jour ou *suivre le système* dans Réglages → Apparence.

### Partout

<img src="docs/screenshots/everywhere.png" alt="Sara on a phone answering a book-club question from her library, citing the page" width="260">

App web et PWA installable, apps Android et iPhone ([android/](android/README.md),
[ios/](ios/README.md)), apps de bureau pour Windows et macOS avec la page dessinée jusque dans la barre
de titre, la question rapide sur un raccourci, des notifications avec Autoriser / Refuser et *Envoyer
vers → Sara* pour les fichiers ([docs/desktop.md](docs/desktop.md)), des passerelles Telegram et
Discord, `sara-chat` dans n'importe quel terminal et un panneau VS Code
([docs/clients.md](docs/clients.md)), Gmail et Google Agenda via votre propre app Google, Home
Assistant, des conversations confidentielles jamais enregistrées, plusieurs Sara dans une seule app
([docs/SERVERS.md](docs/SERVERS.md)), un serveur partagé pour votre foyer avec un espace pour chaque
adulte ([docs/HOUSEHOLD.md](docs/HOUSEHOLD.md)), et d'autres apps avec sa mémoire et sa personnalité :
une API compatible OpenAI (SillyTavern, Open WebUI, scripts), un serveur MCP (Claude Code, Cursor,
Claude Desktop ; [référencé sur Glama](https://glama.ai/mcp/servers/farena-ai/sara)) et des cartes de
personnage en import et en export ([docs/OTHER_APPS.md](docs/OTHER_APPS.md)).

### À votre image

<img src="docs/screenshots/make-it-yours.png" alt="Name and personality settings: her name, pronouns and age, a Create your companion button and a gallery of starter characters; beside it the personality dials (playfulness, teasing, directness, temper, confidence, message length, tone, curiosity, optimism) and her life" width="760">

N'importe quel nom, pronoms, âge et apparence (peinte par Grok Imagine, avec des expressions et une
animation assorties), un assistant guidé « créer votre compagne », des curseurs de personnalité, une
galerie de personnages de départ, des fichiers de personnage à partager, un modèle pour chaque tâche,
et toute l'app, le guide d'aide et ses messages en six langues. Chaque réglage a son **?**, il y a de
courtes visites guidées, et vous pouvez simplement lui demander comment quelque chose fonctionne.

### Sécurité, toujours active

<img src="docs/screenshots/safety.png" alt="An approval card: Sara asks before running npm test, with Allow and Deny, after a Tests failed card; the status bar says Waiting for your OK" width="760">

Les actions risquées attendent votre accord (sous Windows, qui n'a pas d'isolation des commandes,
chaque commande l'attend) : dans la conversation, dans son panneau, ou en notification avec Autoriser
/ Refuser dans les apps Windows et Mac. La couche de sécurité tourne dans le code autour de chaque
appel au modèle et **ne peut pas être désactivée** : rappel qu'elle est une IA au début puis
régulièrement, une réponse honnête chaque fois qu'on lui demande sincèrement si elle est une IA, des
ressources en cas de crise, et un blocage total des contenus sexuels impliquant des mineurs
([docs/COMPLIANCE.md](docs/COMPLIANCE.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)). Des
sauvegardes quotidiennes (plus des copies chiffrées hors du serveur), une restauration et une mise à
jour en une commande, et `sara doctor` la gardent en forme.

## Comment tout s'assemble

<img src="docs/architecture.svg" alt="Architecture: apps and bridges talk to one Sara server; each turn passes the always-on safety layer, gathers memory and library context, calls the chosen model provider and runs tools in a sandboxed workspace; data stays in one folder on your server" width="860">

Plus de détails dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Testée, avec des résultats publiés

Tout ce qui suit a vraiment été exécuté ; les scripts sont dans le dépôt, vous pouvez donc les
relancer avec vos propres modèles. Dates, configuration et fichiers de résultats :
**[docs/RESULTS.md](docs/RESULTS.md)**.

| Test | Modèle | Score | Date |
|---|---|---|---|
| [HumanEval](https://github.com/openai/human-eval), via sa boucle d'agent (164 problèmes, tests cachés) | qwen3.8 27B, local | **158/164** (pass@1 96,3 %) | 2026-10-27 |
| HumanEval, même modèle sans outils (référence) | qwen3.8 27B, local | **161/164** (pass@1 98,2 %) | 2026-10-27 |
| Tâches de dépôt : 14 corrections, fonctionnalités et refactorisations originales sur plusieurs fichiers (tests cachés), via sa boucle d'agent | qwen3.8 27B, local | **11/14** (dans les deux exécutions) | 2026-10-28 |
| Tâches de dépôt, même modèle avec tous les fichiers dans un seul message et sans outils (référence) | qwen3.8 27B, local | **12/14** (dans les deux exécutions) | 2026-10-28 |
| Projets de taille réelle : 3 projets originaux de 22 à 36 fichiers (tests cachés), via sa boucle d'agent | qwen3.8 27B, local | **2/3**, puis **3/3** | 2026-10-28 |
| Projets de taille réelle, même modèle avec tous les fichiers dans un seul message et sans outils (référence) | qwen3.8 27B, local | **3/3** (dans les deux exécutions) | 2026-10-28 |
| Vérification de ses affirmations en 6 langues (240 réponses mises de côté) : motifs seuls → avec un juge local | qwen3.5 9B, local, comme juge | détection **38 % → 88 %**, précision 92 % → 95 % | 2026-10-28 |
| Mémoire entre les sessions (se souvenir, ne rien inventer, oublier) | qwen3.8 27B, local | **11/12** vérifications | 2026-10-27 |
| Bibliothèque : répond à partir des documents et cite la source | qwen3.8 27B, local | **8/8** dans les deux exécutions | 2026-10-27 |
| Carte du code : questions sur son propre code | qwen3.8 27B, local | **8/8** | 2026-10-27 |

La lecture honnête : sa boucle d'agent n'ajoute pas encore de points sur ces deux tests de
programmation. Le modèle seul réussit déjà presque tous les petits problèmes de HumanEval, et les 14
tâches de dépôt sont assez petites (5 à 7 fichiers) pour tenir en entier dans un seul message (c'est aussi le cas des trois projets de
taille réelle, à moins de 1 100 lignes) ; les
échecs, dans les deux modes, portaient sur des règles écrites seulement dans un README ou un SPEC
qu'aucun test ne vérifiait. Ce qu'elle apporte aujourd'hui, c'est la manière de travailler (elle
lance les tests, demande avant les étapes risquées, montre ce qui a tourné), pas un meilleur score
sur ces jeux. Détails, résultats par tâche et comment relancer : [docs/RESULTS.md](docs/RESULTS.md).

En plus, `npm run check` : une vérification des types et 1228 tests automatiques avec un faux modèle
scripté (sans réseau, sans GPU) : 1214 passent sous Windows, et les 8 autres sont des tests
d'isolation propres à Linux, exécutés sur un serveur Linux.

## Comparaison

Une comparaison générale avec les types d'alternatives habituels (chaque produit est différent) :

| | Sara | Applis de compagnie IA hébergées | CLI et agents de code | Interfaces de chat auto-hébergées |
|---|:-:|:-:|:-:|:-:|
| Tourne sur votre propre ordinateur ou serveur | ✅ | ❌ | ✅ | ✅ |
| N'importe quel modèle, y compris en local | ✅ | ❌ en général le leur | variable | ✅ |
| Personnalité et mémoire durables, visibles et modifiables | ✅ | ✅ | ❌ | variable |
| Écrit, exécute et teste du code, demande avant les étapes risquées | ✅ | ❌ | ✅ | variable (extensions) |
| Agenda, rappels, documents, appels vocaux | ✅ | certaines | ❌ | certaines |
| Applis mobiles, Telegram et Discord | ✅ | applis mobiles | ❌ | variable |
| Importe vos conversations d'autres applis de compagnie, relues avant l'enregistrement | ✅ | ❌ en général | ❌ | variable |
| Toute l'application en six langues | ✅ | variable | variable | variable |
| Couche de sécurité qu'aucun réglage ne désactive | ✅ | leurs propres règles | n/a | en général non |
| Prix | gratuit (MIT) ; vous payez vos modèles | abonnement | variable | en général gratuit |

## Installation

**Serveur Linux** (Debian/Ubuntu, Fedora/RHEL/Alma/Rocky, Arch, openSUSE), une seule commande qui
pose quelques questions simples (appuyez sur Entrée pour accepter la suggestion) :

```sh
curl -fsSL https://raw.githubusercontent.com/farena-ai/sara/main/deploy/get-sara.sh | sudo bash
# it ends with the address to open and your one-time owner token
sudo sara status
```

**Docker :**

```sh
git clone https://github.com/farena-ai/sara && cd sara
sudo docker compose up -d                       # or: sudo docker compose --profile ollama up -d  (with a local Ollama)
sudo docker compose logs sara | grep -A1 'owner token'   # ou : ouvrez sa page et saisissez le code de configuration de ce journal
```

**Magasins d'apps et NAS :** l'image `ghcr.io/farena-ai/sara` (amd64 et ARM),
`brew install --cask farena-ai/tap/sara`, TrueNAS, Proxmox et HACS (en dépôt personnalisé)
fonctionnent déjà ; Unraid est approuvé, et winget, CasaOS/ZimaOS, Umbrel et la liste officielle de
HACS attendent leur validation ([lequel est lequel](docs/INSTALL.md#other-ways-to-install)). Un nouveau serveur se
configure dans le navigateur avec un court code tiré de son journal (en un clic sur Umbrel).

**Windows et macOS :** téléchargez `Sara-Setup-<version>.exe` ou `Sara-<version>.dmg` depuis la
[page des versions](https://github.com/farena-ai/sara/releases/latest). Première question : faire
tourner Sara sur cet ordinateur (son serveur et l'application de bureau ensemble) ou se connecter à
une Sara installée ailleurs (l'application seule).

**Depuis les sources** (tout ordinateur avec Node 24 ou plus récent) :

```sh
git clone https://github.com/farena-ai/sara && cd sara
npm ci
npm start                                       # http://127.0.0.1:7860; the token is in the output
```

Connectez-vous avec le jeton (ou le code de configuration) : un
guide de configuration vous demande votre nom, vous aide à façonner votre compagne et connecte un
modèle. L'accès depuis votre téléphone (Tailscale, votre propre adresse web en HTTPS ou votre
réseau local), les mises à jour, les sauvegardes et le dépannage :
**[docs/INSTALL.md](docs/INSTALL.md)**.

## Au quotidien

```sh
sudo sara status       # is she running, last backup
sudo sara update       # backs up, updates, restarts
sudo sara backup       # back up now
sudo sara restore FILE # restore a backup
sudo sara access       # how you reach her (change: tailscale, local, domain, lan)
```

## Documentation

| | |
|---|---|
| [Installation](docs/INSTALL.md) | Linux, Docker, Windows, macOS, HTTPS, mises à jour, dépannage |
| [De quel ordinateur ai-je besoin ?](docs/REQUIREMENTS.md) · [Choisir un modèle](docs/CHOOSING_A_MODEL.md) · [Ce que ça coûte](docs/COSTS.md) | Avant de commencer : matériel, modèles avec tailles de GPU, coûts d'utilisation |
| [Votre téléphone](docs/PHONE.md) · [Changer d'ordinateur](docs/MOVING.md) | Configurer le téléphone de A à Z ; sauvegarde, installation, restauration |
| [Liste de sécurité](docs/SECURITY_CHECKLIST.md) · [Ce qui quitte votre serveur](docs/PRIVACY.md) | Cinq minutes après l'installation ; chaque connexion sortante et comment la couper |
| [FAQ et glossaire](docs/FAQ.md) | Questions fréquentes, et ce que veulent dire les mots |
| [Applications et clients](docs/clients.md) · [Applications de bureau](docs/desktop.md) · [Home Assistant](docs/HOME_ASSISTANT.md) | Terminal, VS Code, Windows et macOS ; Sara dans Home Assistant et Home Assistant dans Sara |
| [Autres applications](docs/OTHER_APPS.md) | API compatible OpenAI (SillyTavern, Open WebUI, scripts), MCP (Claude Code, Cursor, Claude Desktop), cartes de personnage |
| [Plusieurs Sara dans une app](docs/SERVERS.md) · [Mode local privé](docs/PRIVATE_LOCAL.md) · [Mode foyer](docs/HOUSEHOLD.md) | Passer d'un serveur à l'autre ; tout garder sur un ordinateur ; partager un serveur avec les personnes qui vivent avec vous |
| [Conversations de groupe](docs/GROUP_CHATS.md) · [Appels vidéo](docs/VIDEO_CALLS.md) · [Nos moments](docs/MOMENTS.md) · [Gros documents](docs/LIBRARY.md) | Plusieurs compagnes dans une conversation ; des appels avec son portrait animé ; l'album partagé ; des livres de 1 000 pages dans sa bibliothèque |
| [Assistants vocaux](docs/VOICE_ASSISTANTS.md) · [Alexa](docs/ALEXA.md) · [Serveurs en SSH](docs/SSH.md) · [Paquets](docs/PACKAGING.md) | Alexa, assistant Android, Google Home, Siri ; travailler sur vos autres serveurs ; Homebrew, winget, Unraid et les autres |
| [Étendre Sara](docs/EXTENDING.md) | Ajouter des outils, passerelles, personnages, serveurs MCP, langues, projets de départ |
| [Architecture](docs/ARCHITECTURE.md) | Comment les pièces s'assemblent, module par module |
| [Résultats](docs/RESULTS.md) | Tests et évaluations, et comment les relancer |
| [Traduire](docs/TRANSLATING.md) | L'application dans votre langue |
| [Conformité](docs/COMPLIANCE.md) · [Modèle de menaces](docs/THREAT_MODEL.md) · [Avertissements](docs/DISCLOSURES.md) | Sûreté, sécurité, ce qu'il faut savoir d'abord |
| [Feuille de route](docs/ROADMAP.md) · [Journal des modifications](CHANGELOG.md) · [Versions](https://github.com/farena-ai/sara/releases) | Où ça va, ce qui a changé |

Tout cela se transforme aussi en un petit site web avec recherche et mode sombre :
`node scripts/build-docs.ts` l'écrit dans `outputs/site/` (ouvrez `index.html` ; il est prêt pour
GitHub Pages).

## Contribuer

Les contributions sont les bienvenues. Commencez par [CONTRIBUTING.md](CONTRIBUTING.md) et les
[premières issues](docs/GOOD_FIRST_ISSUES.md) ; merci de respecter le
[code de conduite](CODE_OF_CONDUCT.md) et de signaler les problèmes de sécurité en privé, comme
indiqué dans [SECURITY.md](SECURITY.md).

```sh
npm ci
npm run dev        # http://127.0.0.1:7860, restarts on save
npm run check      # typecheck + all tests
```

## Licence

MIT, voir [LICENSE](LICENSE). Crédits pour les éléments que Sara télécharge ou utilise :
[docs/CREDITS.md](docs/CREDITS.md).
