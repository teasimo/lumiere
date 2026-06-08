# E2E Test Structure (UI + Domain Interactions)

This project uses semantic `data-testid` attributes for stable Playwright selectors.

## Naming Convention

- Login scope: `login-*`
- Idea scope: `idee-*`
- Requirement viewer scope: `anforderungsviewer-*`
- Specification scope: `spezifikation-*`
- Pattern: `<scope>-<area>-<action>-<type>`

Examples:

- `login-submit-button`
- `login-error-banner`
- `idee-view-save-button`
- `idee-filter-apply-button`
- `anforderungsviewer-reload-button`
- `anforderungsviewer-settings-show-planned-obsolete-toggle`
- `spezifikation-page-create-button`
- `spezifikation-filter-apply-button`

## Struktur

- `tests/e2e/page-interactions/*.js`:
  - komponentennahe `data-testid`-Selectoren als `trigger`
  - abstrahierte `verb`-Definition
  - UI-State-Outcomes in `outcomes`
- `tests/e2e/domain-interactions/*.js`:
  - fachlich lesbare Orchestrierung mehrerer UI-Interactions
- Specs:
  - Testablauf und Assertions

## Zustand von Controls testen

Wenn ein Control einen Zustand hat (z. B. Drawer offen/geschlossen), wird dieser ueber `data-state` und bei Toggle-Buttons zusaetzlich ueber `aria-pressed` exponiert.

Beispiel (linker Bereich im Header):

```js
import { test, expect } from '@playwright/test'

test('left panel toggle exposes open/closed state', async ({ page }) => {
  const rootUrl = process.env.ROOT_URL || process.env.PLAYWRIGHT_ROOT_URL || 'http://127.0.0.1:5174/app'
  await page.goto(`${rootUrl}/anfo/ideen`, { waitUntil: 'networkidle' })

  const leftToggle = page.getByTestId('app-header-toggle-left-button')

  await expect(leftToggle).toHaveAttribute('data-state', 'open')
  await expect(leftToggle).toHaveAttribute('aria-pressed', 'true')

  await leftToggle.click()

  await expect(leftToggle).toHaveAttribute('data-state', 'closed')
  await expect(leftToggle).toHaveAttribute('aria-pressed', 'false')
})
```

Analog fuer Mobile-Menue:

- Button: `app-header-open-mobile-menu-button` (`data-state`, `aria-expanded`)
- Dialog: `app-mobile-menu-dialog` (`data-state`)

## Notifikationen testbar auslesen

Die App exponiert die letzte Notifikation zentral ueber `app-notification-probe`.
Damit koennen Tests sowohl auf den Inhalt als auch auf die Rueckmeldungsart reagieren.

Relevante Attribute:

- `data-feedback-kind`: `success | warning | error | info`
- `data-feedback-type`: Quasar-Typ (`positive | warning | negative | info`)
- `data-feedback-message`: letzte Meldung als Text
- `data-feedback-seq`: laufende Nummer (erhoeht sich bei jeder neuen Notifikation)

Beispiel:

```js
import { test, expect } from '@playwright/test'

test('reagiert auf Success-Notification nach Speichern', async ({ page }) => {
  const probe = page.getByTestId('app-notification-probe')

  const beforeSeq = Number(await probe.getAttribute('data-feedback-seq') || '0')

  // Aktion, die speichern ausloest
  // await byTestId(page, ...).click()

  await expect.poll(async () => Number(await probe.getAttribute('data-feedback-seq') || '0'))
    .toBeGreaterThan(beforeSeq)

  await expect(probe).toHaveAttribute('data-feedback-kind', 'success')
  await expect(probe).toHaveAttribute('data-feedback-message', /gespeichert|erstellt|aktualisiert/i)
})
```

Fuer weniger Boilerplate gibt es einen Helper in `tests/e2e/support/feedback-assertions.js`:

```js
import { runActionAndExpectFeedback } from './support/feedback-assertions.js'

await runActionAndExpectFeedback(
  page,
  async () => {
    await page.getByTestId('idee-view-save-button').click()
  },
  { kind: 'success' }
)
```

## UI + Domain Interaction Usage

```js
await ui.fill('login-username-input', 'Schulte')
await ui.fill('login-password-input', 'test')
await ui.action('login-submit-button')
```

Domain-Workflows kapseln zusammengesetzte Ablaeufe und rufen intern mehrere `ui.*`-Interaktionen auf.

## Recommendation

When adding new interactive controls in login, idea, requirement-viewer, or specification context, add matching `data-testid` and register corresponding UI-interactions in `page-interactions/*.js`.

## Tests ausfuehren

Alle Befehle werden im Ordner `frontend` ausgefuehrt.

```bash
cd frontend
```

Hinweis: Wenn weder `ROOT_URL` noch `PLAYWRIGHT_ROOT_URL` gesetzt ist, startet Playwright automatisch `VITE_MODULES=anfo` auf `127.0.0.1:5174`.
So laeuft das ANFO-Frontend lokal und nutzt den Vite-Proxy (`/vue/api`) zum Backend.

Standardmaessig laufen die E2E-Tests mit einem breiten Desktop-Viewport von `1920x1080`.

Empfohlene Modi:

- Docker/Nginx (Backend in Docker, direkt ueber Nginx): `ROOT_URL=http://localhost:8080/app`
- Lokaler Vite-Proxy (Frontend lokal, API via `/vue/api` Proxy): zuerst `npm run dev`, dann `ROOT_URL=http://localhost:5174/app`

Alle E2E-Tests starten:

```bash
npm run test:e2e
```

### Wie die Commands funktionieren

Die E2E-Skripte sind npm-Scripts aus `package.json`.
Alles, was hinter `--` steht, wird 1:1 an Playwright weitergereicht.

Grundmuster:

```bash
npm run <script> -- <playwright-argumente>
```

Beispiele:

```bash
# nur diese eine Spec ausfuehren
npm run test:e2e -- tests/e2e/idee-planungsanker-plaintext-regelwerk.spec.js

# nur Tests mit Namen-Match (grep)
npm run test:e2e -- -g "Case 3"

# Spec + grep kombinieren
npm run test:e2e -- tests/e2e/plaintext-editor-regelwerk.spec.js -g "Case 3"

# auf einen Browser einschränken
npm run test:e2e -- tests/e2e/idee-planungsanker-plaintext-regelwerk.spec.js --project=chromium

# ohne Video-Artefakte laufen lassen (schneller)
npm run test:e2e:no-video -- tests/e2e/idee-planungsanker-plaintext-regelwerk.spec.js

# nur auflisten, nicht ausfuehren
npm run test:e2e -- --list
```

Hinweise:

- Ohne `--` werden Playwright-Argumente nicht korrekt an das npm-Script uebergeben.
- `test:e2e:no-video` setzt intern `PW_VIDEO=off`.
- Fuer lokale Debug-Sessions ist `test:e2e:headed` praktisch, da der Browser sichtbar startet.

Nur eine bestimmte Spec-Datei starten (z. B. der Planungsanker-Flow):

```bash
npm run test:e2e -- tests/e2e/idee-planungsanker-plaintext-flow.spec.js
```

Nur einen einzelnen Testfall ueber den Testnamen starten (`-g` = grep auf den Testtitel):

```bash
npm run test:e2e -- -g "legt Idee und Spezifikation an"
```

Kombiniert: einzelne Spec + einzelner Testtitel in dieser Spec:

```bash
npm run test:e2e -- tests/e2e/idee-planungsanker-plaintext-flow.spec.js -g "Plaintext-Umsetzung"
```

Optional mit sichtbarem Browser:

```bash
npm run test:e2e:headed -- tests/e2e/idee-planungsanker-plaintext-flow.spec.js
```

Nur einen Browser testen (`--project`):

```bash
# Nur Chromium
npm run test:e2e -- --project=chromium

# Nur Firefox
npm run test:e2e -- --project=firefox

# Nur WebKit
npm run test:e2e -- --project=webkit
```

Kombiniert mit einzelner Spec:

```bash
npm run test:e2e -- tests/e2e/idee-planungsanker-plaintext-flow.spec.js --project=chromium
```

HTML-Report nach dem Lauf anzeigen:

```bash
npm run test:e2e:report
```

Der HTML-Report wird unter `frontend/test-results/html-report` abgelegt.

Playwright-Artefakte (Screenshots, Videos, Traces) werden unter `frontend/test-artifacts` abgelegt.

Wichtige Umgebungsvariablen (falls gesetzt):

- `ROOT_URL` (z. B. `http://localhost:8080/app`)
- `PLAYWRIGHT_ROOT_URL` (Fallback, z. B. in Docker-Runner)
- `E2E_USERNAME`
- `E2E_PASSWORD`

## Annotiertes Video aus Trace erzeugen

Playwright kann neben Video-Aufnahmen auch Traces aufzeichnen, die exakte Zeitstempel pro `test.step` enthalten.
Das Skript `scripts/video-script-generator/annotate-video-from-trace.mjs` kombiniert beides: Es liest den Trace, berechnet die Dauer jedes Schritts und blendet die Schrittbezeichnung per `ffmpeg` als Overlay ins Video ein.

**Voraussetzungen:** `ffmpeg` und `unzip` muessen im PATH verfuegbar sein.

### 1. Test direkt ausfuehren und annotiertes Video erzeugen

Der einfachste Weg ist der neue Wrapper. Er startet den Playwright-Test selbst mit `--trace on`, sammelt danach automatisch `trace.zip` und `video.webm` aus dem Lauf ein und erzeugt direkt das annotierte MP4.

Standardmäßig setzt der Wrapper dabei `slowMo=1000`, damit im Video jede Browser-Aktion um 1 Sekunde verlangsamt wird.
Zusätzlich erhöht er automatisch den globalen Playwright-Test-Timeout, damit längere Video-Läufe nicht nach 60 Sekunden abbrechen.

Optional kann der Wrapper zusaetzlich eine TTS-Voiceover-Tonspur auf Basis der Demo-Timeline erzeugen (`--tts`).

Das erzeugte Demo-Video kann zusaetzlich Demo-Metadaten aus `DemoRun` respektieren:

- Video-Start/-Ende ueber Event-IDs
- Video-Titel fuer das Intro
- Demo-Narrationen fuer TTS

Das Intro besteht aktuell aus:

- 2 Sekunden `lunettes.png` auf weissem Hintergrund
- 2 Sekunden Titelkarte mit Fade In/Out
- danach das eigentliche Demo-Video

```bash
npm run test:e2e:annotated-video -- \
  tests/e2e/idee-planungsanker-plaintext-flow.spec.js \
  --project=chromium
```

Mit TTS-Voiceover (wenn die Spec Demo-Narrationen schreibt):

```bash
npm run test:e2e:annotated-video -- \
  tests/e2e/idee-flow.spec.js \
  --project=chromium \
  --tts
```

### 2. Annotiertes Video neu erzeugen, ohne den Test erneut zu starten

Der einfachste Weg dafuer ist `--rerender`. Dabei reicht die Nennung des Testfiles, und das Skript sucht automatisch den letzten passenden Lauf unter `frontend/test-artifacts` heraus:

```bash
node scripts/video-script-generator/run-annotated-video.mjs \
  --rerender \
  tests/e2e/idee-flow.spec.js
```

Optional auch mit TTS:

```bash
node scripts/video-script-generator/run-annotated-video.mjs \
  --rerender \
  tests/e2e/idee-flow.spec.js \
  --tts
```

Optional mit explizitem Ausgabe-Dateinamen:

```bash
node scripts/video-script-generator/run-annotated-video.mjs \
  --rerender \
  tests/e2e/idee-flow.spec.js \
  idee-flow-neu.mp4
```

Intern verwendet `--rerender` automatisch:

- die zuletzt passende `trace.zip`
- das zuletzt passende `video.webm`
- das zugehoerige `demo`-Verzeichnis

Falls die Artefakte manuell angegeben werden sollen oder kein passender letzter Lauf gefunden wird, kann weiterhin `--annotate-only` verwendet werden.

Wenn `trace.zip`, `video.webm` und das zugehoerige `demo`-Verzeichnis bereits vorliegen, kann das Video komplett neu gebaut werden, ohne Playwright nochmal zu starten:

```bash
node scripts/video-script-generator/run-annotated-video.mjs \
  --annotate-only \
  test-artifacts/annotate-run-20260425191328/RUN_ORDNER/trace.zip \
  test-artifacts/annotate-run-20260425191328/RUN_ORDNER/video.webm \
  test-artifacts/annotate-run-20260425191328/RUN_ORDNER/demo \
  idee-flow-neu.mp4
```

Auch dieser Modus unterstuetzt optional TTS:

```bash
node scripts/video-script-generator/run-annotated-video.mjs \
  --annotate-only \
  test-artifacts/annotate-run-20260425191328/RUN_ORDNER/trace.zip \
  test-artifacts/annotate-run-20260425191328/RUN_ORDNER/video.webm \
  test-artifacts/annotate-run-20260425191328/RUN_ORDNER/demo \
  idee-flow-neu.mp4 \
  --tts
```

### Nur Tonspur neu erzeugen (ohne neuen Testlauf)

Wenn bereits ein annotiertes Video und ein passendes `demo`-Verzeichnis aus einem frueheren Run existieren, kann nur der Audio-Teil neu erzeugt und neu gemischt werden.

```bash
node scripts/video-script-generator/run-annotated-video.mjs \
  --tts-only \
  test-artifacts/idee-flow.spec-annotated-20260425191328.mp4 \
  test-artifacts/annotate-run-20260425191328/RUN_ORDNER/demo \
  --tts-voice=de-DE-Neural2-B
```

Optional kann ein expliziter Ausgabename fuer das gemixte Video angegeben werden:

```bash
node scripts/video-script-generator/run-annotated-video.mjs \
  --tts-only \
  test-artifacts/idee-flow.spec-annotated-20260425191328.mp4 \
  test-artifacts/annotate-run-20260425191328/RUN_ORDNER/demo \
  idee-flow-voiceover-neu.mp4 \
  --tts-voice=de-DE-Neural2-B
```

Ohne dritten Dateinamen wird automatisch `<annotated>-tts.mp4` erzeugt.

Wichtig: `--tts-only` erwartet neben dem annotierten Video auch die Sidecar-Datei `<annotated>.annotate-meta.json`, damit eingefrorene Click-Bilder zeitlich korrekt in die Narrations-Timeline eingerechnet werden.

Optional mit expliziter Cloud-Voice (nur relevant, wenn Google TTS aktiv ist):

```bash
npm run test:e2e:annotated-video -- \
  tests/e2e/idee-flow.spec.js \
  --project=chromium \
  --tts \
  --tts-voice=de-DE-Neural2-B
```

Optional kann auch direkt ein Ausgabe-Dateiname mitgegeben werden:

```bash
npm run test:e2e:annotated-video -- \
  tests/e2e/idee-planungsanker-plaintext-flow.spec.js \
  annotated.mp4 \
  --project=chromium
```

Optional kann `slowMo` überschrieben werden:

```bash
npm run test:e2e:annotated-video -- \
  tests/e2e/idee-planungsanker-plaintext-flow.spec.js \
  --slowmo=1500 \
  --project=chromium
```

Ohne expliziten Dateinamen landet das Ergebnis automatisch unter `test-artifacts/<spec>-annotated-<timestamp>.mp4`.
Mit `--tts` wird zusaetzlich `test-artifacts/<spec>-annotated-<timestamp>-tts.mp4` erzeugt.

### TTS-Cache

TTS-MP3s werden zentral unter `temp/tts` gecacht.

- Audio-Dateien liegen als Hash-Dateien in `temp/tts/*.mp3`
- Der Index liegt in `temp/tts/index.json`
- Der Cache-Key basiert auf Text bzw. SSML, Stimme und verwendeter TTS-Engine

Wenn sich der zu vertonende Inhalt nicht aendert, wird die vorhandene MP3 wiederverwendet und nicht neu erzeugt.

### Google TTS vs. Fallback erkennen

Der Wrapper schreibt am Ende explizit, welche Engine genutzt wurde:

- `TTS-Engine: google-cloud-text-to-speech`
- `TTS-Engine: ffmpeg-flite`

Wenn im ffmpeg-Log Eingaben wie `lavfi`/`flite=textfile=...:voice=slt` auftauchen, lief der Fallback `ffmpeg-flite`.

Google TTS wird nur genutzt, wenn beides erfuellt ist:

1. Paket installiert: `@google-cloud/text-to-speech`
2. `GOOGLE_APPLICATION_CREDENTIALS` zeigt auf eine gueltige Service-Account-JSON

Pruefkommandos:

```bash
npm ls @google-cloud/text-to-speech
echo "$GOOGLE_APPLICATION_CREDENTIALS"
ls -l "$GOOGLE_APPLICATION_CREDENTIALS"
```

### 2. Manueller Zweischritt (falls benoetigt)

```bash
npx playwright test tests/e2e/idee-planungsanker-plaintext-flow.spec.js \
  --project=chromium \
  --trace on
```

Hinweis: `--video` ist keine gueltige Playwright-CLI-Option. In diesem Projekt sind Videos bereits in [frontend/playwright.config.js](frontend/playwright.config.js) ueber `use.video: 'on'` aktiviert.

Trace-ZIP und Video liegen danach unter `test-results/<testname>/`:

```
test-results/
  idee-planungsanker.../
    trace.zip
    video.webm
```

### 3. Annotiertes Video erstellen

```bash
node scripts/video-script-generator/annotate-video-from-trace.mjs \
  test-results/<testname>/trace.zip \
  test-results/<testname>/video.webm \
  annotated.mp4
```

Das Skript gibt die erkannten Schritte mit ihren Zeitfenstern aus:

```
3 Schritte gefunden:
  [0.0s – 4.2s] Falls erforderlich anmelden und Ideen-Seite laden
  [4.2s – 7.8s] Neue Idee mit Zeitstempel anlegen
  [7.8s – 11.3s] Idee als Planungsanker setzen
  ...
```

`annotated.mp4` enthaelt dann die Schrittbezeichnung als Text-Overlay oben links, jeweils fuer die Dauer des zugehoerigen `test.step`.
