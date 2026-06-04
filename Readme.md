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
- `npm run generate:video -- <scenario.xml>`
- `npm run generate:video:force -- <scenario.xml>`

TTS/Video-Postprocessing:

- `npm run generate:tts -- <scenario.xml> --profile=all-channels`
- `npm run generate:tts:full -- <scenario.xml>`
- `npm run remotion:script -- <scenario.xml>`
- `npm run remotion:render -- <scenario.xml>`

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
    "defaults": {
      "scenario_path": "neo/interactions/dubletten-aufloesen/FR1-case-sus-dubletten-zusammenfuehren.xml",
      "scenario_dir": "neo/interactions",
      "output_dir": "temp/testfiles"
    },
    "video": {
      "wait_between_steps": 0,
      "scroll_delay_ms": 35,
      "autoscroll_smooth": false,
      "resolution": {
        "width": 1280,
        "height": 720
      }
    }
  }
}
```

Prioritaet:

1. CLI-Parameter
2. Szenario-Einstellungen aus XML
3. `scenario.config.json`

## Relevante Skripte

- `scripts/generate-tests-from-scenario-xml.mjs`
- `scripts/run-generated-testfile.mjs`
- `scripts/run-annotated-video.mjs`
- `scripts/annotate-video-from-trace.mjs`
- `scripts/remotion-render.mjs`
