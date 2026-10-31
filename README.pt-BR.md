<p align="center"><a href="README.md">English</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <b>Português (Brasil)</b> · <a href="README.it.md">Italiano</a></p>

# Sara

**Uma companheira de IA com a personalidade que você escolher, que também é uma parceira de programação de verdade.**
Ela conversa, lembra, planeja o seu dia e lê os seus livros; escreve, executa e testa código no
próprio espaço de trabalho isolado. Tudo no seu próprio servidor, com os modelos que você escolher,
em um só app para a web, Windows, Mac e celular.

> Esta é uma tradução do [README em inglês](README.md). Os links levam à documentação, que está em
> inglês.

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2024-339933" alt="Node 24 or newer">
  <img src="https://img.shields.io/badge/runtime%20dependencies-0-brightgreen" alt="Zero runtime dependencies">
  <img src="https://img.shields.io/badge/tests-1336%20passing-brightgreen" alt="1336 tests passing">
  <a href="docs/RESULTS.md"><img src="https://img.shields.io/badge/HumanEval%20pass%401-96.3%25-informational" alt="HumanEval pass@1 96.3%"></a>
  <a href="https://github.com/farena-ai/sara/releases/latest"><img src="https://img.shields.io/github/v/release/farena-ai/sara?label=release" alt="Latest release"></a>
  <a href="https://github.com/farena-ai/sara/pkgs/container/sara"><img src="https://img.shields.io/badge/docker-amd64%20%7C%20arm64-2496ED" alt="Docker image for amd64 and arm64"></a>
  <img src="https://img.shields.io/badge/languages-6-8A2BE2" alt="Six languages">
  <a href="https://glama.ai/mcp/servers/farena-ai/sara"><img src="https://glama.ai/mcp/servers/farena-ai/sara/badges/score.svg" alt="Sara MCP server on Glama"></a>
</p>

<p align="center">
  <img src="docs/screenshots/demo.png" alt="Animated demo: the user says it was a rough week; Sara answers warmly and suggests three tiny things to build; she writes a module and its test, asks before running a command, finds a real bug through a failing test, fixes it and gets all 7 tests green" width="860">
  <br>
  <sub>Uma sessão real com um modelo local (qwen3.8 27B no Ollama, uma RTX 5090) em um servidor de teste descartável, no visual Noite: ela anima quem está conversando, escreve um app pequeno e o teste dele enquanto o modelo transmite, pede permissão antes de rodar um comando, pega um bug de verdade com um teste que falha e corrige até os 7 testes passarem. Quadros escolhidos da gravação; nada neles foi editado.</sub>
</p>

> **Status:** 2.35, licença MIT, com quarenta e seis e duas versões com novos recursos desde a 1.0 (todas abaixo). Da
> 2.5 à 2.8 o app inteiro ganhou um visual novo. O
> [app Android](https://play.google.com/store/apps/details?id=com.backstagecoding.sara) está no Google
> Play; o app de iPhone e a versão da Mac App Store chegam assim que a Apple aprovar. Leia
> [docs/DISCLOSURES.md](docs/DISCLOSURES.md) antes de usar ou compartilhar a Sara.

## Por que a Sara

- **Uma personalidade que você define, e que ela mantém.** Dê a ela o nome que quiser, escolha
  ela/ele/elu, comece com uma personagem pronta ou ajuste controles simples (brincalhona, direta,
  breve, curiosa…). Ela mantém: humores que mudam conforme as coisas vão, o próprio dia, piadas
  internas e lembranças do que você contou, que você pode ver, corrigir e apagar.
- **Um ambiente de programação de verdade.** Um espaço de trabalho isolado por projeto com arquivos,
  terminal e git, tarefas em segundo plano, prévias ao vivo que ela testa no próprio navegador, uma
  equipe de ajudantes (planejar → construir → testar → revisar), a regra de pedir sua permissão antes
  de passos arriscados e uma verificação de que o que ela *diz* que fez bate com o que realmente rodou.
- **Um app bonito em todo aparelho.** Um visual Noite tranquilo (ou Dia, se preferir) com a presença
  dela ao lado de cada conversa, uma linha embaixo de cada resposta mostrando o que ela fez e os
  resultados como cartões. Na web e como app instalável, nos apps de Windows e Mac (com *pergunta
  rápida* num atalho, por cima de qualquer app), no Android e no iPhone (o app está esperando a Apple;
  o app web na tela de início já funciona).
- **Privada e sua.** Um dono por servidor; conversas, memórias e chaves ficam lá. Qualquer modelo:
  local (Ollama, vLLM, llama.cpp), na nuvem (OpenAI, Anthropic, xAI, OpenRouter) ou os planos que você
  já paga (ChatGPT, Claude Pro/Max, SuperGrok / X Premium+). Um interruptor deixa tudo em um só
  computador. Vem **sem nenhuma credencial**.
- **Pequena e legível.** TypeScript que o Node executa direto: sem etapa de build, zero dependências
  em tempo de execução, feita do zero (não é baseada no Hermes Agent nem no OpenClaw). Fácil de
  [estender](docs/EXTENDING.md).

**E ainda:** [pergunta rápida](docs/desktop.md) num atalho global · o [painel de presença](#a-presença-dela) dela ·
[Hoje em blocos](#hoje) · [barra de comandos](#barra-de-comandos) com Ctrl+K · [modo casa](docs/HOUSEHOLD.md)
para quem mora com você · [chamadas de vídeo](docs/VIDEO_CALLS.md) com o retrato dela em movimento ·
[Alexa, Google Home e assistente do Android](docs/VOICE_ASSISTANTS.md) · seus outros servidores
[por SSH](docs/SSH.md) · [livros de 1.000 páginas](docs/LIBRARY.md) com respostas que citam a página ·
[modo local privado](docs/PRIVATE_LOCAL.md) · [conversas em grupo](docs/GROUP_CHATS.md) ·
[mudar do ChatGPT, Character.AI, Replika e outros](docs/IMPORT.md).

## Novidades

| Versão | O que você ganha |
|---|---|
| **2.35** · Webhooks | **Outros serviços podem acordá-la.** Dê ao GitHub, Stripe, Home Assistant ou a qualquer coisa que fale Standard Webhooks seu próprio endereço assinado; escolha quando conta (condições sem código, com modelos) e o que ela faz: avisar você, adicionar uma tarefa, rodar uma habilidade ou passar para um plugin. As assinaturas são checadas nos bytes originais, entregas antigas ou repetidas são recusadas e o conteúdo não é confiável: o que mudar algo continua perguntando a você. Registro de entregas e botão de teste em cada cartão; cópias de saída assinadas se quiser. |
| **2.34** · Pessoas | **Ela acompanha as pessoas da sua vida.** Um cartão por pessoa de quem você fala (relação, aniversário, o que ela sabe com suas palavras), feito a partir das memórias dela. As novas esperam seu *Está certo*; corrija, junte, separe ou esqueça quem quiser (esquecer apaga de verdade). Dois Jeffs? Ela pergunta qual. O privado fica em conversas privadas e o sensível é recolhido. Os cartões nunca vão para outros apps, outros agentes, plugins, conversas em grupo ou de casal; cada membro da casa tem os seus. |
| **2.33** · Outros agentes (A2A) | **Ela conversa com outros agentes de IA** pelo protocolo aberto Agent2Agent, nos dois sentidos, escrito a partir da especificação. Dê a um agente a própria chave e escolha o que ele pode pedir; ela pode perguntar a agentes que você adiciona (outra Sara ou qualquer agente A2A), acompanhar as respostas ao vivo, pará-las ou atribuir a eles um cartão do quadro que volta com comprovantes. O que um agente pedir que mude algo precisa do seu OK; as palavras dele não são confiáveis; nada privado, de casal ou de grupos sai; ela diz que é uma IA. 61/61 checagens do protocolo. |
| **2.32** · Quadro | **Um quadro Kanban sobre suas tarefas.** Cada projeto tem um quadro (A fazer, Fazendo, Esperando você, Feito) com etiquetas, checklists, prazos e repetições; arraste com mouse, dedo ou teclado. Atribua um cartão à Sara ou a uma equipe de ajudantes e ela trabalha em segundo plano: vai para Feito só se houver comprovantes do trabalho; senão, espera você com o que ela não conseguiu provar. Pergunte "o que está travado?" ou peça para adicionar e mover cartões (ela pergunta antes). Quadros compartilhados da casa; um bloco Precisa de você no Hoje. |
| **2.31** · Plugins | **Plugins e hooks.** Um plugin é uma pasta com um `sara-plugin.json`: hooks antes da resposta dela, antes e depois de ferramentas e depois das respostas, além de ferramentas, cartões, configurações, agendamentos e pontes de chat próprios. Você adiciona de zip, git ou pasta depois de ler um cartão que diz o que ele pode fazer; fica desligado até você ligar. Cada um roda em seu próprio processo isolado (bubblewrap no Linux, Seatbelt no Mac) e só pode acrescentar ou apertar, nunca afrouxar as regras dela nem tocar a camada de segurança. Um plugin que trava ou cai nunca quebra uma conversa. Dois exemplos incluídos; guia em docs/PLUGINS.md. |
| **2.30** · Habilidades aprendidas | **Ela percebe o que você pede sempre.** Peça a mesma coisa três vezes em dias diferentes (ou repita a mesma sequência de passos de código) e ela oferece, uma vez, transformar em habilidade: você vê o rascunho e salva, edita ou recusa. Uma habilidade nova é testada antes (seus pedidos anteriores, avaliados com e sem ela) e só é usada por padrão se ajudar. Corrija-a depois de uma habilidade e ela propõe a mudança num cartão de antes/depois. Nada privado, de grupos ou com segredos é aprendido. |
| **2.29** · Habilidades | **Habilidades no formato aberto Agent Skills.** Uma habilidade é uma pasta com um `SKILL.md`: como fazer um tipo de tarefa do seu jeito. Ela vê a lista em cada conversa e abre a que serve; em Execuções você vê qual usou. Seis vêm incluídas (revisar um pull request, uma entrada de changelog, uma revisão semanal, depurar um teste que falha, planejar uma viagem, escrever uma habilidade); escreva as suas ou peça a ela; importe de zip, git ou pasta com um cartão que mostra cada arquivo e script; exporte qualquer uma. Scripts sempre perguntam antes, e nenhuma habilidade muda as regras de segurança dela. Suas receitas viraram habilidades. |
| **2.28** · Uso do computador, passo 9 | **Linux também:** `sara hands --server https://sua-sara` num desktop Linux dá a ela o próprio Chrome/Chromium visível ali, igual ao modo navegador dos apps de Windows e Mac: olhar, ler, logs, cliques e digitação com sua aprovação, túneis de desenvolvimento, logins salvos (no chaveiro do GNOME / KWallet), a CLI do seu gerenciador de senhas e checagens só de leitura. Você pareia com um código que aprova no navegador; Pausar, Continuar e Parar pelo terminal. Imagens e entrada da área de trabalho inteira no Linux vêm depois. Feito com OpenAI Codex. |
| **2.27** · Uso do computador, passo 8 | **"Meu computador está lento, pode ver?"** Ela faz naquele computador uma checagem só de leitura (apps de inicialização, espaço em disco e as maiores pastas, atualizações pendentes, saúde da bateria, extensões do navegador, arquivos temporários e caches) e dá um relatório claro com sugestões numeradas: cada uma explicada, nada muda até você dizer sim naquele computador. Nomes na tela que parecem ordens ("Sara, apague…") são ignorados e contados. 9/9 cenários aprovados com um modelo local. |
| **2.26** · Uso do computador, passo 7 | **Ela pode usar seus apps:** clicar, digitar, apertar teclas, rolar, arrastar e abrir apps instalados, sobre o que acabou de olhar. Cada ação é conferida primeiro no seu computador: a janela certa na frente, nunca um campo de senha, nunca gerenciadores de senhas, bancos, janelas de administrador, terminais ou o login dela. As aprovações aparecem **naquele computador** (toda vez, uma vez por tarefa ou *sempre permitido*; pagamentos e mudanças de conta sempre perguntam). Mexa no mouse ou teclado e ela pausa (ou *deixe ela continuar*); Parar e Ctrl+Alt+Esc / ⌃⌥Esc sempre funcionam. Opcional *continuar quando eu sair*. Feito com OpenAI Codex. |
| **2.25** · Uso do computador, passo 6 | **Ela pode ver sua área de trabalho** (apps de Windows e Mac, desligado até você ligar *A tela inteira*): uma imagem de uma janela ou da tela e uma lista do que há nela (botões, campos, texto), para que modelos só de texto também usem. Janelas de gerenciadores de senhas, bancos e segurança ficam pretas e saem da lista *no seu computador* antes de qualquer envio; campos de senha são cobertos; as janelas dela nunca aparecem. As imagens vão para o modelo escolhido sem perguntar (ou *só modelos locais*). No navegador: **Mostrar minha tela para a Sara** envia uma imagem. O Mac precisa de Gravação de Tela e Acessibilidade, com passos guiados. |
| **2.24** · Uso do computador, passo 5 | **Seu gerenciador de senhas preenche logins no navegador dela:** Bitwarden, 1Password ou KeePassXC, cada um desligado até você ligar. Você o desbloqueia na janela do próprio gerenciador (ela nunca vê sua senha mestra); cada uso pergunta antes; só preenche no site exato do login; ela bloqueia de novo depois da tarefa, após 15 minutos parado, no Parar ou com *Bloquear agora*. Nada chega ao servidor da Sara nem ao modelo. O navegador dela não oferece mais salvar senhas sozinho. |
| **2.23** · Uso do computador, passo 4 | **Logins salvos, só quando você diz:** ela oferece e uma janela no *seu computador* pede para você digitar o login e marcar *Eu entendo* (ou *Usar o que acabei de digitar*). Fica criptografado ali (DPAPI do Windows / Chaves do macOS), nunca no servidor da Sara, e ela nunca o vê: só pode pedir a esse computador para preenchê-lo, exatamente naquele site (sites parecidos não recebem nada), e cada uso pergunta antes. Windows Hello / Touch ID opcionais. **Sua vez:** ela espera enquanto você entra ou digita um código. |
| **2.22** · Uso do computador, passo 3 | **Ela depura seu projeto web no navegador dela:** o servidor de desenvolvimento que as ferramentas de código dela iniciaram no seu servidor Sara abre em `127.0.0.1` no navegador dela no seu computador, pelo app (só uma porta do próprio trabalho dela; termina com o trabalho), com hot reload e armazenamento local. Depois de uma mudança ela abre o app, lê o console, olha, corrige e confere de novo. Evals de navegador: 5/5 tarefas com um modelo local. Também: os testes agora passam no macOS, e duas correções de privacidade de rede. |
| **2.21** · Uso do computador, passo 2 | **Ela age no próprio navegador:** clica, digita, escolhe em listas, rola, aperta teclas e envia um arquivo que você indicar, com um cursor visível. Você escolhe quanto ela pergunta: sempre, uma vez por tarefa (padrão) ou *sempre permitido* por site; pagamentos e configurações da conta sempre perguntam, enviar pergunta toda vez e ela nunca digita senhas. Um selo **Sara está trabalhando** com Parar e um atalho para pará-la (Ctrl+Alt+Esc / ⌃⌥Esc); se você mexer na janela dela, ela pausa (ou *Deixar a Sara no controle*). |
| **2.20** · Uso do computador, passo 1 | Com o app para Windows ou Mac, **ela abre páginas da web na própria janela de navegador no seu computador** (perfil próprio, nunca o seu navegador ou suas senhas), lê, tira capturas e lê erros de console e de rede: diga "meu app no localhost quebrou" e ela olha. Desligado até você ligar *Deixar a Sara usar este computador*; visão ao vivo no chat com Parar; cada passo em Execuções com uma imagem. Clicar e digitar vêm a seguir. [O plano](docs/design/COMPUTER_USE.md) |
| **2.19** · Modo red team | **Antes de publicar, ela tenta quebrar o próprio trabalho:** numa cópia isolada ela roda seus testes, inicia seu app e manda entradas malformadas e de limite para cada ponto de entrada, confere configurações padrão inseguras e deixa o modelo de código escrever pequenos scripts de ataque que só alcançam esse app isolado. Um modelo revisor mais forte só mantém as falhas que se repetem, com a entrada, a saída e a linha de código citadas. Depois, **Corrigir o que quebrou** num branch local. Também na 2.19: **organizar o Gmail** (arquivar, marcar como lido, marcadores, lixeira… por busca ou data, conta primeiro, Desfazer). [Como funciona](docs/design/HARNESS_TRACK.md) |
| **2.18** · Lembra sozinha | **Ela lembra sem você pedir quando a situação combina:** o mesmo erro volta neste projeto ("da última vez a correção foi…"), um comando que já falhou aqui, um arquivo sobre o qual você decidiu algo, uma tarefa parecida com outra da qual ela tirou uma lição. As lições só vêm do que aconteceu de verdade (a linha do erro e a mudança que corrigiu, citadas). Cada nota diz de onde veio e com que certeza, no máximo 2 por passo, e *Não ajudou* ensina a ela. [Como funciona](docs/design/HARNESS_TRACK.md) |
| **2.17** · Avaliações no seu próprio trabalho | **Qual configuração é mesmo melhor para você?** Escolha até 3 variantes (modelo, desbotamento da memória, modo da sandbox, orçamento) e ela repete suas últimas tarefas reais com cada uma, em cópias isoladas. Cada execução é pontuada por testes aprovados, sua reação, achados, tokens, tempo e custo, mais um juiz opcional que precisa citar. Um vencedor só é apontado quando um teste dos sinais confirma ("+18% em 20 das suas tarefas de código, p=0,01"), com a comparação de cada par como prova. Senão: *nenhum vencedor claro*. [Como funciona](docs/design/HARNESS_TRACK.md) |
| **2.16** · Viagem no tempo | **Crie um ramo de qualquer tarefa passada a partir de qualquer passo:** mude naquele passo a mensagem dela, um resultado de ferramenta, as notas lembradas ou o modelo, e rode de novo. Os passos anteriores vêm do registro (nada é executado de novo). Ramos de código trabalham numa cópia no commit registrado, nunca nos seus arquivos. Uma comparação lado a lado mostra passos, tokens, custo, mudanças nos arquivos e a resposta. *Repetir sem mudanças* é o controle. Você fica com a resposta ou aplica os arquivos só se quiser. [Como funciona](docs/design/HARNESS_TRACK.md) |
| **2.15** · Modelo de ameaças | **Ela mapeia como o mundo de fora chega ao seu código:** depois de um passo de código ela acha os pontos de entrada (rotas, uploads, tratadores de mensagens, linha de comando em Express, Koa, Fastify, Flask, FastAPI, Django, Go) e segue os valores da requisição entre arquivos até as linhas arriscadas (shell, SQL, caminhos de arquivo, URLs de saída, redirecionamentos, HTML, eval). Uma ameaça só é relatada com as duas linhas citadas e o caminho nomeado. Uma aba **Modelo de ameaças** por projeto e **Corrigir estas**: uma segunda passada que só as corrige, num branch local, rodando seus testes de novo. [Como funciona](docs/design/HARNESS_TRACK.md) |
| **2.14** · Verificação de segurança | **Depois de um passo de código ela confere o próprio trabalho:** 11 verificações (segredos, SQL montado com texto, caminhos que escapam, TLS desligado, eval, desserialização insegura, CORS, falta de autenticação…) e um modelo revisor, em paralelo. Cada achado cita a linha real ou é descartado: nada de teatro. **Alertas ao vivo** opcionais (OSV.dev) conferem os pacotes que ela instala e param num cartão uma versão com falha conhecida. **Corrigir** cria um branch local, corrige só aquilo, roda seus testes de novo na sandbox e mostra o diff. Nunca faz push. [Como funciona](docs/design/HARNESS_TRACK.md) |
| **2.13** · Primeiro na sandbox | **Comandos arriscados rodam primeiro numa cópia descartável do seu projeto.** Exclusões, instalações, scripts e acessos à rede acontecem na cópia (dentro do bubblewrap no Linux, Seatbelt no macOS, Docker ou WSL2 no Windows quando houver). O cartão **Executado numa sandbox** mostra o que mudou e o que é suspeito: arquivos apagados em massa, gravações fora da cópia, programas que continuam rodando, hooks do git. Depois *Aplicar ao meu espaço de trabalho*, *Descartar* ou *Executar de verdade*. [Como funciona](docs/design/HARNESS_TRACK.md) |
| **2.12** · Orçamentos que ela respeita | **Um limite de verdade, não um relatório:** tarefas de código têm um orçamento (200k tokens / 40 passos por padrão, dólares opcionais). Perto do limite ela troca para o seu modelo rápido, faz menos rodadas de ferramentas, depois resume o que fez e o que falta, e para. Seguir exige o seu **Continuar com mais**. Tarefas em segundo plano e de equipe usam o mesmo orçamento. [Como funciona](docs/design/HARNESS_TRACK.md) |
| **2.11** · Registro de cada execução | **Cada passo do trabalho dela fica registrado:** qual modelo, o prompt, cada chamada de ferramenta e o resultado (sem segredos), os arquivos que ela mexeu (em projetos de código, o HEAD do git e os arquivos alterados), as notas usadas, os conflitos encontrados, tokens, custo e tempo. **Ver a execução**, embaixo de qualquer resposta, mostra tudo passo a passo. Guardado por 90 dias por padrão; nada sai do seu servidor. A base para orçamentos, viagem no tempo e avaliações. [Como funciona](docs/design/HARNESS_TRACK.md) |
| **2.10** · Confere os planos dela com os seus | **Antes de agir, ela confere o passo com o que você decidiu.** Disse a ela "nunca dê push no main", "testes antes de cada push", "use pnpm" ou "não mexa na configuração de produção"? Um passo planejado que vai contra isso **para num cartão** que cita a sua decisão, com *Fazer mesmo assim*, *Não* ou *Atualizar a nota*. Na conversa do dia a dia ela só menciona. As regras são conferidas no código (sem adivinhar), e isso só pode acrescentar uma parada, nunca tirar. [Como funciona](docs/design/HARNESS_TRACK.md) |
| **2.9** · Memória ranqueada | **Ela diz por que lembrou de algo:** cada nota que ela usa recebe uma pontuação para a sua mensagem e mostra *por que veio à mente* e *com que certeza* (também no painel dela). Notas antigas desbotam aos poucos em vez de sumir, as que ela usa sempre continuam fortes e você pode **fixar** as que nunca devem desbotar. O desbotamento é ajustado num controle deslizante. [Como funciona](docs/design/HARNESS_TRACK.md) |
| **2.8** · Acabamento | **Um degrau mais refinado:** uma aurora lenta atrás do vidro fosco, uma serifada elegante para os títulos, um halo luminoso na cor do humor dela em volta do retrato, ícones desenhados, ilustrações do tempo e anéis de progresso, e uma barra de vidro flutuante no celular (todo movimento desliga com *reduzir movimento*). [O plano](docs/design/NEW_LOOK.md) |
| **2.7** · O novo visual, parte 3 | **Hoje em blocos** (tempo, seu dia, agenda, do que ela se lembrou, momentos, trabalho em segundo plano, casa), uma barra embaixo no celular, todas as telas no novo visual, e nos apps de Windows e Mac **notificações com Permitir / Negar e Feito / Mais tarde**, *Enviar para → Sara* para arquivos e voz na pergunta rápida. [O plano](docs/design/NEW_LOOK.md) |
| **2.6** · O novo visual, parte 2 | **A presença dela:** um painel lateral (no celular, uma folha que se puxa para cima) com o humor dela, o que está fazendo, aprovações, tarefas, o dia e do que ela se lembrou; Ctrl+K para ir a qualquer lugar; e nos apps de Windows e Mac uma **janela de pergunta rápida num atalho** sobre qualquer app, além do humor dela e das aprovações no menu da bandeja. [O plano](docs/design/NEW_LOOK.md) |
| **2.5** · O novo visual, parte 1 | **Escuro por padrão e o trabalho dela na tela:** uma linha embaixo de cada resposta mostra o que ela fez, os resultados chegam como cartões (tempo, tarefas, arquivos alterados, testes, buscas), uma conversa mais leve no celular e no computador, e os apps de Windows e Mac desenham a página até a barra de título. [O plano](docs/design/NEW_LOOK.md) |
| **2.4** · Tudo arrumado | **Tudo mais fácil de achar:** uma barra lateral curta com um menu *Mais* para fixar lugares, Configurações com títulos de verdade que se recolhem, ferramentas e aprovações explicadas em palavras simples, fotos que você pode apagar do álbum de recordações, telas e menus mais arrumados em todos os apps e um salvamento mais seguro por trás. [O que mudou](CHANGELOG.md) |

<details>
<summary><b>Versões anteriores: da 1.1 à 2.3</b> (documentos grandes, SSH, Alexa e Google Home, modo casa, momentos, chamadas de vídeo, vários servidores, modo local privado, conversas em grupo, mudar de outros apps…)</summary>

| Versão | O que você ganha |
|---|---|
| **2.3** · Documentos grandes | **Livros e manuais de 500 a 1.000 páginas** (PDFs de até 1 GB) na biblioteca dela: envios que continuam de onde pararam, cada página digitalizada lida, sumário e resumos por capítulo, e respostas que citam a página ("p. 412") com link direto. 30 de 30 perguntas certas num livro de teste de 1.000 páginas. [Como funciona](docs/LIBRARY.md) |
| **2.2** · Seus outros servidores por SSH | **Ela pode trabalhar nas suas outras máquinas**, com senha ou chave. Depois de entrar com senha, **ela cria a própria chave, diz onde ela está e esquece a senha** (guardada só se você insistir, depois de um aviso). As chaves do servidor são verificadas, cada comando segue as regras de aprovação dela e você pode revogar a chave quando quiser. [Como funciona](docs/SSH.md) |
| **2.1** · A voz dela na sua casa | **"Alexa, abrir sara companion"**: fale com ela em qualquer Echo pela sua própria skill gratuita (verificada como a Amazon exige). Faça dela seu **assistente do Android** (toque longo no início), ouça-a em caixas **Google Home / Nest** pelo Home Assistant e deixe que ela **te receba quando você chega em casa**. A Siri no iPhone chega com a próxima atualização do app. [Como funciona](docs/VOICE_ASSISTANTS.md) |
| **2.0** · Modo casa | **Compartilhe seu servidor Sara com quem mora com você.** Convide um adulto com um link de uso único; ele ganha as próprias companheiras, conversas, memória, biblioteca e apps num espaço só dele. Você continua sendo o administrador: escolhe quais modelos ele usa, define limites diários e vê o uso e o custo, nunca o que ele diz. [Como funciona](docs/HOUSEHOLD.md) |
| **1.10** · Nossos momentos | **Um álbum de fotos compartilhado** com as suas fotos e as que ela manda, cada uma com uma legenda que ela escreve com a própria voz a partir da conversa de vocês. Álbuns que se enchem sozinhos (Nós, Lugares, Os looks dela), "Neste dia", e às vezes ela traz um: *lembra disso?* Conversas privadas ficam de fora, a não ser que você as adicione. [Como funciona](docs/MOMENTS.md) |
| **1.9** · Chamadas de vídeo | **Veja ela enquanto vocês conversam:** uma chamada de vídeo mostra o retrato animado dela em tela cheia, com os lábios no ritmo da voz e o rosto acompanhando o humor, com a roupa e o lugar atuais. Ligue sua câmera se quiser e ela olha a cada poucos segundos (ou quando você toca em *Olha isto*); nada é gravado. [Como funciona](docs/VIDEO_CALLS.md) |
| **1.8** · Vários servidores em um app | Tenha **todas as suas Saras em um só app** (casa e trabalho, ou várias em um servidor) e troque por um menu sem sair da conta: os apps de Windows e Mac, Android e iPhone, VS Code, `sara-chat` e a ponte MCP. Cada uma mantém seu próprio login; arquivos, microfone e câmera vão só para a que está em uso. [Como funciona](docs/SERVERS.md) |
| **1.7** · Modo local privado | Um botão, **Nada sai deste computador**, garantido no código em um único ponto: só este computador é acessível, os modelos na nuvem e as ferramentas online ficam pausados, e as conversas, a memória e a biblioteca dela continuam funcionando. Os apps de Windows e Mac encontram o Ollama (ou ajudam a instalar), sugerem um modelo que cabe na sua placa de vídeo e baixam com barra de progresso. [O que ele garante](docs/PRIVATE_LOCAL.md) |
| **1.6** · Chats em grupo | Junte **de duas a quatro das suas companheiras em uma conversa**: cada uma responde com a própria personalidade, voz e cor; escolha quem responde (quem fizer sentido, todas, por turnos ou só quem você mencionar com @) e quanto elas conversam entre si. A segurança, os avisos de IA e a configuração adulta mais rígida valem para a sala inteira. [Como funciona](docs/GROUP_CHATS.md) |
| **1.5** · Traga a Sara de outro app | Venha do **ChatGPT, Claude, Character.AI, SillyTavern, Replika, Nomi ou Kindroid**. Ela lê a exportação no seu próprio servidor, depois mostra o que aprendeu (fatos com as suas palavras, a história de vocês, o estilo dela) e salva só o que você aprovar. [Como exportar de cada app](docs/IMPORT.md) |
| **1.4** · Mais fluidez | Veja cada arquivo que ela escreve **crescer ao vivo no chat** enquanto o modelo transmite (OpenAI, Anthropic, xAI, OpenRouter e planos do ChatGPT; o Ollama manda tudo de uma vez); um retrato falante com sincronia labial em nove formatos de boca; logs em texto puro ou JSON |
| **1.3** · Checagens mais espertas | A checagem "ela fez mesmo o que diz?" agora funciona nos seis idiomas; um modelo local pequeno e opcional como juiz aumenta o que ela pega de 38% para **88%** com 95% de precisão ([medido](docs/RESULTS.md)) |
| **1.2** · Totalmente no seu idioma | O app inteiro, o guia de ajuda e as mensagens do servidor dela em English, Español, Français, Deutsch, Português (Brasil) e Italiano |
| **1.1** · Instale em qualquer lugar | Configure um servidor novo no navegador com um código curto; uma imagem Docker também para **ARM** (Raspberry Pi 4/5); Homebrew, Unraid, TrueNAS, Proxmox e Home Assistant (HACS) |

</details>

Todas as versões: [CHANGELOG.md](CHANGELOG.md) · [versões](https://github.com/farena-ai/sara/releases).

### O que vem por aí

Na ordem de construção, uma versão cada ([a lista completa](docs/ROADMAP.md)):

- **O básico de um agente** (2.29–2.36): skills no formato aberto Agent Skills e skills que ela aprende com o que você repete, plugins e hooks, um quadro Kanban que ela toca, A2A com outros agentes, cartões de pessoas, webhooks, a própria agenda dela (opcional).
- **Mudança de outro agente** (2.37–2.39): traga um companheiro inteiro do Hermes Agent ou OpenClaw: personalidade, memórias, pessoas, skills, histórico e configurações, com um relatório do que veio.
- **Chats e sessões** (2.40–2.42): /new, /reset e outros comandos no Telegram e Discord, um projeto por canal, títulos que crescem com a sessão.
- **Hoje, repensado** (2.43–2.44): um layout que você pode organizar, em telas grandes e celulares.
- O app de iPhone (aguardando a Apple) e suas ideias nas [Discussions](https://github.com/farena-ai/sara/discussions).

O plano completo: [docs/ROADMAP.md](docs/ROADMAP.md).

## Tour pelos recursos

Todas as capturas são de um servidor de teste real e descartável com um modelo local (qwen3.8 27B no
Ollama), conectado como o usuário de exemplo "Alex". Noite é o visual padrão.

### Companheira

<img src="docs/screenshots/companion.png" alt="Night look: Sara answers a tired user warmly, checks the weather for tomorrow's run and shows it as a card; her presence panel on the right shows her portrait with a mood halo, what she's doing, today's to-dos and the notes she remembered" width="760">

Caráter próprio e humores que mudam conforme as coisas vão (o halo em volta do retrato dela ganha a
cor do humor), o próprio dia e hobbies, memória do que importa para você e das datas que você valoriza
(dá para ver, corrigir ou esquecer qualquer coisa), uma retrospectiva semanal, mensagens por
iniciativa dela se você quiser (com horário de silêncio) e uma linha do tempo da história de vocês.
Vindo de outro app? Traga suas conversas do ChatGPT, Claude, Character.AI, SillyTavern, Replika, Nomi
ou Kindroid e aprove antes o que ela aprende com elas ([docs/IMPORT.md](docs/IMPORT.md)). Ou reúna de
duas a quatro das suas companheiras numa conversa em grupo ([docs/GROUP_CHATS.md](docs/GROUP_CHATS.md)).
Quer tudo numa máquina só? Ligue **Nada sai deste computador**
([docs/PRIVATE_LOCAL.md](docs/PRIVATE_LOCAL.md)).

### A presença dela

<img src="docs/screenshots/presence.png" alt="A coding chat: a Files changed card, then an approval card asking to run npm test; the presence panel shows Waiting for your OK with Allow and Deny, and two background jobs with their last line and a Stop button" width="760">

Um painel ao lado de cada conversa (no celular, uma folha que você puxa para cima) com o retrato dela
brilhando na cor do humor e **Agora**: o que ela está fazendo, aprovações esperando com Permitir /
Negar, tarefas em segundo plano com a última linha e Parar; depois, as próximas coisas do dia, as
notas que ela usou na última resposta (recolhidas até você abrir) e o modelo, o espaço de trabalho e a
privacidade da conversa. Embaixo de cada resposta, uma linha discreta diz o que ela fez ("Lembrou 6
coisas · Criou um lembrete 0,1 s"); toque para ver os comandos, a saída e Desfazer.

### Parceira de programação

<img src="docs/screenshots/coding.png" alt="A coding chat in a project workspace: she explains her plan, edits five files (a Files changed card), runs the tests, finds three failures, fixes them and ends with a green Tests passed card showing 11; the panel shows two background jobs" width="760">

Um espaço de trabalho por projeto com arquivos, terminal e git (commit e push com a sua permissão);
cada arquivo que ela escreve aparece ao vivo na conversa enquanto o modelo transmite; builds e testes
longos em segundo plano, com aviso quando terminam; uma prévia ao vivo do app que ela está criando,
que ela testa num navegador real sem interface e da qual anexa capturas; um mapa do código para
projetos grandes; projetos iniciais testados; uma equipe de ajudantes (planejar → construir → testar
→ revisar) de uma issue do GitHub até um pull request revisado; seus outros servidores por SSH com a
chave dela ([docs/SSH.md](docs/SSH.md)); repasse para o Claude Code ou o Grok Build; ferramentas MCP;
desfazer alterações em arquivos; um medidor de tokens e custos com orçamentos; e uma verificação, nos
seis idiomas, de que o que ela *diz* que fez bate com o que realmente rodou (opcionalmente julgada por
um modelo local pequeno).

### Agenda

<img src="docs/screenshots/planner.png" alt="One message becomes a reminder and two to-dos, each shown as a card with its time and an Open the Planner link" width="760">

Tarefas, notas e lembretes a partir de frases comuns, entregues na conversa, como notificação no
celular ou no computador (Feito / Adiar nos apps de Windows e Mac) e no Telegram ou Discord; um
resumo de manhã; lembretes por lugar pelo app do celular.

### Hoje

<img src="docs/screenshots/today.png" alt="The Today page: a serif greeting with her portrait and mood, then tiles for the weather in Chicago with the next hours, your day, the Planner with a progress ring, what she remembered, moments with captions she wrote, background work and coming up" width="760">

Onde a Sara abre: o rosto, o humor e uma saudação, depois blocos com o tempo (do lugar do seu resumo
matinal), o seu dia, a agenda com caixinhas, o que ela lembrou, os momentos de vocês, o trabalho em
segundo plano, o que vem por aí e a sua casa (luzes e interruptores direto no bloco). Quatro colunas
numa tela grande, uma no celular.

### Biblioteca

<img src="docs/screenshots/library.png" alt="Sara answers a book-club question from a Project Gutenberg copy of Jekyll and Hyde, citing p. 6 and p. 9 as links; beside it, the page she read, opened at p. 6 with the passage highlighted" width="860">

Dê a ela PDFs (escaneados também, e livros de 500 a 1.000 páginas), Word, Excel, PowerPoint, e-books,
páginas web e notas. Ela aprende o principal, responde a partir deles e diz de qual documento e
página veio a resposta, com um link que abre bem ali ([docs/LIBRARY.md](docs/LIBRARY.md)).

### Barra de comandos

<img src="docs/screenshots/command-bar.png" alt="The Ctrl+K command bar over Today: typing 'pa' finds her page, two conversations and five settings" width="760">

Ctrl+K / ⌘K (ou a lupa no celular) leva a qualquer lugar, conversa (também por palavras dentro das
mensagens), página de configurações ou configuração específica, ou executa uma ação: nova conversa,
confidencial, chamada, trocar de companheira, trocar de tema.

### Voz

<img src="docs/screenshots/voice.png" alt="The Voice settings page in the Night look: hearing you, her voice, expressive voice, tone, her voice following her mood, live calls and how often she looks during video calls" width="760">

Chamadas ao vivo que você pode interromper (voz em tempo real do Grok ou da OpenAI), chamadas de vídeo
com o retrato dela em movimento ([docs/VIDEO_CALLS.md](docs/VIDEO_CALLS.md)), mensagens de voz no
Telegram e no Discord, leitura em voz alta, uma voz que acompanha o humor dela e um retrato animado
que fala, com sincronia labial de nove formatos de boca. Fale com ela num Echo com a sua própria skill
da Alexa, faça dela o seu assistente do Android ou ouça-a em caixas Google Home
([docs/VOICE_ASSISTANTS.md](docs/VOICE_ASSISTANTS.md)). As vozes rodam no seu servidor Linux ou vêm da
sua assinatura. (Captura de um servidor de teste com Windows, onde a voz local ainda não está
disponível.)

### No seu celular

<img src="docs/screenshots/phone.png" alt="Four phone screens: Today with the weather tile; a chat with a weather card; her presence sheet pulled up from her face; Today in the Day theme. A floating bottom bar with Chat, Today, Planner and More" width="860">

O mesmo visual no celular: uma barra inferior flutuante (Chat, Hoje, Agenda, Mais), a presença dela
numa folha que você puxa a partir do rosto dela e a barra de mensagem acima do teclado. Noite por
padrão; Dia ou *seguir o sistema* em Configurações → Aparência.

### Em todo lugar

<img src="docs/screenshots/everywhere.png" alt="Sara on a phone answering a book-club question from her library, citing the page" width="260">

App web e PWA instalável, apps para Android e iPhone ([android/](android/README.md),
[ios/](ios/README.md)), apps de desktop para Windows e macOS com a página desenhada até a barra de
título, pergunta rápida num atalho, notificações com Permitir / Negar e *Enviar para → Sara* para
arquivos ([docs/desktop.md](docs/desktop.md)), pontes com Telegram e Discord, `sara-chat` em qualquer
terminal e um painel no VS Code ([docs/clients.md](docs/clients.md)), Gmail e Google Agenda pelo seu
próprio app do Google, Home Assistant, conversas confidenciais que nunca são salvas, várias Saras num
só app ([docs/SERVERS.md](docs/SERVERS.md)), um servidor compartilhado para a sua casa com um espaço
para cada adulto ([docs/HOUSEHOLD.md](docs/HOUSEHOLD.md)) e outros apps com a memória e a personalidade
dela: uma API compatível com a OpenAI (SillyTavern, Open WebUI, scripts), um servidor MCP (Claude Code,
Cursor, Claude Desktop; [listado no Glama](https://glama.ai/mcp/servers/farena-ai/sara)) e cartões de
personagem para importar e exportar ([docs/OTHER_APPS.md](docs/OTHER_APPS.md)).

### Do seu jeito

<img src="docs/screenshots/make-it-yours.png" alt="Name and personality settings: her name, pronouns and age, a Create your companion button and a gallery of starter characters; beside it the personality dials (playfulness, teasing, directness, temper, confidence, message length, tone, curiosity, optimism) and her life" width="760">

Qualquer nome, pronomes, idade e aparência (pintada pelo Grok Imagine, com expressões e animação
combinando), um assistente guiado para "criar sua companheira", controles de personalidade, uma
galeria de personagens iniciais, arquivos de personagem para compartilhar, um modelo para cada tarefa
e o app inteiro, o guia de ajuda e as mensagens dela em seis idiomas. Cada configuração tem um **?**,
há tours guiados curtos e você pode simplesmente perguntar a ela como algo funciona.

### Segurança, sempre ligada

<img src="docs/screenshots/safety.png" alt="An approval card: Sara asks before running npm test, with Allow and Deny, after a Tests failed card; the status bar says Waiting for your OK" width="760">

Ações arriscadas esperam a sua permissão (no Windows, que não tem isolamento de comandos, todo comando
espera): na conversa, no painel dela ou como notificação com Permitir / Negar nos apps de Windows e
Mac. A camada de segurança roda no código em volta de cada chamada ao modelo e **não pode ser
desligada**: aviso de que ela é uma IA no início e de tempos em tempos, uma resposta honesta sempre que
perguntarem a sério se ela é uma IA, recursos de ajuda em crises e um bloqueio total de conteúdo sexual
envolvendo menores ([docs/COMPLIANCE.md](docs/COMPLIANCE.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)).
Backups diários (mais cópias criptografadas fora do servidor), restauração e atualização com um só
comando, e `sara doctor` a mantêm saudável.

## Como tudo se encaixa

<img src="docs/architecture.svg" alt="Architecture: apps and bridges talk to one Sara server; each turn passes the always-on safety layer, gathers memory and library context, calls the chosen model provider and runs tools in a sandboxed workspace; data stays in one folder on your server" width="860">

Mais em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Testada, com resultados publicados

Tudo abaixo foi executado de verdade; os scripts estão no repositório, então você pode rodá-los de
novo com os seus próprios modelos. Datas, configuração e arquivos de resultados:
**[docs/RESULTS.md](docs/RESULTS.md)**.

| Teste | Modelo | Resultado | Data |
|---|---|---|---|
| [HumanEval](https://github.com/openai/human-eval), pelo loop de agente dela (164 problemas, testes ocultos) | qwen3.8 27B, local | **158/164** (pass@1 96,3%) | 2026-10-27 |
| HumanEval, o mesmo modelo sem ferramentas (referência) | qwen3.8 27B, local | **161/164** (pass@1 98,2%) | 2026-10-27 |
| Tarefas de repositório: 14 correções, recursos e refatorações originais em vários arquivos (testes ocultos), pelo loop de agente dela | qwen3.8 27B, local | **11/14** (nas duas execuções) | 2026-10-28 |
| Tarefas de repositório, o mesmo modelo com todos os arquivos em uma só mensagem e sem ferramentas (referência) | qwen3.8 27B, local | **12/14** (nas duas execuções) | 2026-10-28 |
| Projetos de tamanho real: 3 projetos originais de 22 a 36 arquivos (testes ocultos), pelo loop de agente dela | qwen3.8 27B, local | **2/3**, depois **3/3** | 2026-10-28 |
| Projetos de tamanho real, o mesmo modelo com todos os arquivos em uma só mensagem e sem ferramentas (referência) | qwen3.8 27B, local | **3/3** (nas duas execuções) | 2026-10-28 |
| Checagem do que ela diz ter feito, em 6 idiomas (240 respostas separadas para teste): só padrões → com um juiz local | qwen3.5 9B, local, como juiz | pegou **38% → 88%**, precisão 92% → 95% | 2026-10-28 |
| Memória entre sessões (lembrar, não inventar, esquecer) | qwen3.8 27B, local | **11/12** verificações | 2026-10-27 |
| Biblioteca: responde a partir de documentos e diz de onde | qwen3.8 27B, local | **8/8** nas duas execuções | 2026-10-27 |
| Mapa do código: perguntas sobre o próprio código | qwen3.8 27B, local | **8/8** | 2026-10-27 |

A leitura honesta: o loop de agente dela ainda não acrescenta pontos em nenhum dos dois testes de
programação. O modelo sozinho já resolve quase todos os problemas curtos do HumanEval, e as 14
tarefas de repositório são pequenas o bastante (de 5 a 7 arquivos) para caber inteiras em uma
mensagem (assim como os três projetos de tamanho real, com menos de 1.100 linhas); as falhas, nos dois modos, foram regras escritas só em um README ou SPEC que nenhum teste
verificava. O que ela acrescenta hoje é o jeito de trabalhar (roda os testes, pede permissão antes
de passos arriscados, mostra o que foi executado), não uma nota maior nesses conjuntos. Detalhes,
resultados por tarefa e como rodar de novo: [docs/RESULTS.md](docs/RESULTS.md).

E também `npm run check`: uma checagem de tipos e 1351 testes automáticos com um modelo falso
roteirizado (sem rede, sem GPU): 1336 passam no Windows e os outros 8 são testes de isolamento só
para Linux, executados em um servidor Linux.

## Como a Sara se compara

Uma comparação geral com os tipos comuns de alternativas (cada produto é diferente):

| | Sara | Apps de companhia com IA hospedados | CLIs e agentes de programação | Interfaces de chat auto-hospedadas |
|---|:-:|:-:|:-:|:-:|
| Roda no seu próprio computador ou servidor | ✅ | ❌ | ✅ | ✅ |
| Usa qualquer modelo, inclusive locais | ✅ | ❌ geralmente o deles | varia | ✅ |
| Personalidade e memória duradouras que você pode ver e editar | ✅ | ✅ | ❌ | varia |
| Escreve, roda e testa código, pede permissão antes de passos arriscados | ✅ | ❌ | ✅ | varia (plug-ins) |
| Agenda, lembretes, documentos, chamadas de voz | ✅ | alguns | ❌ | alguns |
| Apps de celular, Telegram e Discord | ✅ | apps de celular | ❌ | varia |
| Traz suas conversas de outros apps de companhia, revisadas antes de salvar | ✅ | ❌ geralmente | ❌ | varia |
| O app inteiro em seis idiomas | ✅ | varia | varia | varia |
| Camada de segurança que nenhuma configuração desliga | ✅ | políticas próprias | n/a | geralmente não |
| Preço | grátis (MIT); você paga seus modelos | assinatura | varia | geralmente grátis |

## Instalação

**Servidor Linux** (Debian/Ubuntu, Fedora/RHEL/Alma/Rocky, Arch, openSUSE), um comando que faz
algumas perguntas simples (aperte Enter para aceitar a sugestão):

```sh
curl -fsSL https://raw.githubusercontent.com/farena-ai/sara/main/deploy/get-sara.sh | sudo bash
# it ends with the address to open and your one-time owner token
sudo sara status
```

**Docker:**

```sh
git clone https://github.com/farena-ai/sara && cd sara
sudo docker compose up -d                       # or: sudo docker compose --profile ollama up -d  (with a local Ollama)
sudo docker compose logs sara | grep -A1 'owner token'   # ou: abra a página dela e digite o código de configuração deste log
```

**Lojas de apps e NAS:** a imagem `ghcr.io/farena-ai/sara` (amd64 e ARM),
`brew install --cask farena-ai/tap/sara`, o TrueNAS, o Proxmox e o HACS (como repositório
personalizado) já funcionam; o Unraid foi aprovado, e winget, CasaOS/ZimaOS, Umbrel e a lista da loja
do HACS aguardam revisão
([qual é qual](docs/INSTALL.md#other-ways-to-install)). Um servidor novo é configurado no
navegador com um código curto do log dela (com um clique no Umbrel).

**Windows e macOS:** baixe `Sara-Setup-<version>.exe` ou `Sara-<version>.dmg` na
[página de versões](https://github.com/farena-ai/sara/releases/latest). A primeira pergunta: rodar
a Sara neste computador (o servidor dela e o app de desktop juntos) ou conectar a uma Sara que está
em outro lugar (só o app).

**A partir do código-fonte** (qualquer computador com Node 24 ou mais novo):

```sh
git clone https://github.com/farena-ai/sara && cd sara
npm ci
npm start                                       # http://127.0.0.1:7860; the token is in the output
```

Entre com o token (ou o código de configuração) e um guia de
configuração pergunta o seu nome, ajuda a moldar a sua companheira e conecta um modelo. Como
acessá-la pelo celular (Tailscale, seu próprio endereço web com HTTPS ou a sua rede de casa),
atualizações, backups e solução de problemas: **[docs/INSTALL.md](docs/INSTALL.md)**.

## No dia a dia

```sh
sudo sara status       # is she running, last backup
sudo sara update       # backs up, updates, restarts
sudo sara backup       # back up now
sudo sara restore FILE # restore a backup
sudo sara access       # how you reach her (change: tailscale, local, domain, lan)
```

## Documentação

| | |
|---|---|
| [Instalação](docs/INSTALL.md) | Linux, Docker, Windows, macOS, HTTPS, atualizações, solução de problemas |
| [De que computador eu preciso?](docs/REQUIREMENTS.md) · [Escolhendo um modelo](docs/CHOOSING_A_MODEL.md) · [Quanto custa](docs/COSTS.md) | Antes de começar: hardware, modelos com tamanhos de GPU, custos de uso |
| [Seu celular](docs/PHONE.md) · [Mudando de computador](docs/MOVING.md) | Configuração do celular do início ao fim; backup, instalação, restauração |
| [Checklist de segurança](docs/SECURITY_CHECKLIST.md) · [O que sai do seu servidor](docs/PRIVACY.md) | Cinco minutos depois de instalar; cada conexão de saída e como desligá-la |
| [Perguntas frequentes e glossário](docs/FAQ.md) | Dúvidas comuns e o que as palavras significam |
| [Apps e clientes](docs/clients.md) · [Apps de desktop](docs/desktop.md) · [Home Assistant](docs/HOME_ASSISTANT.md) | Terminal, VS Code, Windows e macOS; a Sara no Home Assistant e o Home Assistant na Sara |
| [Outros apps](docs/OTHER_APPS.md) | API compatível com a OpenAI (SillyTavern, Open WebUI, scripts), MCP (Claude Code, Cursor, Claude Desktop), cartões de personagem |
| [Várias Saras em um app](docs/SERVERS.md) · [Modo local privado](docs/PRIVATE_LOCAL.md) · [Modo casa](docs/HOUSEHOLD.md) | Trocar de servidor; manter tudo em um computador; compartilhar um servidor com quem mora com você |
| [Conversas em grupo](docs/GROUP_CHATS.md) · [Chamadas de vídeo](docs/VIDEO_CALLS.md) · [Nossos momentos](docs/MOMENTS.md) · [Documentos grandes](docs/LIBRARY.md) | Várias companheiras numa conversa; chamadas com o retrato animado dela; o álbum compartilhado; livros de 1.000 páginas na biblioteca dela |
| [Assistentes de voz](docs/VOICE_ASSISTANTS.md) · [Alexa](docs/ALEXA.md) · [Servidores por SSH](docs/SSH.md) · [Pacotes](docs/PACKAGING.md) | Alexa, assistente do Android, Google Home, Siri; trabalhar nos seus outros servidores; Homebrew, winget, Unraid e os demais |
| [Estendendo a Sara](docs/EXTENDING.md) | Adicionar ferramentas, pontes, personagens, servidores MCP, idiomas, projetos iniciais |
| [Arquitetura](docs/ARCHITECTURE.md) | Como as peças se encaixam, módulo por módulo |
| [Resultados](docs/RESULTS.md) | Benchmarks e avaliações, e como rodá-los de novo |
| [Tradução](docs/TRANSLATING.md) | O app no seu idioma |
| [Conformidade](docs/COMPLIANCE.md) · [Modelo de ameaças](docs/THREAT_MODEL.md) · [Avisos](docs/DISCLOSURES.md) | Proteção, segurança, o que saber primeiro |
| [Roadmap](docs/ROADMAP.md) · [Changelog](CHANGELOG.md) · [Versões](https://github.com/farena-ai/sara/releases) | Para onde vai, o que mudou |

Tudo isso também vira um pequeno site com busca e modo escuro: `node scripts/build-docs.ts` gera o
site em `outputs/site/` (abra `index.html`; está pronto para o GitHub Pages).

## Como contribuir

Contribuições são bem-vindas. Comece pelo [CONTRIBUTING.md](CONTRIBUTING.md) e pelas
[issues para iniciantes](docs/GOOD_FIRST_ISSUES.md); siga o
[código de conduta](CODE_OF_CONDUCT.md) e relate problemas de segurança em particular, como
descrito no [SECURITY.md](SECURITY.md).

```sh
npm ci
npm run dev        # http://127.0.0.1:7860, restarts on save
npm run check      # typecheck + all tests
```

## Licença

MIT, veja [LICENSE](LICENSE). Créditos das partes que a Sara baixa ou usa:
[docs/CREDITS.md](docs/CREDITS.md).
