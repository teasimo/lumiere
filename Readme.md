# Lumiere Scenario Workflow

Dieses Projekt generiert und fuehrt Playwright-Tests aus XML-Szenarien aus.

## Voraussetzungen

- Node.js 20+
- npm

## Setup

```bash
npm install
```

## Schnellstart

Ein Szenario generieren:

```bash
npm run generate:testfile -- neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml
```

Generierten Test ausfuehren:

```bash
npm run check:testfile -- neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml
```

## Wichtige Commands

Generierung:

- `npm run generate:testfile -- <scenario.xml>`
- `npm run generate:testfiles:all -- --scenario-dir <dir> --out-dir <dir>`
- `npm run clean:testfiles`

Ausfuehrung:

- `npm run check:testfile -- <scenario.xml>`
- `npm run check:testfile:force -- <scenario.xml>`
- `npm run check:testfile:verbose -- <scenario.xml>`
- `npm run run:testfile-script -- <scenario.xml>`
- `npm run run:testfile-script:force -- <scenario.xml>`

TTS/Video-Postprocessing:

- `npm run run:speechscript -- <scenario.xml>`
- `npm run run:speechscript:force -- <scenario.xml>`
- `npm run generate:videoscript -- <scenario.xml>`
- `npm run run:videoscript -- <scenario.xml>`

## Ausgaben

Generierte Tests:

- `temp/testfiles/<name>.spec.js`
- `temp/testfiles/<name>.resolved.json`
- `temp/testfiles/<name>.resolved.xml`
- `temp/testfiles/<name>.spec.js.meta.json`

Exportierte Video-Artefakte:

- `output/<name>/runs/<runId>/artifacts/...`
- `output/<name>/runs/<runId>/generated/...`
- `output/<name>/runs/<runId>/report/...` (bei verbose-Checks)
- `output/<name>/runs/<runId>/run-meta.json` (Status inkl. fehlgeschlagener/abgebrochener Laeufe)
- `output/<scenario>_v<version>/tts/...`

Manuelle Annotate-Video-Laeufe:

- `output/<testname>/manual-runs/<runId>/artifacts/...`
- `output/<testname>/manual-runs/<runId>/final/...`
- `output/<testname>/manual-runs/<runId>/run-meta.json` (Status inkl. Fehlschlaegen)

Timeline-Datei aus Testlauf:

- `scenario-step-timeline.json`

## Konfiguration

Zentrale Defaults stehen in `scenario.config.json`.

Beispiel:

```json
{
  "scenario": {
    "test-script": {
      "defaults": {
        "scenario_path": "neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml",
        "scenario_dir": "neo/interactions",
        "output_dir": "temp/testfiles"
      },
      "video": {
        "wait_between_steps": 0,
        "scroll_delay_ms": 35,
        "scroll_step_px": 20,
        "autoscroll_smooth": false,
        "resolution": {
          "width": 1280,
          "height": 720
        }
      }
    },
    "video-script": {
      "tts": [
        {
          "profile": "all-channels"
        }
      }
    }
  }
}
```

`scroll_step_px` steuert die Scroll-Schrittweite der generierten Test-Helfer bei Smooth-Autoscroll.

## Konfig-Hierarchie

Es gibt nicht nur eine globale Konfig-Quelle, sondern mehrere Ebenen mit unterschiedlicher Prioritaet:

### 1. Generator-/Runner-Defaults

Fuer Pfade und Default-Werte wie `scenario_path`, `scenario_dir` und `output_dir` gilt:

1. CLI-Parameter
2. `scenario.config.json > scenario["test-script"].defaults`
3. eingebauter Fallback im Skript

Beispiele:

- `--out-dir` gewinnt immer gegen `scenario.config.json`
- wenn kein Szenario uebergeben wird, wird `scenario.config.json > scenario["test-script"].defaults.scenario_path_xml` bzw. `scenario_path` verwendet

### 2. Video-bezogene Szenario-Einstellungen

Fuer Werte unter `scenario["test-script"].video` wie:

- `wait_between_steps`
- `scroll_delay_ms`
- `scroll_step_px`
- `autoscroll_smooth`
- `resolution`

gilt bei der Testscript-Generierung:

1. XML-Szenarioeinstellungen
2. `scenario.config.json > scenario["test-script"].video`
3. eingebauter Fallback im Code

Das bedeutet: XML ueberschreibt zentrale Defaults bewusst pro Szenario.

### 3. App-spezifische Fill-Strategien

Fuer UI-Interaktionen im generierten Test gilt zur Laufzeit:

1. `<app>/env/fill-strategies.mjs`
2. zentrale Strategien aus `scripts/test-script-generator/central-fill-strategies.mjs`

Das ist keine JSON-Konfig, aber ebenfalls eine Hierarchie, die fuer das Verhalten der generierten Tests relevant ist.

### 4. Video-Skripte

Die Video-Skripte verwenden `scenario.config.json > scenario["video-script"]` als eigene Default-Quelle, aktuell insbesondere fuer TTS-Profile. Sie konsumieren zusaetzlich bereits erzeugte Test-/Timeline-Artefakte. Fuer die eigentliche UI-Interaktionslogik greifen sie jedoch nicht in die Testscript-Konfigurationshierarchie ein.

## XML-Tags Und Wirkung

Die XML-Datei ist nicht fuer alle Skripte gleich relevant. Die Tags loesen je nach Generator unterschiedliche Dinge aus.

### Test-Script-Generator

Relevant fuer `scripts/test-script-generator/generate-tests-from-scenario-xml.mjs` und `scripts/test-script-generator/run-generated-testfile.mjs`:

- `<SzenarioScript ...>`: `id` und `szenario-version` steuern Namen und Metadaten der erzeugten Artefakte.
- `<Einstellungen>`: relevant sind aktuell nur Werte unter `Gruppe name="video"`, zum Beispiel `wait_between_steps`, `scroll_delay_ms`, `scroll_step_px`, `autoscroll_smooth` und `resolution`.
- `<Daten>`, `<Variablen>`, `<Fragment>`, `<Parameter>`: werden fuer Template-Aufloesung und Fragment-Includes ausgewertet.
- `<Gruppe>`: strukturiert den Ablauf.
- `<Wenn>` und `<Sonst>`: erzeugen bedingte Zweige im generierten Test.
- `<Oeffnen>`, `<Click>`, `<Eingabe>`, `<Auswahl>`, `<Anzeige>`, `<Warten>`, `<SucheAuswahl>`: erzeugen echte Playwright-Schritte.

Keine Wirkung auf die Testausfuehrung:

- `<VideoStart>`: wird vom Test-Script-Generator nicht als Testschritt interpretiert.
- `<Folie>`, `<Info>`, `<Ton>`, `<Video>`: erzeugen keine Playwright-Schritte.

### Video-Script-Generator

Relevant fuer `scripts/video-script-generator/run-annotated-video.mjs` und `scripts/video-script-generator/remotion-render.mjs`:

- `<SzenarioScript ...>`: `id`, `szenario-version` und `titel` beeinflussen Ausgabeordner, Dateinamen und Titelableitungen.
- `<VideoStart/>`: markiert den Beginn des fachlichen Videobereichs. Der Video-Script-Generator beginnt Video-Script-Elemente erst ab der ersten folgenden Interaktion zu erzeugen.
- `<VideoStop/>`: markiert das Ende des fachlichen Videobereichs. Der Video-Script-Generator erzeugt Video-Script-Elemente nur bis zur letzten vorherigen Interaktion.

Wichtig:

- Der Video-Script-Generator konsumiert je nach Modus zusaetzlich `resolved.json`, `test-resolved.xml`, `scenario-step-timeline.json`, `trace.zip`, Demo-Artefakte und das Rohvideo aus dem Testlauf.
- `<Folie>`, `<Info>`, `<Ton>` und `<Video>` haben in der aktuellen XML-Pipeline fuer `run:speechscript` und `run:videoscript` keine direkte Auswirkung allein durch ihre Existenz im XML.

## Relevante Skripte

- `scripts/test-script-generator/generate-tests-from-scenario-xml.mjs`
- `scripts/test-script-generator/run-generated-testfile.mjs`
- `scripts/video-script-generator/run-annotated-video.mjs`
- `scripts/video-script-generator/annotate-video-from-trace.mjs`
- `scripts/video-script-generator/remotion-render.mjs`

## Skriptstruktur

Die Skripte sind fachlich in zwei Bereiche getrennt:

- `scripts/test-script-generator/`
  - liest Szenario-XML
  - erzeugt Testskripte und zugehoerige Test-Artefakte
  - enthaelt Fill-Strategien, Templates und Test-Runtime-Helper
- `scripts/video-script-generator/`
  - verarbeitet Video-/TTS-/Remotion-Pipelines
  - kann dafuer Szenario-XML und bereits erzeugte Test-Artefakte konsumieren
  - enthaelt keine UI-Interaktionsstrategien fuer die Testgenerierung

Gemeinsame, wirklich fachneutrale Helfer liegen unter `scripts/shared/`.

Wichtig: Es gibt bewusst keine Root-Wrapper mehr unter `scripts/*.mjs`. Einstiegspunkte sind die Skripte in den beiden Fachordnern bzw. die dazu konfigurierten `npm`-Commands.
