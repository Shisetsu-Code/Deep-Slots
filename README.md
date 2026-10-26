# Deep-Slots

Servidor MCP para **QA de slots de casino en modo demo (dinero ficticio)**. Trabaja en
tres niveles de costo, del más barato al más caro:

| Vía | Qué usa | Cuándo |
| --- | --- | --- |
| **Protocolo** (`elk_*`) | XML del capi de Elk por HTTP POST | El juego expone un transporte directo. Sin navegador, sin píxeles. |
| **HAR** (`har_*`) | Capturas `.har` ya existentes | Para descubrir endpoints, contratos, betlevels y derivar la ficha del adaptador. |
| **Navegador** (`slots_*`) | Playwright + DOM o árbol del motor Cocos | Solo cuando no hay transporte directo (canvas, modales, gates). |

**Alcance:** observación y automatización como un jugador. No altera el RNG, no
modifica respuestas del servidor, no extrae resultados futuros y no resuelve captchas.
Los identificadores de sesión y los HAR no se publican.

---

## Instalación

```powershell
npm ci
npm run build
```

Registro en OpenCode (`~/.config/opencode/opencode.json`):

```jsonc
{
  "mcp": {
    "servers": {
      "deep-slots": {
        "type": "local",
        "command": ["node", "<ruta>\\Deep-Slots\\dist\\index.js"],
        "cwd": "<ruta>\\Deep-Slots",
        "environment": { "SLOTS_CONFIG": "<ruta>\\Deep-Slots\\slots.config.json" }
      }
    }
  }
}
```

Después de recompilar, usa `/reload` en OpenCode para que tome el `dist` nuevo.

## Configuración (`slots.config.json`)

Se recarga en caliente (`slots_config`). Variables de entorno equivalentes:
`SLOTS_URL`, `SLOTS_HEADLESS`, `SLOTS_CHANNEL`, `ELK_ORIGIN`, `ELK_GAME_ID`,
`ELK_OPERATOR_ID`, `ELK_CURRENCY`, `ELK_CLIENT_VERSION`, `ELK_ECF_VERSION`.

| Campo | Para qué sirve |
| --- | --- |
| `url` | URL del demo para la vía navegador |
| `browser.channel` | `"msedge"`, `"chrome"` o `null` (autodetecta) |
| `browser.headless` | `false` para ver la ventana |
| `selectors.*` | Spin, apuesta, saldo, canvas (si se omiten, se buscan por rol/texto) |
| `network.spinEndpoint` | Regex de la respuesta que representa un giro |
| `spin.settleMs` / `timeoutMs` | Espera de animación / timeout del giro |
| `elk.origin` | Host del capi (default `https://gc5-stage.contentmedia.eu`) |
| `elk.gameId` | `gameid` por defecto para `elk_init` |
| `elk.operatorId` | `opid` demo (default `44`) |
| `elk.clientVersion` / `ecfVersion` | Cabeceras que Elk exige (`X-CLIENT-VERSION`, `X-ECF-VERSION`) |

---

# Elk Studios: capi XML

Elk no tiene `/spin`. Todo pasa por **un solo endpoint** y el campo `bmode` decide
qué se compra:

```text
POST https://gc5-stage.contentmedia.eu/capi/{gameId}/play/{op}
Content-Type: text/xml; charset=utf-8
X-CAPI-VERSION: 2.0
X-CAPI-RID: <epoch><rand>:1
X-CLIENT-VERSION: <build del game.js>     # el servidor exige la cabecera, no un valor exacto
X-ECF-VERSION: <build del shell>          # ecf2 (juegos viejos) y ecf3 sirven el mismo build
Origin/Referer: https://static-stage.contentmedia.eu
```

| Op | Request | Para qué |
| --- | --- | --- |
| `init` | `opid`, `extsession`, `cur`, `desktopmode`, `lang`, `screenres`, `extjur` | Abre sesión y declara betlevels, bmodes, RTP, maxwin, features, `minspindelay` |
| `purchase` | `gamesession`, `amount`, `cur`, `betdetails`, `betlevel`, `pmode`, `orientation`, `sound`, `monetaryunit`, `gamespeed` (+ `bmode` y `variant` cuando el juego los declara) | **Giro normal** con `bmode=DEF`; **feature buy** con `X01..X05` |
| `claim` | igual que `purchase` + `bmode` | Acepta una oferta/ronda pendiente |
| `reject` | `gamesession`, `temporary` | Rechaza la oferta pendiente |
| `checkwin` | `roundid`, `gamesession` | Cierra la ronda y confirma el saldo |
| `sessionupdate` | `gamesession` | Latido / reality check |
| `replay` | `gamesession`, `roundid` | Recupera una ronda |
| `fetchbalance` / `saveround` | `gamesession` (+ `roundid`) | Solo modo real en el cliente |

### `bmode` colapsa la matriz de cobertura

En Cluster Kingdom (`gameId 10222`, RTP 94 %) el init declara 12 betlevels y:

| bmode | Multiplicador | Compra |
| --- | --- | --- |
| `DEF` | 1x | giro normal |
| `X01` | 3x | feature buy |
| `X02` | 10x | feature buy |
| `X03` | 50x | feature buy |
| `X04` | 100x | feature buy |
| `X05` | 500x | feature buy |

Pirots 5 (`10266`, RTP 96 %) usa la misma estructura pero **`X05 = 250x`** y declara
cuatro variantes (`boss`, `nest`, `ship`, `temple`) que hay que mandar como
`variant` en `purchase`. Por eso la ficha se deriva del `init` y del HAR, no de una
tabla fija.

### Dos reglas que cuestan un errorcode=1

Las aprendimos midiendo los 158 juegos, no leyendo documentación:

1. **`bmode` solo si `init` lo declara.** El shell real (`ecf2`/`ecf3`, build
   369146) monta `purchase` así:

   ```text
   this.bb ? <request … bmode="DEF" …/> : <request … />   // this.bb = betlevels bmode="true"
   ```

   En los 42 juegos sin feature buys (`betlevels bmode="false"`, gameId 10007–10139)
   mandar `bmode="DEF"` devuelve `errorcode=1 General technical error` y, además,
   **puede descontar la apuesta sin abrir ronda**. El adaptador omite el atributo
   cuando el juego no lo declara.

2. **`variant` solo si `init` declara `<variants>`.** Solo 4 juegos (6 slugs) lo
   hacen: Pirots 4 / Inferno / Frozen Fury (`fire, ice, space`), Pirots 5
   (`boss, nest, ship, temple`), Wild Toro 3 (`day, night`) y Huff N Puff Collectr
   (`garden, springbreak`). Sin `variant`, `purchase` da `errorcode=1`. Las
   variantes sin paytable (cero `<SYMBOL>`) no son jugables —`boss` de Pirots 5— y
   también descuentan saldo al rechazarlas: el adaptador elige la primera jugable y
   valida la que le pases.

   ```text
   elk_init  gameId="10266"                 -> declared.variants = boss, nest, ship, temple
   elk_spin  betlevel=4                     -> usa nest (primera jugable)
   elk_spin  betlevel=4 variant="temple"    -> fija temple para la sesión
   ```

### Contabilidad y replay

`purchase` devuelve el débito y el guion completo de la ronda:

```xml
<roundinfo>
  <betamount>1.00</betamount><winamount>40.00</winamount>
  <balanceafterwin>5039.00</balanceafterwin>
</roundinfo>
<game><pubdata><![CDATA[
  <PURCHASE clientseed="41bd…" revision="226461" bmode="DEF" win="4000">
    <RESULT mode="BASE" resultIndex="0">
      <SCOPE><REELSET reels="…"/></SCOPE>
      <ACTIONS><ACTION name="drop"/><ACTION name="evaluate"/></ACTIONS>
    </RESULT>
  </PURCHASE>
]]></pubdata></game>
```

La validación que aplica el adaptador en cada ronda:

```text
saldo_after_purchase = saldo_antes − apuesta
saldo_after_checkwin  = saldo_antes − apuesta + premio
```

Si el operador acredita en `purchase`, también se acepta. Cualquier otra diferencia
marca `validated: false` y `elk_run` corta con `balance-mismatch`. `clientseed` +
`revision` + `RESULTS/ACTIONS` permiten re-simular la ronda sin navegador.

### Pacing

`init` devuelve `minspindelay` (1200 ms). `elk_spin`/`elk_run` lo respetan desde el
fin de la llamada anterior; durante una ronda el servidor lo baja a 0. `extraDelayMs`
agrega margen anti-429. **`purchase` y `claim` no se reintentan**: no son idempotentes
y un 5xx podría abrir dos rondas o cobrar dos veces.

### Flujo

```text
elk_init gameId="10222"                 -> sesión + ficha + tabla de apuestas
elk_bets betlevel=4                     -> DEF=1.00 X01=3.00 … X05=500.00
elk_spin betlevel=4 bmode="DEF"         -> un giro + checkwin + validación + replay
elk_run  spins=100 betlevel=1 bmode=DEF -> RTP observado, hits, mismatches
elk_call op="sessionupdate"             -> contrato crudo para lo que falte
```

Para un juego con variante:

```text
elk_init gameId="10266" variant="nest"    # opcional: fija la variante de la sesión
```

`elk_card` devuelve la **ficha de capacidad** (BSF): transporte, cabeceras, ops,
apuestas, RTP/maxwin declarados, features, pacing, replay y validación. Incluye una
`familyKey` estable, por ejemplo:

```text
elk-capi-v2|betlevels=12|bmodes=DEF,X01,X02,X03,X04,X05|rtp=0.94|maxwin=1000000|features=…|variant=default
```

Los 158 juegos Elk del catálogo comparten ese contrato: un adaptador, no 158.

### Cobertura medida (`scripts/elk-catalog-sweep.mjs`)

El script mapea `slug -> gameid` con **un solo GET** al listado público de ELK
(158 tarjetas, evita los `429` del WordPress) y luego hace `init`; con `--spin`
hace además **un giro `DEF` de 0.20** por juego, lo cierra con `checkwin` y
valida la contabilidad ronda a ronda.

```text
node scripts/elk-catalog-sweep.mjs                    # contrato: 158 inits, ~16 s
node scripts/elk-catalog-sweep.mjs --spin             # + un giro por juego, ~88 s
node scripts/elk-catalog-sweep.mjs --spin --limit=6   # muestra
```

Resultado con el adaptador actual:

```text
init ok              158/158
giros ok + validados 158/158    descuadres 0
apostado 31.20 EUR   ganado 20.94 EUR (1 giro/juego, sin valor estadístico)
bmodes: 113 DEF+X01..X05 | 42 solo DEF | 2 DEF+BB1+BB2 | 1 DEF+BB1..BB4
variantes: pirots-4, pirots-5, wild-toro-3, huff-n-puff-collectr
rtp 0.94–0.964 | 12 betlevels | default 4 | minspindelay 1200 | MGA
```

El JSON completo (contrato + resultado del giro por juego) queda en
`.slots-artifacts/elk-sweep.json`.

---

# HAR: derivar el adaptador sin red

```text
har_summary path="captura.har"
har_api     path="captura.har" op="purchase"
har_import_elk paths=["a.har","b.har"]
har_find    path="captura.har" pattern="capi" bodyPattern="errorcode>[1-9]"
har_export  path="captura.har" pattern="capi"   -> JSON en .slots-artifacts
```

`har_import_elk` agrega varios HAR, deduplica rondas por `roundid` y devuelve por juego:

- `transport`: base URL, ops observadas, cabeceras `X-*`.
- `declared`: RTP, maxwin, HF, betlevels, bmodes con multiplicador, features, papi.
- `bets`: matriz `betlevel → { DEF, X01… }` con importes reales.
- `rounds`: apuesta, premio, débito, saldo de checkwin, seed, revision, results/actions.
- `balanceAudit`: rondas auditadas, OK y fallos.
- `familyKey` y `executionSupported`.
- `samples`: request/response representativas (redactadas).

Por defecto oculta `gamesession` y `playerhash`; los `clientseed` del replay se
conservan porque son evidencia, no credenciales.

---

# Navegador: DOM y Canvas

```text
OpenCode ──stdio──> Deep-Slots ──Playwright──> Chrome/Edge ──> demo
                        ├─ consola (incl. iframes)
                        ├─ red + cuerpos (JSON/texto/binario)
                        ├─ saldo/apuesta/ganancia (DOM o modelo del motor)
                        ├─ mapa Cocos → IDs clickeables
                        └─ artefactos: screenshots, trazas, JSONL
```

- Usa el Chrome/Edge instalado; `cdpUrl` se engancha a un Chrome ya abierto.
- Funciona con el juego dentro de iframes cross-origin.

## Flujo por coordenadas

```text
1. slots_map                  -> captura con cajas + coords.json
2. slots_click_id "bet-up"    -> click por ID guardado
3. slots_click_id "spin" waitForNetwork="/spin" settleMs=1200
4. slots_click_id "buy-bonus" autoConfirm=true
```

`drift` avisa si el texto bajo el punto cambió; `blockedBy` si un overlay tapa el
click. El mapa se valida por origen y por **huella de layout** (canvas, escala,
versión, IDs+bbox), no por URL: cada juego rota a un `m.<hash>.com` distinto.

## Canvas (Cocos Creator 2.x)

```text
1. slots_open
2. slots_probe         -> sceneNodes > 300 y balance numérico
3. slots_canvas_map    -> IDs spin/turbo/bet-up/autoplay/... + coords.json
4. slots_click_id "spin" waitForNetwork="/v4/Spin" settleMs=1500
5. slots_probe         -> saldo/apuesta/premio del modelo, no de la animación
```

`slots_probe` lee `currentBalance`/`targetBalance`/`winBalance`/`betAmount` y es la
fuente fiable para `saldo_final = saldo_inicial − apuesta + premio`. `slots_canvas_map`
traduce nodos a viewport con `designResolution` + escala y descarta lo no clickeable.

### Cuerpos binarios

`slots_network` con `includeBodies`, `bodySide` y `raw` devuelve:
`kind: "json"` → objeto; `text` → texto; `binary` → base64 completo + hex (256 B).
`slots_network_export` vuelca request+response a JSON.

---

## Herramientas

| Grupo | Herramienta | Uso |
| --- | --- | --- |
| Elk | `elk_init` | Abrir sesión y devolver ficha |
| | `elk_status` | Sesiones, saldo, RTP observado |
| | `elk_bets` | Matriz betlevel × bmode |
| | `elk_spin` | `purchase` + `checkwin` + validación + replay |
| | `elk_run` | N giros, RTP, mismatches |
| | `elk_settle` | Cerrar ronda pendiente |
| | `elk_card` | Ficha de capacidad (BSF) |
| | `elk_call` | Op cruda del capi |
| | `elk_close` | Cerrar sesiones |
| HAR | `har_summary` | Hosts, endpoints, builds, juegos |
| | `har_api` | Llamadas capi/papi con cuerpos |
| | `har_find` | Regex en URL y cuerpos |
| | `har_import_elk` | Ficha del adaptador desde HAR |
| | `har_export` | Exportar evidencia a JSON |
| Navegador | `slots_status` / `slots_open` / `slots_close` | Sesión |
| | `slots_discover` | Elementos y pistas de selectores |
| | `slots_map` / `slots_coords` / `slots_click_id` | Navegación por coordenadas |
| | `slots_canvas_map` / `slots_probe` | Motor Cocos |
| | `slots_buttons` / `slots_confirm` | Recortes de botones / modales |
| | `slots_screenshot` | Captura de página o canvas |
| | `slots_console` / `slots_network` / `slots_network_export` | Diagnóstico |
| | `slots_state` / `slots_click` / `slots_click_at` / `slots_set_bet` | Lectura y control |
| | `slots_spin` / `slots_run_session` | Giros y métricas |
| | `slots_wait` / `slots_eval` / `slots_config` | Utilidades |
| | `slots_trace_start` / `slots_trace_stop` | Traza Playwright |

## Analítica de `slots_run_session`

`rtp` observado, `hitRate`, `maxMultiplier`, `avgMultiplier`, `stdevMultiplier`,
`p95Multiplier`, `balanceStart/End`, `warnings`. Cada giro queda en
`.slots-artifacts/session-*.jsonl`.

> Con pocas tiradas el RTP tiene mucha varianza. Sirve como smoke test de integración,
> no como certificación matemática.

---

## Verificación

```powershell
npm test                      # unitarios: XML, sesión Elk, contabilidad, HAR
npm run smoke                 # handshake MCP y lista de 40 herramientas
node scripts/elk-live-check.mjs 10222 spin   # init + 1 giro real de 0.20
node scripts/elk-live-check.mjs 10266        # solo init (Pirots 5)
node scripts/elk-probe-headers.mjs 10222 263580   # comprobar que cabeceras X-* son obligatorias
node scripts/elk-probe-init.mjs 10222 263580      # init crudo con status y cabeceras de respuesta
node scripts/elk-har-check.mjs <a.har> <b.har>
node test/fixture-server.mjs  # demo local falso en :8787
node scripts/e2e.mjs
node scripts/coords-e2e.mjs
node scripts/canvas-e2e.mjs   # demo real de Super Golf Drive
```

`npm test` no toca la red: levanta un capi falso en `127.0.0.1` que reproduce
`init`/`purchase`/`checkwin`, incluido un modo que acredita mal el premio para probar
la detección de descuadres.

## Problemas típicos

| Síntoma | Causa / solución |
| --- | --- |
| `HTTP 400 X-CLIENT-VERSION not provided` | Faltan las cabeceras `X-CLIENT-VERSION` / `X-ECF-VERSION`; usa `elk_init` |
| `purchase errorcode=1` en un juego con variante | Pasa `variant` a `elk_init` (Pirots 5 = `nest`) |
| `bmode X05 no existe` | Ese juego no vende ese multiplicador; consulta `elk_bets` |
| `validated: false` | El saldo no cuadra: revisa `checkwin`, doble débito o premio mal acreditado |
| `spins` se corta con `insufficient-balance` | Sube el saldo demo o baja `betlevel` |
| No encuentra el botón de girar | `slots_discover`; el juego puede estar en iframe |
| Saldo mal leído | Ajusta `selectors.balance`; en canvas usa `slots_probe` |
| Click correcto pero no pasa nada | Overlay DOM (`blockedBy`) o presentación attract |
| `slots_click_id` dice "otro origen" | `coords.json` de otro juego: vuelve a mapear |

## Privacidad

- `.gitignore` excluye `*.har`, `data/`, `*.sqlite3`, `coords.json` y sesiones.
- Las tools `har_*` redactan `gamesession` y `playerhash` por defecto.
- Los HAR contienen credenciales de sesión demo: no se commitean ni se adjuntan.
