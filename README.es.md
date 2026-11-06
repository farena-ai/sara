<p align="center"><a href="README.md">English</a> · <b>Español</b> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português (Brasil)</a> · <a href="README.it.md">Italiano</a></p>

<p align="center">
  <img src="docs/images/brand/sara-hero.webp" alt="Sara: una mujer ilustrada de pelo castaño rojizo ondulado, pecas y un jersey color crema sonríe junto a su sello pintado y las palabras en inglés Your companion. Your coding partner. Your server. (Tu compañera. Tu socia de programación. Tu servidor.)" width="100%">
</p>

<p align="center"><b>Sara es una compañera de IA que alojas tú, con una personalidad a tu medida y una memoria que tú controlas, y un entorno de programación de verdad que pide permiso antes de los pasos arriesgados y muestra lo que realmente se ejecutó.</b></p>

<p align="center">
  <a href="https://github.com/farena-ai/sara/releases/latest"><img src="https://img.shields.io/badge/Descargar-B4436C?style=for-the-badge" alt="Descargar"></a>
  <a href="docs/INSTALL.md"><img src="https://img.shields.io/badge/Gu%C3%ADa%20de%20instalaci%C3%B3n-315C66?style=for-the-badge" alt="Guía de instalación"></a>
  <a href="https://github.com/farena-ai/sara"><img src="https://img.shields.io/badge/%E2%98%85%20Estrella%20en%20GitHub-8A6422?style=for-the-badge" alt="★ Estrella en GitHub"></a>
</p>

<p align="center">
  <a href="docs/INSTALL.md">Windows · macOS · Linux · Docker</a> ·
  <a href="LICENSE">MIT</a> ·
  <a href="https://github.com/farena-ai/sara/releases/latest"><img src="https://img.shields.io/github/v/release/farena-ai/sara?label=release" alt="Latest release"></a>
  <br>
  <sub>Gratis y de código abierto · En tu servidor · Usa tus propios modelos. Sara es gratis; tu equipo, el alojamiento y los proveedores de modelos opcionales pueden tener un coste. <a href="docs/COSTS.md">Qué cuesta</a>.</sub>
</p>

**Actualizar:** en un servidor Linux, `sudo sara update` (antes hace una copia de seguridad y vuelve atrás si ella no responde) · Docker: `sudo git pull && sudo docker compose up -d --build` · apps de Windows y Mac: Ajustes → Datos y salud → Actualizaciones · Android: Google Play. [Cómo actualizar](docs/INSTALL.md#upgrading).

> **Estado:** 2.75.0, [Las llamadas como el chat](https://github.com/farena-ai/sara/releases/tag/v2.75.0). En una llamada tiene los mismos recuerdos, contexto y herramientas que en el chat, y pregunta antes de lo que necesita tu permiso. [Ver novedades](#novedades)
>
> Instalador Windows: sin firma ([guía de SmartScreen](docs/INSTALL.md)). El proceso de publicación de macOS exige descargas firmadas y notarizadas; cada compilación se verifica por separado. Android: [Google Play](https://play.google.com/store/apps/details?id=com.backstagecoding.sara). iPhone: [app web en la pantalla de inicio](docs/PHONE.md).

<p align="center">
  <a href="docs/START_HERE.md"><img src="https://img.shields.io/badge/Lo%20acabo%20de%20instalar%2C%20%C2%BFy%20ahora%20qu%C3%A9%3F-B4436C?style=for-the-badge" alt="Lo acabo de instalar, ¿y ahora qué?" height="34"></a>
  <a href="docs/FOR_CODERS.md"><img src="https://img.shields.io/badge/Vengo%20a%20programar-6E4BD8?style=for-the-badge" alt="Vengo a programar" height="34"></a>
</p>

Sara es una IA. Lee los [avisos](docs/DISCLOSURES.md) antes de usarla o compartirla. El modo local mantiene las llamadas al modelo en tu ordenador; las funciones en la nube envían datos a los proveedores que elijas ([privacidad](docs/PRIVACY.md)).

**¿Vienes con un equipo?** Usa la [instalación empresarial independiente](docs/BUSINESS_OPERATIONS.md): claves de acceso individuales, roles explícitos y espacios compartidos. Es una instalación manual con su propia carpeta de datos; los instaladores personales no convierten tu compañera ni tu hogar.

> Esta es una traducción del [README en inglés](README.md). Los enlaces llevan a la documentación,
> que está en inglés.

## Lo que hace Sara

<p align="center">
  <img src="docs/screenshots/demo.png" alt="Animated demo: the user says it was a rough week; Sara answers warmly and suggests three tiny things to build; she writes a module and its test, asks before running a command, finds a real bug through a failing test, fixes it and gets all 7 tests green" width="860">
  <br>
  <sub>Una sesión real con un modelo local (qwen3.8 27B en Ollama, una RTX 5090) en un servidor de pruebas desechable, con el aspecto Noche: anima a quien le habla, escribe una pequeña app y su prueba mientras el modelo las transmite, pide permiso antes de ejecutar un comando, detecta un error real con una prueba que falla y lo corrige hasta que pasan las 7 pruebas. Fotogramas elegidos de la grabación; nada en ellos se ha editado.</sub>
</p>

Una línea por área; cada enlace lleva a su guía. Con capturas: **[Recorrido por las funciones](docs/FEATURES.md)**.

### Para hacerte compañía

<img src="docs/images/brand/sara-for-company.webp" alt="Ilustración: Sara en un sofá con una taza de té, una agenda y su móvil al lado, bajo la luz cálida de una lámpara" width="860">

| Área | Lo que obtienes |
|---|---|
| **Compañera** | Cualquier nombre, ella/él/elle y un aspecto, una personalidad a partir de diales sencillos o de un personaje inicial, estados de ánimo, su propio día, bromas recurrentes y recuerdos de lo que le contaste, que puedes ver, corregir y olvidar. [Empieza aquí](docs/START_HERE.md) · [Personas](docs/PEOPLE.md) · [Momentos](docs/MOMENTS.md) |
| **Voz y llamadas** | Llamadas en directo que puedes interrumpir, videollamadas con su retrato en movimiento, «Hey Sara» sin manos en la app de Windows, y Alexa, Google Home o tu asistente de Android. [Videollamadas](docs/VIDEO_CALLS.md) · [Hey Sara](docs/HEY_SARA.md) · [Asistentes de voz](docs/VOICE_ASSISTANTS.md) |
| **Agenda, rutinas y vigilancia** | Tareas, notas y recordatorios a partir de frases normales, un tablero, Hoy como pantalla de inicio, una galería de rutinas (resumen matinal, repaso semanal…), recordatorios para cuando salga una persona o un tema, y avisos opcionales cuando un registro muestra una línea como ERROR. [Hoy](docs/TODAY.md) · [Rutinas](docs/ROUTINES.md) · [Tablero](docs/BOARD.md) · [Vigilar un archivo](docs/WATCHES.md) |
| **Biblioteca y lectura** | PDF (también escaneados, y libros de 500 a 1.000 páginas), Word, Excel, PowerPoint, libros electrónicos, páginas web y notas; las respuestas dicen de qué documento y página salen. [Biblioteca](docs/LIBRARY.md) |
| **Escenas y rol** | Una escena de rol compartida entre tus propios chats web, de Telegram y de Discord más una sala compartida, con hechos del canon que añades, editas o retiras; chats de grupo con dos a cuatro compañeras; paquetes de compañeras y tarjetas de personaje. [Escenas compartidas](docs/SCENES.md) · [Chats de grupo](docs/GROUP_CHATS.md) · [Paquetes de compañeras](docs/PACKS.md) |

### Para programar

<img src="docs/images/brand/sara-for-coding.webp" alt="Ilustración: Sara en un escritorio con un portátil y un café, sonriendo a su trabajo bajo un flexo" width="860">

| Área | Lo que obtienes |
|---|---|
| **Proyectos de código** | Un espacio de trabajo aislado por proyecto con archivos, terminal y git; escribe el código, pregunta antes de ejecutar un comando y muestra los resultados de las pruebas como tarjetas; vistas previas en vivo que prueba en su propio navegador. Los comandos arriesgados pueden ejecutarse antes en una copia aislada. [Para programadores](docs/FOR_CODERS.md) |
| **Trabajo que se demuestra** | Una línea bajo cada respuesta muestra cada comando y su salida, y una comprobación compara lo que *dice* que hizo con lo que realmente se ejecutó. Los objetivos solo terminan cuando pasa tu propia comprobación, sus cambios pasan por el comprobador de tipos, las afirmaciones visuales necesitan una captura y las comprobaciones desactualizadas se repiten. [Objetivos](docs/GOALS.md) · [Comprobaciones](docs/CHECKS.md) · [Comprobaciones visuales](docs/FOR_CODERS.md#web-pages-look-fix-look-again) |
| **Trabajo largo y compartido** | Tareas en segundo plano, un equipo de ayudantes (planificar → crear → probar → revisar), puntos de control del proyecto, presupuestos que detienen una tarea larga donde tú digas, y tus otros servidores por SSH. [Puntos de control del proyecto](docs/FOR_CODERS.md#project-checkpoints) · [Servidores por SSH](docs/SSH.md) |
| **En tus herramientas** | GitHub, `sara-chat` en cualquier terminal, un panel de VS Code, MCP para Claude Code y Cursor, y una API compatible con OpenAI, todo con su propia memoria y personalidad. [Apps y clientes](docs/clients.md) · [Otras apps](docs/OTHER_APPS.md) |

### Para las dos cosas

<img src="docs/images/brand/sara-everywhere.webp" alt="Ilustración: Sara camina por una calle de la ciudad al atardecer, sonriendo al móvil con una tableta bajo el brazo" width="860">

| Área | Lo que obtienes |
|---|---|
| **Apps en todas las plataformas** | App web y PWA instalable, apps de Windows y Mac con pregunta rápida en un atajo, [Android en Google Play](https://play.google.com/store/apps/details?id=com.backstagecoding.sara), la app web en la pantalla de inicio del iPhone, Telegram, Discord, Signal y correo, y WhatsApp, Matrix e iMessage como plugins opcionales. [Apps de escritorio](docs/desktop.md) · [Tu móvil](docs/PHONE.md) · [Comandos de chat](docs/CHATS.md) |
| **Complementos** | Plugins, habilidades y servidores de herramientas (MCP) de la Sara Store firmada o de tu propia carpeta; cada uno pasa por una tarjeta de revisión y sigue desactivado hasta que lo enciendes. [Sara Store](docs/STORE.md) · [Biblioteca de complementos](docs/ADDONS_LIBRARY.md) · [Habilidades](docs/SKILLS.md) |
| **Hogar y empresa** | El modo hogar da a cada adulto con quien vives su propio espacio en tu servidor; los espacios empresariales son una instalación aparte con claves de acceso, roles y espacios compartidos. [Modo hogar](docs/HOUSEHOLD.md) · [Empresa](docs/BUSINESS.md) |
| **Privacidad, modelos locales y seguridad** | Cualquier modelo: local (Ollama, vLLM, llama.cpp), en la nube (OpenAI, Anthropic, xAI, OpenRouter) o los planes que ya pagas (ChatGPT, Claude Pro/Max, SuperGrok / X Premium+). Un dueño por servidor; los chats, recuerdos y claves se quedan allí. Un interruptor lo deja todo en un solo ordenador; viene **sin credenciales de ningún tipo**; y una capa de seguridad que no se puede desactivar. [Modo local privado](docs/PRIVATE_LOCAL.md) · [Elegir un modelo](docs/CHOOSING_A_MODEL.md) · [Revisión de seguridad](docs/SAFETY_CHECKUP.md) |
| **Ayuda y mudanza** | Un cuadro *¿Cómo hago…?* en cada página, visitas guiadas cortas y la mudanza desde ChatGPT, Claude, Character.AI, SillyTavern, Replika, Nomi, Kindroid, Hermes Agent u OpenClaw, revisada antes de guardar nada. [¿Cómo hago…?](docs/HOW_DO_I.md) · [Tráela desde otra app](docs/IMPORT.md) · [Guía de mudanza](docs/MOVE_IN_GUIDE.md) |

## Empieza aquí

Dos caminos cortos para los primeros diez minutos. Elige el tuyo; todas las funciones siguen disponibles en los dos.

### Lo acabo de instalar, ¿y ahora qué?

<img src="docs/screenshots/first-run.webp" alt="Paso 1 de 4 de la configuración: un cuadro con el nombre Alex y tres tarjetas para lo que harás sobre todo con ella: Compañía, Programación o Ambas cosas" width="560">

1. **Inicia sesión** con el código de configuración de su registro (o con tu token de propietario).
2. **Dile tu nombre** y elige *Compañía* cuando te pregunte qué vais a hacer sobre todo juntos.
3. **Conecta un cerebro:** te sugiere un modelo para tu ordenador y comprueba que responde (*Conectado ✓*), o usa un plan que ya pagas.
4. **Saluda:** toca *Planea mi día conmigo* o simplemente escribe. Tras su primera respuesta llega un recorrido corto.
5. **Hazla tuya** con los diales de personalidad, y deja que *Primeros pasos* en Hoy te guíe por su voz, tu móvil y un resumen matinal.

El recorrido completo, con imágenes: **[Start here](docs/START_HERE.md)**. Todas las respuestas de los cuadros *¿Cómo hago…?* de la app en una lista: **[How do I…?](docs/HOW_DO_I.md)** (en inglés).

### Vengo a programar

<img src="docs/screenshots/connect-brain.webp" alt="Paso 3 de 4, Conecta un cerebro: cuatro tarjetas (En este ordenador, Otro ordenador en casa, En la nube, Mi suscripción) y una tarjeta Elegido para ti con el modelo local qwen3.8 27B, la etiqueta Bueno para programar y Conectado" width="560">

1. **Elige *Programación*** en la configuración: te sugiere un modelo bueno para el código (*Bueno para programar*) o tu plan de Claude Code, Codex o Grok Build.
2. **Abre un proyecto** con *+ Proyecto*: una carpeta de trabajo donde tiene archivos, una terminal y git.
3. **Pídele algo de verdad.** Escribe los archivos, pregunta antes de ejecutar un comando y muestra los resultados de las pruebas como tarjetas.
4. **Lee la línea bajo cada respuesta** para ver cada comando y su salida; los comandos arriesgados pueden ejecutarse antes en una copia aislada.
5. **Llévala a tus herramientas:** GitHub, `sara-chat`, VS Code, MCP para Claude Code y Cursor, y presupuestos que detienen una tarea larga donde tú digas.

El recorrido para programadores: **[For coders](docs/FOR_CODERS.md)** (en inglés). Desde el código fuente en tres comandos: [Instalación](#instalación).

## Vídeos de cómo se hace

Guías de un minuto, grabadas en un servidor de prueba con un modelo local (en inglés). <a href="https://www.youtube.com/playlist?list=PLGtrs9BqXtM8">Todos en una lista</a>.

<table>
  <tr>
    <td align="center" width="25%"><a href="https://www.youtube.com/watch?v=DTAIW75y7i4&list=PLGtrs9BqXtM8&index=1"><img src="https://i.ytimg.com/vi/DTAIW75y7i4/mqdefault.jpg" alt="Instalar Sara" width="200"></a><br><sub>Instalar Sara</sub></td>
    <td align="center" width="25%"><a href="https://www.youtube.com/watch?v=_X69x9E3W_k&list=PLGtrs9BqXtM8&index=2"><img src="https://i.ytimg.com/vi/_X69x9E3W_k/mqdefault.jpg" alt="Memoria y tarjetas de personas" width="200"></a><br><sub>Memoria y tarjetas de personas</sub></td>
    <td align="center" width="25%"><a href="https://www.youtube.com/watch?v=wrvNcHkc9O4&list=PLGtrs9BqXtM8&index=3"><img src="https://i.ytimg.com/vi/wrvNcHkc9O4/mqdefault.jpg" alt="El tablero" width="200"></a><br><sub>El tablero</sub></td>
    <td align="center" width="25%"><a href="https://www.youtube.com/watch?v=7i48NiAq-jw&list=PLGtrs9BqXtM8&index=4"><img src="https://i.ytimg.com/vi/7i48NiAq-jw/mqdefault.jpg" alt="Programar con Sara" width="200"></a><br><sub>Programar con Sara</sub></td>
  </tr>
</table>

## Novedades

<!-- sara:recent-releases:start -->

Versiones recientes · 6 de noviembre de 2026. [Historial completo](CHANGELOG.md) · [Todas las descargas](https://github.com/farena-ai/sara/releases).

| Versión | Qué cambia para ti |
|---|---|
| **[2.75.0](https://github.com/farena-ai/sara/releases/tag/v2.75.0)** | **[Las llamadas como el chat](docs/VIDEO_CALLS.md#what-she-knows-and-can-do-on-a-call)** — En una llamada de voz o vídeo tiene los mismos recuerdos, contexto de otros chats y regla del modo adulto que al escribir, y las llamadas en directo pueden usar sus herramientas (no comandos, sus manos ni SSH). Lo que necesita tu permiso muestra una tarjeta en la pantalla de la llamada que solo se responde tocando; colgar o hablar encima la cancela. |
| **[2.74.0](https://github.com/farena-ai/sara/releases/tag/v2.74.0)** | **[Leer juntos](docs/LIBRARY.md#read-together)** — Abre un documento de texto o Markdown de tu biblioteca, pulsa Compartir este pasaje (o activa Seguir por dónde voy) y comenta exactamente ese texto en esa versión; si cambió, te lo dice. Detener lo termina al instante. Además: las tarjetas de sugerencias muestran ahora que se está atendiendo tu pulsación. |
| **[2.73.0](https://github.com/farena-ai/sara/releases/tag/v2.73.0)** | **[Vigilar un archivo](docs/WATCHES.md)** — Elige un registro o archivo de uno de tus espacios de trabajo (o su propio registro) y unas palabras como ERROR; Sara envía una tarjeta en el chat y una notificación cuando aparece una línea nueva que coincide, como máximo 12 al día. Comprobar ahora, Pausar y Detener; la lectura no usa ningún modelo y nunca arregla nada por su cuenta. |
| **[2.72.0](https://github.com/farena-ai/sara/releases/tag/v2.72.0)** | **[Comprobaciones visuales honestas](docs/FOR_CODERS.md#web-pages-look-fix-look-again)** — En trabajo web Sara edita, previsualiza, toma capturas de escritorio y móvil, corrige lo que se ve mal y vuelve a comprobar. Afirmar el ancho de móvil exige una captura a ese ancho, y "está arreglado" exige una comprobación tras su última edición; si no, la respuesta se marca sin verificar. |
| **[2.71.0](https://github.com/farena-ai/sara/releases/tag/v2.71.0)** | **[Continuidad de proyectos](docs/FOR_CODERS.md#project-now-other-chats-and-current-checks)** — Tus chats de código del mismo proyecto ven qué hacen los demás (títulos y archivos, nunca el texto de los mensajes), y cada resultado de comprobación, objetivo o punto de control indica vigente, desactualizado o base desconocida. Sara repite una comprobación desactualizada antes de decir que pasa. |
| **[2.70.0](https://github.com/farena-ai/sara/releases/tag/v2.70.0)** | **[Escenas de rol compartidas](docs/SCENES.md)** — Una historia en tus chats web, de Telegram y de Discord más una sala compartida, con hechos versionados que añades, editas o retiras. Los invitados mantienen todas las reglas de pareja; sus palabras solo cuentan cuando eliges Añadir a la escena. Borrar u olvidar una línea elimina lo que salió de ella; las comprobaciones de seguridad se aplican a cada escena. |

<!-- sara:recent-releases:end -->

<details>
<summary><b>Versiones 2.6x anteriores</b>: de la 2.69.0 a la 2.61.5</summary>

| Versión | Qué cambia para ti |
|---|---|
| **[2.69.0](https://github.com/farena-ai/sara/releases/tag/v2.69.0)** | **[Complementos en Ajustes](docs/ADDONS_LIBRARY.md)** — Doce flujos con datos proporcionados usan la revisión habitual de archivos y permisos y empiezan desactivados. Siete vistas previas de recetas MCP, catorce investigaciones bloqueadas y seis guías explican requisitos, costes y límites. Sin instalación, conexión ni activación automáticas; la disponibilidad de la tienda firmada se mantiene separada. |
| **[2.68.0](https://github.com/farena-ai/sara/releases/tag/v2.68.0)** | **[Contexto entre tus propios chats](docs/SESSION_CONTINUITY.md)** — Contexto reciente entre chats permitidos del propietario con la misma compañera, lecturas limitadas del historial, notas internas y turnos ordenados del proveedor. Interruptor del propietario, inspección y borrado confirmado solo del destino elegido; se mantienen la privacidad y las aprobaciones de herramientas. Las escenas compartidas, la coordinación de proyectos y la paridad completa de voz y vídeo quedan para futuras fases. |
| **[2.67.0](https://github.com/farena-ai/sara/releases/tag/v2.67.0)** | **[Señales recientes y seguimientos](docs/ATTUNEMENT.md)** — Señales explícitas y acotadas del propietario en seis idiomas y seguimientos de eventos con fuentes verificadas. Los **[puntos de control del proyecto](docs/FOR_CODERS.md#project-checkpoints)** conservan lógica, bloqueos y hasta tres próximos pasos, con cinco versiones y controles para inspeccionar, reemplazar o borrar; el contexto histórico no ejecuta comandos ni conserva aprobaciones anteriores. |
| **[2.65.0](https://github.com/farena-ai/sara/releases/tag/v2.65.0)** | **[Configuración empresarial guiada](docs/BUSINESS.md)** — Primer uso y administración guiados, historial de invitaciones limitado al ámbito autorizado, revocación, comprobación de configuración de solo lectura y pruebas repetibles de navegador y recuperación. |
| **[2.64.0](https://github.com/farena-ai/sara/releases/tag/v2.64.0)** | **[Espacios empresariales independientes](docs/BUSINESS_OPERATIONS.md)** — Claves de acceso individuales, roles, textos y documentos compartidos, límites de modelos controlados por el operador y recuperación cifrada. Separados de los datos personales y del hogar. |
| **[2.63.1](https://github.com/farena-ai/sara/releases/tag/v2.63.1)** | **[Operación medida](docs/OPERATIONS.md)** — Métricas HTTP y de preparación solo para el propietario, archivo seguro de entregas resueltas, copias de seguridad sin bloquear la app y pruebas locales repetibles. |
| **[2.62.0](https://github.com/farena-ai/sara/releases/tag/v2.62.0)** | **[Recuperación sin repetir a ciegas](docs/RECOVERY.md)** — Revisa los trabajos interrumpidos antes de reiniciarlos; los envíos nativos inciertos de Telegram y Discord siguen visibles y no se reenvían automáticamente. |
| **[2.61.5](https://github.com/farena-ai/sara/releases/tag/v2.61.5)** | **[Encuentra el siguiente paso](docs/START_HERE.md)** — Búsqueda enfocada en Ajustes, un primer mensaje más sencillo y mejor navegación con teclado, táctil y movimiento reducido. |

También en 2.67.0: navegación fiable a Proyectos de programación desde la búsqueda de Ajustes, borradores conservados y gestión de respuestas obsoletas, privacidad del conocimiento del proyecto en modo no registrado y comprobación local de vigencia de las seis páginas de lanzamiento. Sin CI ni vigilancia recurrente de versiones. Los puntos de control son solo del propietario y de su espacio/proyecto; borrar, editar u olvidar el contenido de origen cubierto invalida los registros derivados. Las acciones de programación pendientes, incluidas las de los ayudantes del equipo y la aplicación de cambios del entorno aislado, vuelven a comprobar los permisos actuales y el contexto de la conversación y del espacio de trabajo antes de ejecutarse; un cambio de contexto detiene la acción obsoleta en lugar de trasladarla.

La versión 2.67.0 también distingue las críticas al código del conflicto dirigido a Sara, vuelve a comprobar las fuentes de las señales y los seguimientos justo antes de la llamada normal al proveedor y cierra automáticamente los elementos de Agenda solo con pruebas claras del evento, su resultado y la pregunta correspondiente. Vida interior sigue siendo el control de activación; no hay diagnóstico emocional, llamada adicional a un clasificador ni nuevo perfil de ánimo del propietario. Las nuevas señales excluyen chats privados o sin registro, miembros, grupos, contextos externos, repeticiones y trabajo desatendido. Los prompts registrados, las exportaciones y las copias de seguridad pueden conservar notas con sus controles habituales; la repetición omite los nuevos extras transitorios registrados e indica que las entradas cambiaron. Esta versión también corrige la identificación automática de la revisión de origen del instalador de Windows.

</details>

<!-- sara:release-history:start -->

<details>
<summary><b>Novedades anteriores · 2.61, 2.60 y 2.59</b></summary>

- **2.61** ·  Configurar apps de chat es más fácil: una tarjeta guiada para WhatsApp, Matrix, iMessage, Signal, correo y Telegram, cada paso comprobado y con soluciones claras; los plugins propios de Sara solo necesitan un OK, no un aviso para desarrolladores.
- **2.60** · Paquetes de compañeras: comparte el carácter, el aspecto, la voz y las habilidades de inicio de una compañera como archivo o en la Sara Store, sin compartir nunca tus recuerdos ni tus chats; también se importan tarjetas de personaje.
- **2.59** · «Hey Sara»: di su nombre para hablar sin manos en la app de Windows (un pequeño modelo en tu ordenador solo escucha eso), un atajo para hablar en todas partes, y oído y voces locales en Windows.

</details>

<details>
<summary><b>Historial de versiones</b>: lo que trajo cada versión desde la 2.4</summary>

| Versión | Qué te trae |
|---|---|
| **2.61.4** · [v2.61.4](https://github.com/farena-ai/sara/releases/tag/v2.61.4) | **[Configuración más fiable](docs/SECURITY_CHECKLIST.md)** — Retoma la configuración del modelo tras omitirla, conserva el foco móvil donde corresponde y distingue la aprobación de comandos del aislamiento de ejecución. |
| **2.60** · Paquetes de compañeras | **Compártela:** Ajustes → Ella → ⋯ → *Compartirla* arma un paquete con exactamente lo que marques (su carácter, diales, aspecto, armario, voz, primer mensaje, habilidades, rutinas sugeridas) y muestra lo que nunca sale: recuerdos, chats, personas, claves, tu nombre (pasa a ser `{{user}}`), tus notas de relación y tus límites. **Instala un paquete** como compañera nueva, nunca encima de una que ya tengas, con una tarjeta de revisión; las actualizaciones muestran qué cambió la autora y mantienen tus propios cambios. Las tarjetas de personaje V1/V2/V3 (PNG, JSON, CHARX) se importan como paquetes, y un lorebook se convierte en unas pocas líneas de fondo, nunca en recuerdos. La comprobación de menores se hace al crear, revisar e instalar el paquete, sin excepción; las clasificaciones se ajustan al modo adulto. Cuatro compañeras de inicio en la tienda: Juniper, Rowan, Vesper y Jax. También arreglado: exportar una tarjeta de personaje ya no incluye tu nombre ni tus notas. |
| **2.59** · «Hey Sara» | **Di su nombre y habla** en la app de Windows: un modelo de 5 MB en tu ordenador solo escucha «Hey Sara» (o tus propias palabras para cada compañera), y no se envía nada hasta que las dices; la grabación empieza después de la frase, el audio nunca se guarda y un punto en el icono de la bandeja muestra cuándo escucha. Apagado hasta que lo actives, en cada dispositivo; se pausa con la pantalla bloqueada; si dos dispositivos te oyen, responde uno. **Habla con Sara** con Ctrl+Alt+Espacio o la bandeja, y en Android con un botón Hablar en la notificación y un mosaico de ajustes rápidos. El aviso de IA se dice primero y la ayuda en crisis se lee completa. **Oído y voces locales en Windows:** `sara voice install` (unos 650 MB, cada archivo comprobado), antes solo en Linux. Mac, Linux y el detector de Android siempre a la escucha vienen después. |
| **2.58** · Conseguir más | **Ajustes → Habilidades → Conseguir más:** explora y busca en la Sara Store, abre un elemento e instálalo con un clic a través de la tarjeta de revisión de siempre (nada se activa solo). Los servidores de herramientas tienen una tarjeta con el comando exacto (y su forma en Windows), lo que necesita, a qué puede llegar y si va aislado; las claves van a la bóveda. **Las actualizaciones** muestran exactamente qué cambia, con los permisos nuevos marcados, y puedes volver atrás. **Mis complementos** lo lista todo con su origen. **Envía los tuyos:** `sara pack` revisa un plugin, una habilidad o un servidor de herramientas en tu ordenador (manifiesto, permisos, búsqueda de secretos, prueba rápida aislada, capturas) y luego *Enviar* en Ajustes o `sara submit` lo manda, firmado con tu propia clave de autor. El equipo de Sara lo revisa antes de publicarlo, y en *Mis envíos* puedes seguirlo y responder. Las denuncias y retiradas apagan un complemento, nunca lo borran. |
| **2.57** · Abre la Sara Store | **Una estantería firmada** en [backstagecoding.com/sara/store](https://backstagecoding.com/sara/store/): Alertas del tiempo, Concentración, Escenas de casa, Resumen de GitHub, Lista de lectura y Notas de webhooks, más servidores de herramientas para ComfyUI, Blender, un navegador (Playwright), GitHub, archivos de este ordenador y documentación (Context7), cada uno con una versión exacta fijada. Sara comprueba la firma de la lista, la huella de cada archivo y la caducidad antes de mostrar nada; una lista dañada, vieja o retirada se rechaza y se conserva la última buena. Al mirar no se envía ningún identificador ni cookie. Las instalaciones siguen pasando por la tarjeta de revisión de siempre y nada se activa solo; lo retirado de la tienda se apaga, nunca se borra. **Ordenar habilidades:** las que no se usan se pueden archivar y recuperar. Lo siguiente: instalar desde Sara y enviar las tuyas. |
| **2.56** · Ligera y ordenada | **Una lista corta de herramientas por paso:** elegida en código (sin llamar a ningún modelo) según lo que haces: el modo, tus palabras, las referencias con `@`, el uso reciente, una habilidad cargada, las rondas anteriores de un objetivo y las que siempre se mantienen por seguridad. El resto lo busca ella con *find tools*, y cada llamada se sigue comprobando contra todo lo que tiene permitido. Medido: una instalación nueva pasa de 11.871 a 5.471 tokens por paso (−54 %); con cuatro servidores MCP, de 23.476 a 5.438 (−77 %). `/tools` muestra lo que se ofrece. **`/compact`:** resume la parte antigua de un chat largo, escrito primero en este ordenador (los chats privados nunca salen de él). Tus mensajes siguen en el hilo, con *Ver resumen* y *Deshacer*; también se hace solo cerca del límite y los mensajes de crisis se mantienen palabra por palabra. Funciona en todas las apps de chat. |
| **2.55.3** · MCP en Windows | Arreglado: en Windows, los servidores MCP que se inician con `npx` (incluidas las plantillas incorporadas) no arrancaban. |
| **2.55.2** · iMessage | **iMessage con BlueBubbles** (Ajustes → Conexiones → iMessage, un plugin opcional): escríbele desde Mensajes en tu iPhone. Necesita un Mac con BlueBubbles y un Apple ID propio para ella (Sara no funciona con el tuyo, porque vería todos tus chats). Ocho pasos guiados comprobados con un ✓, soluciones sencillas, texto, fotos y archivos, y se pone al día con lo que le llegó mientras estaba desconectada. Puntos de escritura y reacciones solo si la Private API de BlueBubbles ya está activada; Sara nunca te pide bajar la seguridad de tu Mac para eso. |
| **2.55.1** · Matrix | **Matrix** (Ajustes → Conexiones → Matrix, un plugin opcional): habla con ella en Element o cualquier app de Matrix con una cuenta de Matrix propia. Cinco pasos guiados, cada uno comprobado con un ✓, y soluciones sencillas para cada error. Texto, fotos y notas de voz; solo tú salvo que permitas a otros (también servidores enteros); las invitaciones de desconocidos se rechazan. Solo salas sin cifrado de extremo a extremo: en una sala cifrada explica por qué no puede leerla y se va. |
| **2.55** · WhatsApp | **WhatsApp** (Ajustes → Conexiones → WhatsApp, un plugin opcional): escríbele con la API oficial WhatsApp Cloud de Meta en una cuenta y un número de Meta que son tuyos. Una tarjeta guiada de 10 pasos nombra las pantallas exactas de Meta, comprueba cada paso con un ✓ y convierte cada error en una frase sencilla con su solución. Fotos y archivos en los dos sentidos, puntos de escritura y una línea *Estoy en ello* con Detener en tareas largas, solo tú salvo que añadas otros números, y sus primeros mensajes solo dentro de la ventana de 24 horas de WhatsApp. Las condiciones de Meta limitan los asistentes de IA generales en WhatsApp, así que está apagado hasta que lo instales y marques que las has leído. |
| **2.54** · Rutinas y una revisión de seguridad | **Galería de rutinas** (Planificador → Rutinas): resumen matutino, repaso semanal, recordatorios para estirarte y para dormir, salir a tiempo, vigilar el CI de un repo, nuevas incidencias, comprobar copias, ordenar el correo y alerta de precio. Cada tarjeta dice qué hace, qué necesita y cuánto cuesta, calculado en código (casi todas son gratis), muestra una vista previa sin llamar a ningún modelo y tiene un interruptor de apagado; las de pago terminan en la fecha que elijas. Las herramientas mantienen tus ajustes de aprobación. **Revisión de seguridad** (Ajustes → Datos y estado): 17 comprobaciones de solo lectura, un veredicto en palabras (*Parece seguro*, *Casi todo seguro*, *Arregla esto primero*) y arreglos de un clic que solo pueden hacerlo más seguro, cada uno diciendo si se puede deshacer. Los cambios en cómo se llega a Sara se guían, nunca con un clic. También `sara doctor --safety`. |
| **2.53** · Precisión al programar | **Comprobaciones tras sus cambios:** cuando cambia código, Sara ejecuta el comprobador del propio proyecto (tsc, pyright o mypy, cargo check, go vet, eslint), ya instalado, nunca `npx`, nunca instala nada, y le pasa solo los errores nuevos en el mismo turno, incluidos archivos que su cambio rompió en otro sitio. Los arregla antes de responder (como mucho dos avisos) y la respuesta muestra *✓ types clean (tsc)* o lo que queda. Un OK por proyecto. **Referencias con @:** escribe `@` en el chat para `@file` (con líneas), `@folder`, `@diff`, `@branch`, `@problem` o `@url`; las etiquetas muestran lo que recibirá y su tamaño, y funciona como texto en Telegram, Discord y las demás apps. Los archivos secretos se rechazan y los chats privados nunca abren páginas web. |
| **2.52.1** · Conectar un servidor es fácil, fotos arregladas | *Conectar un servidor* solo pide la dirección y el usuario; Sara crea su llave, encuentra el puerto y la forma más fácil de entrar (un token de cPanel que ella misma borra, tu contraseña una vez o una línea para pegar) y explica cada fallo con palabras sencillas. Las fotos ahora siempre llegan a un modelo que puede verlas. |
| **2.52** · Cuando salga el tema | **Recordatorios que esperan a una persona o un tema:** «cuando salga Dan, recuérdame que me debe 20 $» o «la próxima vez que mencione el huerto, pregunta por los tomates». Lo menciona una vez, dentro de su respuesta, con *Hecho*, *Otra vez la próxima* u *Olvidar*. Se detecta con tus tarjetas de personas y palabras simples, sin llamar a ninguna IA, y nunca adivina entre dos Dan. Solo se activan con tus propios mensajes en tus propios chats, nunca donde Dan pueda leerlo, y lo que fuera a enviar a otra persona que lo contenga pregunta antes. **Retomar un chat en otra app:** empieza en Telegram, abre la app y *Seguir aquí* trae ese chat (`/continue` en cualquier sitio), con *Mostrar* y *Deshacer*; no se copia nada. |
| **2.51** · Sigue hasta terminar | **Objetivos con prueba:** «haz que pasen los tests, listo cuando `npm test` esté en verde»: trabaja ronda a ronda dentro de límites (rondas, minutos, tokens, dólares) y Sara ejecuta tu comprobación, no ella, así que *listo* significa que de verdad pasó. Un verde que solo llegó tras editar los tests termina como *listo, revisar*; el mismo fallo dos veces la pausa como *atascada*. **`/loop every 10m: check the deploy`**: en silencio mientras nada cambia, un mensaje cuando cambia, se detiene con *until* (con prueba), tras dos fallos, a su hora de fin o con un límite diario, y nunca pide aprobaciones sin ti. Las tarjetas del tablero pueden llevar una comprobación *Listo cuando*. Tras un reinicio todo vuelve en pausa. También: editar archivos con finales de línea de Windows fallaba. |
| **2.50** · Signal y correo | **Dos formas más de hablar con ella, ya incluidas.** *Signal* mediante signal-cli en tu propio ordenador: grupos como salas con seguimiento, 👀 cuando recoge tu nota, un mensaje de progreso en vivo, archivos en ambos sentidos y tu número de seguridad fijado, así que una clave cambiada pausa sus herramientas hasta que confirmes. *Correo* en su propio buzón: una sesión por hilo, respuestas en el hilo, tu correo cuenta como tuyo solo si pasa la comprobación de remitente de tu proveedor, a los desconocidos nunca se les responde, el correo reenviado hace que cada herramienta pregunte primero y las respuestas automáticas, boletines y rebotes nunca crean un bucle. Sara mantiene las conexiones de estos plugins, solo a las direcciones que pusiste. También: una respuesta de un chat por plugin que tardaba más de 5 minutos se cortaba. |
| **2.49** · Háblale mientras trabaja | **Ya no hace falta esperar a que termine.** Escribe mientras trabaja y elige: *Díselo ya* (lo lee antes de su siguiente paso y cambia el rumbo; nunca puede aprobar nada), *Después* (espera y se ejecuta como su propio turno) o *Solo una pregunta* (`/btw`: una respuesta rápida aparte, sin guardar nada, el trabajo sigue). Igual en Telegram y Discord (`/queue`, `/btw`). Un **freno de bucles** la detiene tras tres llamadas idénticas fallidas y la obliga a cambiar de enfoque. |
| **2.48** · Las apps de chat se ponen al día | **Fotos y archivos en ambos sentidos en Telegram y Discord:** mándale una foto (con texto, un álbum o como archivo) o un documento y lo lee; pídele un selfie, un gráfico o un archivo y llega (`send_file`). Las fotos de otras personas en una sala siguen desactivadas hasta que las actives, y entonces solo ve una descripción. **Un mensaje de progreso** se actualiza mientras trabaja, tiene un botón de parar y termina como una línea de resumen. Los puentes de plugins también pueden llevar archivos. |
| **2.47.3** · Empieza aquí | **Dos formas de empezar:** [Empieza aquí](docs/START_HERE.md) para «ya lo instalé, ¿y ahora?» y [Para programadores](docs/FOR_CODERS.md), ambas con los vídeos (en inglés). Capturas nuevas, el recorrido de funciones dividido en *Para compañía*, *Para programar* y *Para ambos*, todas las respuestas de *¿Cómo hago…?* en un índice (en la guía y en la web de documentación) y una web de documentación reorganizada. |
| **2.47.2** · Un solo estilo y ayuda en cada página | **Cada página tiene ahora un recuadro *¿Cómo hago…?*** con respuestas paso a paso (123, con *Muéstramelo*), y las páginas vacías dicen qué va ahí y ofrecen un paso claro. Un estilo de tarjeta, iconos en vez de emoji, espaciado y esquinas unificados, un menú de ajustes que abre un grupo a la vez, el móvil más ordenado y sin desplazamiento lateral, una pantalla de primer acceso más clara, y la configuración de programación prefiere un modelo capaz en tu propio ordenador. |
| **2.47.1** · Un comienzo a tu medida | **La configuración hace una pregunta: compañía, programación o ambas.** Recibes un modelo recomendado con una prueba real *Conectado ✓*, un recorrido de seis paradas a juego (el completo sigue en Ayuda), sugerencias para empezar en un chat vacío y una lista de primeros pasos en el orden que te conviene. Las ventanas nunca se amontonan, y el aviso de la señal anónima va en el último paso. |
| **2.47** · Una personalidad que se ve | **Sus diales de personalidad ahora muestran lo que hacen:** extremos claros («Guarda las distancias ↔ Abiertamente cálida»), una palabra para el punto actual y una frase con su voz que cambia al moverlo (125, sin llamar a ninguna IA). Grupos con nombres claros, un resumen «Tu Sara hasta ahora» y palabras sencillas en el resto de controles. También: Hoy se actualiza tras la configuración, un mismo número de modelos en todas partes con un selector agrupado, importar una persona la renombra en todas partes a la vez y *Salir a las* va antes de su evento. |
| **2.46** · Informa de un problema desde Sara | **Ayuda → Informar de un problema o Sugerir algo** (o `/bug` e `/idea` en cualquier chat, o *Informar* en un error): sin cuenta de GitHub. El diagnóstico opcional se crea en tu ordenador, se muestra completo con una casilla por parte y se limpia de claves, correos y rutas antes de enviar nada. *Mis informes* muestra el estado y nuestras respuestas. Sara también envía una pequeña señal anónima al día (versión, Windows/Mac/Linux, qué funciones están activas) para poder ayudarte y planificar; no se guarda la IP, el nombre ni los chats. *Ver qué se envía* o desactívalo en Ajustes → Datos y estado → Privacidad. |
| **2.45** · Hoy en el móvil | **En el móvil, Hoy empieza con una tarjeta Ahora** (las dos próximas cosas y cuánto falta, cuándo salir, el tiempo y su ánimo), luego *Te necesita* y luego tu día. Las secciones se pliegan con un resumen y quedan como las dejaste en ese dispositivo, *Con ella* y *Trabajo* pasan a filas deslizables (también con botones) y tirar para actualizar funciona en el navegador y en las dos apps. Las tabletas tienen dos columnas. Opcional: una frase suya sobre lo que pasó mientras no estabas. |
| **2.44** · Hoy, diseñado | **Hoy está organizado a propósito:** *Tu día* (una línea de tiempo con eventos, recordatorios y tareas, el tiempo y lo que viene), *Te necesita* (aprobaciones, fallos, pendientes atrasados y el correo), *Con ella*, *Trabajo* y *Casa y más*. Las filas siempre cuadran, los mosaicos vacíos se pliegan y *Personalizar* mueve, cambia de tamaño u oculta cualquier mosaico (arrastrando o con el teclado), guardado por compañera en todos tus dispositivos. El correo muestra tu bandeja, el cambio desde ayer y lo que ella ordenó, con Deshacer, y se actualiza solo tras una limpieza. Un mosaico opcional de Salas muestra lo que pasa en las salas que sigue. |
| **2.43** · Sigue la conversación de la sala | **En canales de Discord y grupos de Telegram sigue toda la conversación** (se activa por sala; una tarjeta de plan muestra antes el modelo y el límite diario). Cuando alguien la llama sabe de qué se habla ahora, quién está y qué cambió desde que habló, así se une al tema actual y no a uno de hace una hora. Cada semana se archiva en su Biblioteca como transcripción con búsqueda y se resume en una memoria de la sala con notas sobre la gente (tarjetas de personas propuestas). *Olvidar esta sala* lo borra todo. 12 canales concurridos reproducidos en 6 idiomas: en el tema actual 12/12. |
| **2.42** · Títulos que crecen | **Títulos que dicen de qué iba la sesión.** El primero es provisional; tras unos intercambios, cuando el tema cambia claramente y con `/new`, un modelo pequeño en tu propio ordenador le pone nombre de nuevo («Empezar un huerto» → «Declarar impuestos como autónomo»). Los títulos que pones tú no se cambian nunca, los anteriores quedan en la información del chat, nada sensible ni privado acaba en un título y hay un límite diario. 40 sesiones de prueba: 0,90 en el tema con un modelo local de 12B. |
| **2.41** · Una lista de sesiones ordenada | **Cada app de chat tiene su propio proyecto.** Telegram, Discord y cada puente de plugin (WhatsApp, Signal…) tienen un proyecto incluido que reúne sus chats, así tus conversaciones de la web y las apps se quedan en tus proyectos. Tus chats existentes se ordenan una vez, con Deshacer. Las salas muestran su nombre real (#general · Servidor), las sesiones anteriores quedan bajo su chat y las listas largas muestran las más nuevas con *Ver más*. Renombra u oculta un proyecto de canal; agrupa uno concurrido por sala. |
| **2.40** · Comandos de chat | **`/new`, `/reset`, `/stop`, `/status`, `/help`, `/model` y `/remember` en todas partes:** en Telegram y Discord (en sus propios menús de comandos, registrados por ti, en tu idioma), en la web y como «Sara, nueva» donde la barra no está a mano. `/new` empieza una sesión nueva y guarda la anterior (resumida); `/status` muestra el modelo, cuánto ocupa la sesión y el consumo; cuando una sesión está casi llena ella misma ofrece `/new`. Los comandos solo del dueño se rechazan para cualquier otra persona, siempre. |
| **2.39** · Mudanza: ajustes e informe | **El resto de la configuración anterior.** Modelos y proveedores, voz, zona horaria, canales de chat, aprobaciones y reglas del agente anterior se convierten en tarjetas que confirmas una a una (las claves nunca se copian: las vuelves a poner, de forma segura). Los hooks y el código de plugins se leen como texto, nunca se ejecutan, y se explican en palabras sencillas con un equivalente en Sara (una regla en su ficha, un filtro que pregunta antes, una función que ya existe o un plan para rehacerlo como plugin de Sara). Las copias duplicadas de bases de datos se detectan y se importan una vez. Al final, un informe: qué llegó, qué te necesita, qué se quedó y dónde vive ahora cada función antigua en Sara (descárgalo, o deshazlo todo). |
| **2.38** · Mudanza: sus bases de datos | **También vienen los almacenes de memoria propios.** Si el agente anterior guardaba su memoria en su propia base SQLite o Postgres, Sara la lee (Postgres solo lectura, con su propio cliente, o un archivo `pg_dump`), salta registros y telemetría y propone para cada grupo de tablas qué es y adónde va (notas, personas y datos, conversaciones, tareas, metas, diario). Tú confirmas cada tarjeta; nada se importa antes. Las asignaciones confirmadas se guardan, y Deshacer lo quita todo igual. |
| **2.37** · Mudanza | **Trae a tu agente contigo.** ¿Vienes de Hermes Agent u OpenClaw? Un archivo pequeño (Python, sin instalar nada) se ejecuta en la máquina vieja y te enseña antes su plan; los secretos nunca se empaquetan y los datos médicos o íntimos se quedan salvo que digas lo contrario. Sara te lo muestra todo con números y ejemplos: la personalidad (decides tú), notas y lo que sabía de ti, chats anteriores, habilidades, horarios y tableros. Un clic lo importa como un solo lote, y Deshacer quita exactamente ese lote durante 30 días. |
| **2.36** · Sus propios planes | **Opcional: lleva sus propios planes.** Seguimientos de lo que le contaste («¿qué tal la entrevista?») y metas que trabajáis juntos, sacados solo de tus palabras y mostrando siempre dónde lo dijiste. Apagado por defecto; encendido, Planificador → *Sus planes* lo muestra todo, comparte con sus primeros mensajes el límite diario, las horas de silencio y la regla de espacio, tiene un pequeño presupuesto diario, hace una pausa tras un momento difícil, y un interruptor lo para todo al instante, incluso a media frase. Las metas esperan tu *Usarla*. |
| **2.35** · Webhooks | **Otros servicios pueden despertarla.** Da a GitHub, Stripe, Home Assistant o a cualquiera que hable Standard Webhooks su propia dirección firmada; elige cuándo cuenta (condiciones sin código, con plantillas) y qué hace ella: avisarte, añadir una tarea, ejecutar una habilidad o pasárselo a un plugin. Las firmas se comprueban sobre los bytes originales, se rechazan entregas viejas o repetidas, y el contenido no es de fiar: lo que cambie algo sigue preguntándote. Registro de entregas y botón de prueba en cada tarjeta; copias salientes firmadas si quieres. |
| **2.34** · Personas | **Lleva la cuenta de las personas de tu vida.** Una tarjeta por cada persona de la que hablas (relación, cumpleaños, lo que sabe con tus palabras), hecha a partir de sus recuerdos. Las nuevas esperan tu *Está bien*; corrige, une, separa u olvida a quien quieras (olvidar borra de verdad). ¿Dos Jeff? Pregunta cuál. Lo privado se queda en chats privados y lo sensible se pliega. Las tarjetas nunca llegan a otras apps, otros agentes, plugins, chats de grupo o de pareja; cada miembro del hogar tiene las suyas. |
| **2.33** · Otros agentes (A2A) | **Habla con otros agentes de IA** con el protocolo abierto Agent2Agent, en ambos sentidos, escrito desde la especificación. Da a un agente su propia clave y elige qué puede pedir; ella puede preguntar a agentes que añadas (otra Sara o cualquier agente A2A), recibir sus respuestas en directo, pararlas o asignarles una tarjeta del tablero que vuelve con comprobantes. Lo que un agente pida que cambie algo necesita tu OK; sus palabras no son de fiar; nada privado, de pareja o de grupos sale; dice que es una IA. 61/61 comprobaciones del protocolo. |
| **2.32** · Tablero | **Un tablero Kanban sobre tus tareas.** Cada proyecto tiene un tablero (Por hacer, En curso, Te espera, Hecho) con etiquetas, listas, fechas y repeticiones; arrastra con ratón, dedo o teclado. Asigna una tarjeta a Sara o a un equipo de ayudantes y la trabaja en segundo plano: pasa a Hecho solo si hay comprobantes del trabajo; si no, te espera con lo que no pudo demostrar. Pregúntale «¿qué está bloqueado?» o pídele añadir y mover tarjetas (pregunta antes). Tableros compartidos del hogar; un mosaico Te necesita en Hoy. |
| **2.31** · Plugins | **Plugins y hooks.** Un plugin es una carpeta con un `sara-plugin.json`: hooks antes de su respuesta, antes y después de herramientas y tras las respuestas, más sus propias herramientas, tarjetas, ajustes, horarios y puentes de chat. Lo añades desde zip, git o una carpeta tras leer una tarjeta que explica qué puede hacer; está apagado hasta que lo enciendes. Cada uno corre en su propio proceso aislado (bubblewrap en Linux, Seatbelt en el Mac) y solo puede añadir o endurecer, nunca relajar sus reglas ni tocar la capa de seguridad. Un plugin que se cuelga o falla nunca rompe un chat. Incluye dos ejemplos; guía en docs/PLUGINS.md. |
| **2.30** · Habilidades aprendidas | **Se da cuenta de lo que pides a menudo.** Pide lo mismo tres veces en días distintos (o repite la misma cadena de pasos de código) y te ofrece, una vez, convertirlo en habilidad: ves el borrador y lo guardas, lo editas o dices que no. Una habilidad nueva se prueba antes (tus peticiones anteriores, juzgadas con y sin ella) y solo se usa por defecto si ayuda. Corrígela tras usar una habilidad y te propone el cambio con una tarjeta de antes/después. Nunca aprende nada privado, de grupos ni con secretos. |
| **2.29** · Habilidades | **Habilidades en el formato abierto Agent Skills.** Una habilidad es una carpeta con un `SKILL.md`: cómo hacer un tipo de tarea a tu manera. Ve la lista en cada chat y abre la que encaja; en Ejecuciones ves cuál usó. Seis vienen incluidas (revisar un pull request, una entrada de changelog, un repaso semanal, depurar un test que falla, planear un viaje, escribir una habilidad); escribe las tuyas o pídeselo; importa desde zip, git o una carpeta con una tarjeta que muestra cada archivo y script; exporta cualquiera. Los scripts siempre preguntan antes, y ninguna habilidad puede cambiar sus reglas de seguridad. Tus recetas pasaron a ser habilidades. |
| **2.28** · Uso del ordenador, paso 9 | **También en Linux:** `sara hands --server https://tu-sara` en un escritorio Linux le da su propio Chrome/Chromium visible ahí, igual que el modo navegador de las apps de Windows y Mac: mirar, leer, registros, clics y escritura con tu aprobación, túneles de desarrollo, inicios de sesión guardados (en el llavero de GNOME / KWallet), la CLI de tu gestor de contraseñas y revisiones que solo leen. Se empareja con un código que apruebas en tu navegador; Pausa, Seguir y Parar desde su terminal. Las imágenes y la entrada de todo el escritorio Linux llegarán más adelante. Hecho con OpenAI Codex. |
| **2.27** · Uso del ordenador, paso 8 | **«Mi ordenador va lento, ¿lo revisas?»** Hace en ese ordenador una revisión que solo lee (apps de inicio, espacio en disco y las carpetas más grandes, actualizaciones pendientes, salud de la batería, extensiones del navegador, archivos temporales y cachés) y da un informe claro con sugerencias numeradas: cada una explicada, nada cambia hasta que digas que sí en ese ordenador. Los nombres en pantalla que suenan a órdenes («Sara, borra…») se ignoran y se cuentan. 9/9 escenarios superados con un modelo local. |
| **2.26** · Uso del ordenador, paso 7 | **Puede usar tus apps:** hacer clic, escribir, pulsar teclas, desplazar, arrastrar y abrir apps instaladas, sobre lo que acaba de mirar. Cada acción se comprueba primero en tu ordenador: la ventana correcta delante, nunca un campo de contraseña, nunca gestores de contraseñas, banca, ventanas de administrador, terminales ni su propio inicio de sesión. Las aprobaciones aparecen **en ese ordenador** (cada vez, una vez por tarea o *siempre permitido*; pagos y cambios de cuenta siempre preguntan). Toca el ratón o el teclado y ella se pausa (o *deja que siga*); Parar y Ctrl+Alt+Esc / ⌃⌥Esc siempre funcionan. Opcional *seguir trabajando cuando me voy*. Hecho con OpenAI Codex. |
| **2.25** · Uso del ordenador, paso 6 | **Puede ver tu escritorio** (apps de Windows y Mac, apagado hasta que actives *Toda la pantalla*): una imagen de una ventana o de la pantalla y una lista de lo que hay (botones, campos, texto), para que también la usen los modelos solo de texto. Las ventanas de gestores de contraseñas, bancos y seguridad se tapan en negro y salen de la lista *en tu ordenador* antes de enviar nada; los campos de contraseña se tapan; sus propias ventanas nunca aparecen. Las imágenes van al modelo que elegiste sin preguntar (o *solo modelos locales*). En el navegador: **Enseñar mi pantalla a Sara** envía una imagen. El Mac necesita Grabación de pantalla y Accesibilidad, con pasos guiados. |
| **2.24** · Uso del ordenador, paso 5 | **Tu gestor de contraseñas rellena los inicios de sesión en su navegador:** Bitwarden, 1Password o KeePassXC, cada uno apagado hasta que lo enciendes. Lo desbloqueas tú en la ventana del propio gestor (ella nunca ve tu contraseña maestra); cada uso pregunta antes; solo rellena en el sitio exacto del inicio de sesión; ella lo vuelve a bloquear tras la tarea, tras 15 minutos sin uso, al pulsar Parar o con *Bloquear ahora*. Nada llega al servidor de Sara ni al modelo. Su navegador ya no ofrece guardar contraseñas por su cuenta. |
| **2.23** · Uso del ordenador, paso 4 | **Inicios de sesión guardados, solo si tú lo dices:** ella lo ofrece y una ventana en *tu ordenador* te pide escribir el inicio de sesión y marcar *Lo entiendo* (o *Usar lo que acabo de escribir*). Se cifra ahí (DPAPI de Windows / Llavero de macOS), nunca en el servidor de Sara, y ella nunca lo ve: solo puede pedir a ese ordenador que lo rellene, exactamente en ese sitio (los sitios parecidos no reciben nada), y cada uso pregunta antes. Windows Hello / Touch ID opcional. **Tu turno:** ella espera mientras inicias sesión o escribes un código tú. |
| **2.22** · Uso del ordenador, paso 3 | **Depura tu proyecto web en su navegador:** el servidor de desarrollo que sus herramientas de código iniciaron en tu servidor Sara se abre en `127.0.0.1` en su navegador de tu ordenador, a través de la app (solo un puerto de su propio trabajo; termina con el trabajo), con recarga en caliente y almacenamiento local. Tras un cambio abre la app, lee la consola, mira, corrige y vuelve a comprobar. Evals de navegador: 5/5 tareas con un modelo local. Además: las pruebas ya pasan en macOS y dos correcciones de privacidad de red. |
| **2.21** · Uso del ordenador, paso 2 | **Actúa en su propio navegador:** hace clic, escribe, elige en listas, se desplaza, pulsa teclas y sube un archivo que tú nombras, con un cursor visible. Tú eliges cuánto pregunta: siempre, una vez por tarea (predeterminado) o *siempre permitido* por sitio; pagos y ajustes de cuenta siempre preguntan, enviar pregunta cada vez y nunca escribe contraseñas. Una insignia **Sara está trabajando** con Detener y un atajo para detenerla (Ctrl+Alt+Esc / ⌃⌥Esc); si tocas su ventana, se pausa (o *Dejar que Sara siga al mando*). |
| **2.20** · Uso del ordenador, paso 1 | Con la app de Windows o Mac, **abre páginas web en su propia ventana del navegador en tu ordenador** (su propio perfil, nunca tu navegador ni tus contraseñas), las lee, hace capturas y lee errores de consola y de red: di «mi app en localhost falla» y ella mira. Apagado hasta que actives *Dejar que Sara use este ordenador*; vista en directo en el chat con Detener; cada paso en Ejecuciones con una imagen. Hacer clic y escribir llegan después. [El plan](docs/design/COMPUTER_USE.md) |
| **2.19** · Modo red team | **Antes de publicar, intenta romper su propio trabajo:** en una copia aislada pasa tus pruebas, arranca tu app y lanza entradas mal formadas y límite a cada punto de entrada, revisa ajustes inseguros por defecto y deja que el modelo de código escriba pequeños scripts de ataque que solo alcanzan esa app aislada. Un modelo revisor más fuerte solo conserva los fallos que se reproducen, citando la entrada, la salida y la línea de código. Luego **Arreglar lo que falló** en una rama local. También en 2.19: **organizar Gmail** (archivar, marcar como leído, etiquetas, papelera… por búsqueda o fecha, primero cuenta, Deshacer). [Cómo funciona](docs/design/HARNESS_TRACK.md) |
| **2.18** · Recuerda por sí misma | **Recuerda sin que se lo pidas cuando la situación encaja:** el mismo error vuelve en este proyecto («la última vez la solución fue…»), un comando que ya falló aquí, un archivo sobre el que decidiste algo, una tarea parecida a otra de la que aprendió. Las lecciones solo salen de lo que pasó de verdad (la línea del error y el cambio que lo arregló, citados). Cada nota dice de dónde viene y con qué seguridad, como mucho 2 por paso, y *No sirve* le enseña. [Cómo funciona](docs/design/HARNESS_TRACK.md) |
| **2.17** · Evaluaciones con tu propio trabajo | **¿Qué ajuste es de verdad mejor para ti?** Elige hasta 3 variantes (modelo, desvanecimiento de la memoria, modo de sandbox, presupuesto) y ella repite tus últimas tareas reales con cada una en copias aisladas. Se puntúa si pasan tus pruebas, cómo reaccionaste, hallazgos, tokens, tiempo y coste, más un juez opcional que debe citar. Solo se nombra un ganador cuando una prueba de signos lo confirma («+18 % en 20 de tus tareas de código, p=0,01»), con la comparación de cada par como prueba. Si no: *sin un ganador claro*. [Cómo funciona](docs/design/HARNESS_TRACK.md) |
| **2.16** · Viaje en el tiempo | **Ramifica cualquier tarea pasada desde cualquier paso:** cambia en ese paso su mensaje, un resultado de herramienta, las notas que recordó o el modelo, y ejecútala de nuevo. Los pasos anteriores salen del registro (nada se vuelve a ejecutar). Las ramas de código trabajan en una copia en el commit registrado, nunca en tus archivos. Una comparación lado a lado muestra pasos, tokens, coste, cambios de archivos y la respuesta. *Repetir sin cambios* es el control. Te quedas con la respuesta o aplicas los archivos solo si quieres. [Cómo funciona](docs/design/HARNESS_TRACK.md) |
| **2.15** · Modelo de amenazas | **Traza cómo llega el exterior a tu código:** tras un paso de código encuentra los puntos de entrada (rutas, subidas, manejadores de mensajes, línea de comandos en Express, Koa, Fastify, Flask, FastAPI, Django, Go) y sigue los valores de la petición entre archivos hasta las líneas arriesgadas (shell, SQL, rutas de archivo, URLs salientes, redirecciones, HTML, eval). Una amenaza solo se informa con ambas líneas citadas y el camino nombrado. Una pestaña **Modelo de amenazas** por proyecto y **Arreglar estas**: una segunda pasada que solo las corrige, en una rama local, con tus pruebas otra vez. [Cómo funciona](docs/design/HARNESS_TRACK.md) |
| **2.14** · Revisión de seguridad | **Tras un paso de código revisa su propio trabajo:** 11 comprobaciones (secretos, SQL armado con texto, rutas que escapan, TLS desactivado, eval, deserialización insegura, CORS, falta de autenticación…) más un modelo revisor, en paralelo. Cada hallazgo cita la línea real o se descarta: nada de teatro. Las **alertas en vivo** opcionales (OSV.dev) revisan los paquetes que instala y detienen en una tarjeta una versión con fallos conocidos. **Arreglarlo** crea una rama local, corrige solo eso, vuelve a pasar tus pruebas en el sandbox y muestra el cambio. Nunca hace push. [Cómo funciona](docs/design/HARNESS_TRACK.md) |
| **2.13** · Primero en un sandbox | **Los comandos arriesgados se ejecutan primero en una copia desechable de tu proyecto.** Borrados, instalaciones, scripts y accesos a la red ocurren en la copia (dentro de bubblewrap en Linux, Seatbelt en macOS, Docker o WSL2 en Windows si los tienes). La tarjeta **Ejecutado en un sandbox** muestra qué cambió y lo sospechoso: archivos borrados en masa, escrituras fuera de la copia, programas que siguen en marcha, hooks de git. Luego *Aplicar a mi espacio de trabajo*, *Descartar* o *Ejecutar de verdad*. [Cómo funciona](docs/design/HARNESS_TRACK.md) |
| **2.12** · Presupuestos que respeta | **Un límite firme, no un informe:** las tareas de código tienen un presupuesto (200k tokens / 40 pasos por defecto, dólares opcionales). Cerca del límite cambia a tu modelo rápido, reduce las rondas de herramientas, escribe un breve resumen de lo hecho y lo pendiente, y se detiene. Seguir requiere tu **Continuar con más**. Las tareas en segundo plano y de equipo usan el mismo presupuesto. [Cómo funciona](docs/design/HARNESS_TRACK.md) |
| **2.11** · Instantáneas de cada ejecución | **Cada paso de su trabajo queda registrado:** qué modelo, el prompt, cada llamada a herramienta y su resultado (sin secretos), los archivos que tocó (en proyectos de código, el HEAD de git y los archivos cambiados), las notas que usó, los conflictos que encontró, tokens, coste y tiempo. **Ver la ejecución**, bajo cualquier respuesta, lo muestra paso a paso. Se guarda 90 días por defecto; nada sale de tu servidor. La base de los presupuestos, el viaje en el tiempo y las evaluaciones. [Cómo funciona](docs/design/HARNESS_TRACK.md) |
| **2.10** · Compara sus planes con los tuyos | **Antes de actuar, compara el paso con lo que decidiste.** ¿Le dijiste «nunca hagas push a main», «pruebas antes de cada push», «usa pnpm» o «no toques la configuración de producción»? Un paso planeado que va en contra **se detiene en una tarjeta** que cita tu decisión, con *Hacerlo igualmente*, *No* o *Actualizar la nota*. En la charla diaria solo lo menciona. Las reglas se comprueban en el código (sin adivinar) y solo puede añadir una parada, nunca quitarla. [Cómo funciona](docs/design/HARNESS_TRACK.md) |
| **2.9** · Memoria ordenada | **Te dice por qué recordó algo:** cada nota que usa se puntúa para tu mensaje y muestra *por qué le vino a la mente* y *con qué seguridad* (también en su panel). Las notas viejas se desvanecen poco a poco en vez de desaparecer, las que usa a menudo siguen fuertes y puedes **fijar** las que nunca deben desvanecerse. El desvanecimiento se ajusta con un control deslizante. [Cómo funciona](docs/design/HARNESS_TRACK.md) |
| **2.8** · Pulido | **Un punto más refinado:** una aurora lenta tras el cristal esmerilado, una serif elegante para los títulos, un halo luminoso del color de su ánimo alrededor de su retrato, iconos dibujados, ilustraciones del tiempo y anillos de progreso, y una barra de cristal flotante en el móvil (todo movimiento se apaga con *reducir movimiento*). [El plan](docs/design/NEW_LOOK.md) |
| **2.7** · El nuevo aspecto, parte 3 | **Hoy en mosaicos** (tiempo, tu día, agenda, lo que recordó, momentos, trabajo de fondo, casa), una barra inferior en el móvil, todas las pantallas con el nuevo aspecto, y en las apps de Windows y Mac **avisos con Permitir / Denegar y Hecho / Más tarde**, *Enviar a → Sara* para archivos y voz en la pregunta rápida. [El plan](docs/design/NEW_LOOK.md) |
| **2.6** · El nuevo aspecto, parte 2 | **Su presencia:** un panel lateral (en el móvil, una hoja que se desliza hacia arriba) con su ánimo, lo que está haciendo, aprobaciones, trabajos, el día y lo que recordó; Ctrl+K para ir a cualquier sitio; y en las apps de Windows y Mac una **ventana de pregunta rápida con un atajo** sobre cualquier app, además de su ánimo y las aprobaciones en el menú de la bandeja. [El plan](docs/design/NEW_LOOK.md) |
| **2.5** · El nuevo aspecto, parte 1 | **Oscuro por defecto y su trabajo a la vista:** una línea bajo cada respuesta muestra lo que hizo, los resultados llegan como tarjetas (tiempo, tareas, archivos cambiados, pruebas, búsquedas), un chat más ligero en el móvil y el ordenador, y las apps de Windows y Mac dibujan la página hasta la barra de título. [El plan](docs/design/NEW_LOOK.md) |
| **2.4** · Todo en orden | **Todo más fácil de encontrar:** una barra lateral corta con un menú *Más* desde el que fijar lugares, Ajustes con encabezados de verdad que se pliegan, herramientas y aprobaciones explicadas con palabras sencillas, fotos que puedes borrar del álbum de recuerdos, pantallas y menús más ordenados en todas las apps y un guardado más seguro por dentro. [Qué ha cambiado](CHANGELOG.md) |

</details>

<details>
<summary><b>Versiones anteriores: de la 1.1 a la 2.3</b> (documentos grandes, SSH, Alexa y Google Home, modo hogar, momentos, videollamadas, varios servidores, modo local privado, chats de grupo, mudarte desde otras apps…)</summary>

| Versión | Qué te trae |
|---|---|
| **2.3** · Documentos grandes | **Libros y manuales de 500 a 1.000 páginas** (PDF de hasta 1 GB) en su biblioteca: subidas que se reanudan, cada página escaneada leída, índice y resúmenes por capítulo, y respuestas que citan la página («p. 412») con un enlace directo. 30 de 30 preguntas bien en un libro de prueba de 1.000 páginas. [Cómo funciona](docs/LIBRARY.md) |
| **2.2** · Tus otros servidores por SSH | **Puede trabajar en tus otras máquinas** con contraseña o con clave. Tras iniciar sesión con contraseña **crea su propia clave, te dice dónde está y olvida la contraseña** (solo la guarda si insistes, tras avisarte). Se comprueban las claves del servidor, cada comando sigue sus reglas de aprobación y puedes revocar su clave cuando quieras. [Cómo funciona](docs/SSH.md) |
| **2.1** · Su voz en tu casa | **«Alexa, abre sara companion»**: habla con ella en cualquier Echo con tu propia skill gratuita (verificada como exige Amazon). Hazla tu **asistente de Android** (mantén pulsado inicio), escúchala en altavoces **Google Home / Nest** a través de Home Assistant y deja que **te salude al llegar a casa**. Siri en el iPhone llega con la próxima actualización de la app. [Cómo funciona](docs/VOICE_ASSISTANTS.md) |
| **2.0** · Modo hogar | **Comparte tu servidor de Sara con las personas con las que vives.** Invita a un adulto con un enlace de un solo uso; tendrá sus propias compañeras, chats, memoria, biblioteca y apps en un espacio propio. Tú sigues siendo el administrador: eliges qué modelos usa, pones límites diarios y ves el uso y el coste, nunca lo que dice. [Cómo funciona](docs/HOUSEHOLD.md) |
| **1.10** · Nuestros momentos | **Un álbum de fotos compartido** con tus fotos y las que ella envía, cada una con un pie de foto que escribe con su propia voz a partir de lo que hablabais. Álbumes que se llenan solos (Nosotros, Lugares, Sus looks), «Tal día como hoy», y a veces saca uno: *¿te acuerdas?* Los chats privados quedan fuera salvo que los añadas. [Cómo funciona](docs/MOMENTS.md) |
| **1.9** · Videollamadas | **Mírala mientras habláis:** una videollamada muestra su retrato en movimiento a pantalla completa, con los labios al ritmo de su voz y la cara siguiendo su ánimo, con su ropa y lugar actuales. Activa tu cámara si quieres y ella mira cada pocos segundos (o cuando pulsas *Mira esto*); no se graba nada. [Cómo funciona](docs/VIDEO_CALLS.md) |
| **1.8** · Varios servidores en una app | Ten **todas tus Saras en una sola app** (casa y trabajo, o varias en un servidor) y cambia desde un menú sin cerrar sesión: las apps de Windows y Mac, Android y iPhone, VS Code, `sara-chat` y el puente MCP. Cada una conserva su propio inicio de sesión; los archivos, el micrófono y la cámara solo van a la que estás usando. [Cómo funciona](docs/SERVERS.md) |
| **1.7** · Modo local privado | Un interruptor, **Nada sale de este ordenador**, aplicado en el código en un único punto: solo se puede llegar a este ordenador, los modelos en la nube y las herramientas en línea se pausan, y sus chats, su memoria y su biblioteca siguen funcionando. Las apps de Windows y Mac encuentran Ollama (o te ayudan a instalarlo), sugieren un modelo que cabe en tu tarjeta gráfica y lo descargan con barra de progreso. [Qué garantiza](docs/PRIVATE_LOCAL.md) |
| **1.6** · Chats de grupo | Reúne a **de dos a cuatro de tus compañeras en una conversación**: cada una responde con su propia personalidad, voz y color; elige quién contesta (quien encaje, todas, por turnos o solo a quien menciones con @) y cuánto charlan entre ellas. La seguridad, los avisos de IA y el ajuste adulto más estricto valen para toda la sala. [Cómo funciona](docs/GROUP_CHATS.md) |
| **1.5** · Tráela desde otra app | Múdate desde **ChatGPT, Claude, Character.AI, SillyTavern, Replika, Nomi o Kindroid**. Lee la exportación en tu propio servidor, luego te enseña lo que ha aprendido (datos con tus propias palabras, vuestra historia juntos, su estilo) y solo guarda lo que tú apruebes. [Cómo exportar desde cada app](docs/IMPORT.md) |
| **1.4** · Más fluidez | Mira cómo cada archivo que escribe **crece en directo en el chat** mientras el modelo lo transmite (OpenAI, Anthropic, xAI, OpenRouter y planes de ChatGPT; Ollama lo envía de una vez); un retrato que habla con sincronización labial de nueve formas de boca; registros en texto plano o JSON |
| **1.3** · Comprobaciones más listas | Su comprobación de "¿de verdad hizo lo que dice?" ya funciona en los seis idiomas; un modelo local pequeño y opcional como juez sube lo que detecta del 38 % al **88 %** con un 95 % de precisión ([medido](docs/RESULTS.md)) |
| **1.2** · Todo en tu idioma | Toda la app, la guía de ayuda y los mensajes de su servidor en English, Español, Français, Deutsch, Português (Brasil) e Italiano |
| **1.1** · Instálala donde quieras | Configura un servidor nuevo en el navegador con un código corto; una imagen de Docker también para **ARM** (Raspberry Pi 4/5); Homebrew, Unraid, TrueNAS, Proxmox y Home Assistant (HACS) |

</details>

<!-- sara:release-history:end -->

Todas las versiones: [CHANGELOG.md](CHANGELOG.md) · [versiones](https://github.com/farena-ai/sara/releases).

### Lo que viene

Consulta el [plan público](docs/ROADMAP.md) para el trabajo pendiente y [Discussions](https://github.com/farena-ai/sara/discussions) para proponer ideas. Los espacios empresariales ya están disponibles; validarlos con tu dominio, personas reales y una prueba de recuperación es un paso aparte. En iPhone, usa la [app web en la pantalla de inicio](docs/PHONE.md).

## Para desarrolladores

<img src="docs/images/brand/sara-for-developers.webp" alt="Ilustración: Sara en un banco de trabajo encajando piezas de puzle luminosas y engranajes de latón en una pequeña máquina" width="860">

Pequeña y legible: TypeScript que Node ejecuta directamente, sin paso de compilación, cero dependencias en tiempo de ejecución, construida desde cero (no está basada en Hermes Agent ni en OpenClaw).

| Quieres… | Empieza por |
|---|---|
| Ver cómo encaja todo | [Arquitectura](docs/ARCHITECTURE.md), módulo a módulo (diagrama abajo) |
| Añadir una herramienta, un puente, un personaje, un servidor MCP, un idioma, un proyecto inicial o un proveedor de modelos | [Ampliar Sara](docs/EXTENDING.md) |
| Escribir un plugin o una habilidad | [Plugins](docs/PLUGINS.md) (`sara-plugin.json`, hooks, procesos aislados) · [Habilidades](docs/SKILLS.md) (el formato abierto Agent Skills) · [Publicar en la Store](docs/STORE.md) |
| Llamar a Sara desde tu propio código | [Otras apps](docs/OTHER_APPS.md): API compatible con OpenAI y servidor MCP · [Otros agentes (A2A)](docs/A2A.md) · [Webhooks](docs/WEBHOOKS.md) |
| Comprobar las cifras | [Resultados](docs/RESULTS.md): pruebas y evaluaciones, y cómo repetirlas |
| Contribuir | [CONTRIBUTING.md](CONTRIBUTING.md) · [Incidencias para empezar](docs/GOOD_FIRST_ISSUES.md) · [Traducir](docs/TRANSLATING.md) · [Política de seguridad](SECURITY.md) |

### Cómo encaja todo

<img src="docs/architecture.svg" alt="Architecture: apps and bridges talk to one Sara server; each turn passes the always-on safety layer, gathers memory and library context, calls the chosen model provider and runs tools in a sandboxed workspace; data stays in one folder on your server" width="860">

Más en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Probada, con resultados publicados

Todo lo que sigue se ejecutó de verdad; los scripts están en el repositorio, así que puedes
repetirlos con tus propios modelos. Fechas, configuración y archivos de resultados:
**[docs/RESULTS.md](docs/RESULTS.md)**.

| Prueba | Modelo | Resultado | Fecha |
|---|---|---|---|
| [HumanEval](https://github.com/openai/human-eval), con su bucle de agente (164 problemas, pruebas ocultas) | qwen3.8 27B, local | **158/164** (pass@1 96,3 %) | 2026-10-27 |
| HumanEval, el mismo modelo sin herramientas (referencia) | qwen3.8 27B, local | **161/164** (pass@1 98,2 %) | 2026-10-27 |
| Tareas de repositorio: 14 correcciones, funciones y refactorizaciones originales en varios archivos (pruebas ocultas), con su bucle de agente | qwen3.8 27B, local | **11/14** (en ambas ejecuciones) | 2026-10-28 |
| Tareas de repositorio, el mismo modelo con todos los archivos en un solo mensaje y sin herramientas (referencia) | qwen3.8 27B, local | **12/14** (en ambas ejecuciones) | 2026-10-28 |
| Proyectos de tamaño real: 3 proyectos originales de 22 a 36 archivos (pruebas ocultas), con su bucle de agente | qwen3.8 27B, local | **2/3**, luego **3/3** | 2026-10-28 |
| Proyectos de tamaño real, el mismo modelo con todos los archivos en un solo mensaje y sin herramientas (referencia) | qwen3.8 27B, local | **3/3** (en ambas ejecuciones) | 2026-10-28 |
| Comprobación de lo que dice haber hecho, en 6 idiomas (240 respuestas reservadas): solo patrones → con un juez local | qwen3.5 9B, local, como juez | detecta **38 % → 88 %**, precisión 92 % → 95 % | 2026-10-28 |
| Memoria entre sesiones (recordar, no inventar, olvidar) | qwen3.8 27B, local | **11/12** comprobaciones | 2026-10-27 |
| Biblioteca: responde a partir de documentos y dice de dónde | qwen3.8 27B, local | **8/8** en ambas ejecuciones | 2026-10-27 |
| Mapa del código: preguntas sobre su propio código | qwen3.8 27B, local | **8/8** | 2026-10-27 |

La lectura honesta: su bucle de agente todavía no suma puntos en ninguna de las dos pruebas de
programación. El modelo solo ya resuelve casi todos los problemas cortos de HumanEval, y las 14
tareas de repositorio son lo bastante pequeñas (de 5 a 7 archivos) como para pegarlas enteras en un
mensaje (igual que los tres proyectos de tamaño real, de menos de 1100 líneas); los fallos de ambos modos fueron reglas escritas solo en un README o SPEC que ninguna
prueba comprobaba. Lo que aporta hoy es la forma de trabajar (ejecuta las pruebas, pide permiso
antes de pasos arriesgados, muestra lo que se ejecutó), no una puntuación más alta en estos
conjuntos. Detalles, resultados por tarea y cómo repetirlo: [docs/RESULTS.md](docs/RESULTS.md).

<details>
<summary><b>Validación de versiones</b>: 2.69.0, 2.67.0 y 2.65.0</summary>

Verificación del código de 2.69.0: comprobación de tipos y **3033 pruebas automatizadas**; Windows **3017 aprobadas / 0 fallos / 16 omitidas**, Linux **3018 aprobadas / 0 fallos / 15 omitidas**, más trece recorridos aislados del navegador en escritorio y móvil. Los paquetes reales de Windows y Mac, este último firmado y notarizado, superaron sus perfiles de recuperación y regresión y las pruebas de complementos; las imágenes de contenedor de ambas arquitecturas superaron las comprobaciones de estado; Windows no está firmado. Estas comprobaciones usan datos sintéticos y modelos simulados. La ejecución física en Intel/Rosetta, la aceptación en dispositivos y lectores de pantalla, el tono natural con modelos reales y la recuperación de producción requieren comprobaciones aparte.

Validación de 2.67.0 (5 de noviembre de 2026): comprobación de tipos y 2632 pruebas automatizadas; Windows **2616 aprobadas / 0 fallos / 16 omitidas**, Linux **2617 aprobadas / 0 fallos / 15 omitidas**. Los paquetes reales de Windows, Mac y ambas arquitecturas de contenedor superaron la recuperación cifrada, 12 casos de revalidación de permisos y 286 regresiones E2 cada uno, con hashes de contenido coincidentes. El paquete universal de Mac está firmado y notarizado; Windows no está firmado. Se usan datos sintéticos y modelos simulados. La ejecución física en Intel/Rosetta, la aceptación en dispositivos y lectores de pantalla, el tono del modelo real y la recuperación de producción requieren comprobaciones aparte.

Evidencia de la versión anterior — Validación de **2.65.0**: comprobación de tipos y 2.153 pruebas automatizadas con un modelo simulado (sin llamadas a proveedores): **2.137 correctas / 0 fallos / 16 omitidas en Windows** y **2.138 correctas / 0 fallos / 15 omitidas en Linux**. Son comprobaciones de ingeniería, no una garantía para cada modelo o instalación.

</details>

### Contribuir

Las contribuciones son bienvenidas. Empieza por [CONTRIBUTING.md](CONTRIBUTING.md) y las
[incidencias para empezar](docs/GOOD_FIRST_ISSUES.md); sigue el
[código de conducta](CODE_OF_CONDUCT.md) e informa de los problemas de seguridad en privado, como
se explica en [SECURITY.md](SECURITY.md).

```sh
npm ci
npm run dev        # http://127.0.0.1:7860, restarts on save
npm run check      # typecheck + all tests
```

## Cómo se compara Sara

Una comparación general con los tipos de alternativas habituales (cada producto es distinto):

| | Sara | Apps de compañía con IA alojadas | CLIs y agentes de programación | Interfaces de chat autoalojadas |
|---|:-:|:-:|:-:|:-:|
| Funciona en tu propio ordenador o servidor | ✅ | ❌ | ✅ | ✅ |
| Usa cualquier modelo, también locales | ✅ | ❌ normalmente el suyo | depende | ✅ |
| Personalidad y memoria duraderas que puedes ver y editar | ✅ | ✅ | ❌ | depende |
| Escribe, ejecuta y prueba código, pide permiso antes de pasos arriesgados | ✅ | ❌ | ✅ | depende (complementos) |
| Agenda, recordatorios, documentos, llamadas de voz | ✅ | algunas | ❌ | algunas |
| Apps móviles, Telegram y Discord | ✅ | apps móviles | ❌ | depende |
| Trae tus chats de otras apps de compañía, revisados antes de guardarlos | ✅ | ❌ normalmente | ❌ | depende |
| Toda la app en seis idiomas | ✅ | depende | depende | depende |
| Capa de seguridad que ningún ajuste puede desactivar | ✅ | sus propias normas | n/a | normalmente no |
| Precio | gratis (MIT); pagas tus modelos | suscripción | depende | normalmente gratis |

## Instalación

**Servidor Linux** (Debian/Ubuntu, Fedora/RHEL/Alma/Rocky, Arch, openSUSE), un solo comando que
hace unas pocas preguntas sencillas (pulsa Intro para aceptar la sugerencia):

```sh
curl -fsSL https://raw.githubusercontent.com/farena-ai/sara/main/deploy/get-sara.sh | sudo bash
# it ends with the address to open and your one-time owner token
sudo sara status
```

**Docker:**

```sh
git clone https://github.com/farena-ai/sara && cd sara
sudo docker compose up -d                       # or: sudo docker compose --profile ollama up -d  (with a local Ollama)
sudo docker compose logs sara | grep -A1 'owner token'   # o: abre su página e introduce el código de configuración de este registro
```

**Tiendas de apps y NAS:** la imagen `ghcr.io/farena-ai/sara` (amd64 y ARM),
`brew install --cask farena-ai/tap/sara`, TrueNAS, Proxmox y HACS (como repositorio personalizado)
funcionan ya; Unraid está aprobado, y winget, CasaOS/ZimaOS, Umbrel y la lista de la tienda de HACS
esperan revisión
([cuál es cuál](docs/INSTALL.md#other-ways-to-install)). Un servidor nuevo se configura en el
navegador con un código corto de su registro (en Umbrel, con un clic).

**Windows y macOS:** descarga `Sara-Setup-<version>.exe` o `Sara-<version>.dmg` de la
[página de versiones](https://github.com/farena-ai/sara/releases/latest). La primera pregunta:
ejecutar Sara en este ordenador (su servidor y la app de escritorio juntos) o conectarte a una
Sara que está en otro sitio (solo la app).

**Móviles:** la [app de Android](https://play.google.com/store/apps/details?id=com.backstagecoding.sara) está en Google Play; vincúlala escaneando el código QR en
Ajustes → Datos y salud → Dispositivos e inicio de sesión → Añadir un teléfono u ordenador. En iPhone, añade Sara a tu pantalla de inicio desde Safari ([guía del móvil](docs/PHONE.md)).

**Desde el código fuente** (cualquier ordenador con Node 24 o superior):

```sh
git clone https://github.com/farena-ai/sara && cd sara
npm ci
npm start                                       # http://127.0.0.1:7860; the token is in the output
```

Entra con el token (o el código de configuración) y una
guía de configuración te pregunta tu nombre, te ayuda a dar forma a tu compañera y conecta un
modelo. Cómo llegar a ella desde el móvil (Tailscale, tu propia dirección web con HTTPS o tu red
de casa), actualizaciones, copias de seguridad y solución de problemas:
**[docs/INSTALL.md](docs/INSTALL.md)**.

### El día a día

```sh
sudo sara status       # is she running, last backup
sudo sara update       # backs up, updates, restarts
sudo sara backup       # back up now
sudo sara restore FILE # restore a backup
sudo sara access       # how you reach her (change: tailscale, local, domain, lan)
```

## Documentación

| | |
|---|---|
| [Start here](docs/START_HERE.md) · [For coders](docs/FOR_CODERS.md) · [How do I…?](docs/HOW_DO_I.md) · [Videos](docs/VIDEOS.md) | Los primeros diez minutos, para compañía o para programar; todas las respuestas de los cuadros de ayuda; los vídeos |
| [Today](docs/TODAY.md) · [Chat commands](docs/CHATS.md) · [Report a problem](docs/SUPPORT.md) | Tu pantalla de inicio; `/new`, `/status` y compañía en cada chat; ayuda desde dentro de Sara |
| [Instalación](docs/INSTALL.md) | Linux, Docker, Windows, macOS, HTTPS, actualizaciones, solución de problemas |
| [¿Qué ordenador necesito?](docs/REQUIREMENTS.md) · [Elegir un modelo](docs/CHOOSING_A_MODEL.md) · [Lo que cuesta](docs/COSTS.md) | Antes de empezar: hardware, modelos con tamaños de GPU, costes de uso |
| [Tu móvil](docs/PHONE.md) · [Mudarse a otro ordenador](docs/MOVING.md) | Configurar el móvil de principio a fin; copia, instalación y restauración |
| [Lista de seguridad](docs/SECURITY_CHECKLIST.md) · [Qué sale de tu servidor](docs/PRIVACY.md) | Cinco minutos después de instalar; cada conexión saliente y cómo desactivarla |
| [Preguntas frecuentes y glosario](docs/FAQ.md) | Preguntas habituales y qué significan las palabras |
| [Apps y clientes](docs/clients.md) · [Apps de escritorio](docs/desktop.md) · [Home Assistant](docs/HOME_ASSISTANT.md) | Terminal, VS Code, Windows y macOS; Sara en Home Assistant y Home Assistant en Sara |
| [Otras apps](docs/OTHER_APPS.md) · [Tráela desde otra app](docs/IMPORT.md) | API compatible con OpenAI (SillyTavern, Open WebUI, scripts), MCP (Claude Code, Cursor, Claude Desktop), tarjetas de personaje; importar chats de Character.AI, SillyTavern, Replika, Nomi, Kindroid, ChatGPT o Claude |
| [Varias Saras en una app](docs/SERVERS.md) · [Modo local privado](docs/PRIVATE_LOCAL.md) · [Modo hogar](docs/HOUSEHOLD.md) | Cambiar de servidor; tenerlo todo en un ordenador; compartir un servidor con las personas con las que vives |
| [Chats en grupo](docs/GROUP_CHATS.md) · [Videollamadas](docs/VIDEO_CALLS.md) · [Nuestros momentos](docs/MOMENTS.md) · [Documentos grandes](docs/LIBRARY.md) | Varias compañeras en un chat; llamadas con su retrato en movimiento; el álbum compartido; libros de 1.000 páginas en su biblioteca |
| [Asistentes de voz](docs/VOICE_ASSISTANTS.md) · [Alexa](docs/ALEXA.md) · [Servidores por SSH](docs/SSH.md) · [Paquetes](docs/PACKAGING.md) | Alexa, asistente de Android, Google Home, Siri; trabajar en tus otros servidores; Homebrew, winget, Unraid y los demás |
| [Ampliar Sara](docs/EXTENDING.md) | Añadir herramientas, puentes, personajes, servidores MCP, idiomas, proyectos iniciales |
| [Arquitectura](docs/ARCHITECTURE.md) | Cómo encajan las piezas, módulo a módulo |
| [Resultados](docs/RESULTS.md) | Pruebas y evaluaciones, y cómo repetirlas |
| [Traducir](docs/TRANSLATING.md) | La app en tu idioma |
| [Cumplimiento](docs/COMPLIANCE.md) · [Modelo de amenazas](docs/THREAT_MODEL.md) · [Avisos](docs/DISCLOSURES.md) | Seguridad, protección y lo que hay que saber primero |
| [Hoja de ruta](docs/ROADMAP.md) · [Registro de cambios](CHANGELOG.md) · [Versiones](https://github.com/farena-ai/sara/releases) | Hacia dónde va y qué ha cambiado |
| [Espacios empresariales](docs/BUSINESS.md) · [Operación empresarial](docs/BUSINESS_OPERATIONS.md) | [Recuperación](docs/RECOVERY.md) · [Operación](docs/OPERATIONS.md) |
| [Recorrido por las funciones](docs/FEATURES.md) | Cada área con capturas reales |

Todo esto también se convierte en un pequeño sitio web con búsqueda y modo oscuro:
`node scripts/build-docs.ts` lo escribe en `outputs/site/` (abre `index.html`; está listo para
GitHub Pages).

## Confianza, seguridad y aspectos legales

- **Sara es una IA.** Lee los [avisos](docs/DISCLOSURES.md) antes de usarla o compartirla; la nota al principio de esta página dice qué se queda en tu ordenador y qué va a los proveedores que elijas.
- **Seguridad, siempre activa.** Las acciones arriesgadas esperan tu permiso: en el chat, en su panel o como aviso con Permitir / Denegar en las apps de Windows y Mac. La capa de seguridad funciona en el código alrededor de cada llamada al modelo y **no se puede desactivar**: aviso de que es una IA al principio y de forma periódica, una respuesta honesta siempre que se le pregunte en serio si es una IA, recursos de ayuda en crisis y un bloqueo total del contenido sexual con menores ([docs/COMPLIANCE.md](docs/COMPLIANCE.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)). Copias de seguridad diarias (y copias cifradas fuera del servidor), restauración y actualización con un solo comando, y `sara doctor` la mantienen en forma.
- **El contenido para adultos** está detrás del interruptor **Modo adulto** (Ajustes → Tú → Modo adulto), desactivado por defecto. Para activarlo hace falta confirmar tú mismo «Tengo 18 años o más» en un navegador web; es una confirmación que da el propietario, no una verificación de identidad ([cumplimiento](docs/COMPLIANCE.md#adult-content)).
- **Qué sale de tu servidor:** cada conexión saliente y cómo desactivarla, incluida la pequeña señal anónima diaria que puedes apagar: [docs/PRIVACY.md](docs/PRIVACY.md). Cinco minutos después de instalar: la [lista de seguridad](docs/SECURITY_CHECKLIST.md).
- **Problemas de seguridad:** infórmalos en privado, como se explica en [SECURITY.md](SECURITY.md).

## Licencia

MIT, consulta [LICENSE](LICENSE). Créditos de las piezas que Sara descarga o usa:
[docs/CREDITS.md](docs/CREDITS.md).

---

**Hazla tuya.** [Descarga Sara](https://github.com/farena-ai/sara/releases/latest), sigue la [guía de instalación](docs/INSTALL.md) y pulsa **Star** arriba en [este repositorio](https://github.com/farena-ai/sara) si te gusta el proyecto. Puede que su lenguaje del amor sean las estrellas de GitHub.
