# Lunettes Job Watcher

Der Watcher claimt Render-Jobs aus Lunettes, speichert empfangene Szenario-XMLs lokal und startet pro Job-Typ das passende lokale Script. Wenn `S3_BUCKET` gesetzt ist, verwaltet er generatorrelevante Artefakte zusaetzlich versionsspezifisch auf S3.

## Start

```bash
npm run watch-jobs
```

Einzelner Claim-Durchlauf:

```bash
npm run watch-jobs -- --once
```

## Voraussetzungen

- `scenario.config.json > scenario["test-script"].lunettes_api.base_url` oder `scenario["lunettes-job-watcher"].base_url`
- `LUNETTES_API_USERNAME`
- `LUNETTES_API_PASSWORD`

Optional:

- `LUNETTES_JOB_WORKER_ID`

## Optionaler Config-Block

```json
{
  "scenario": {
    "lunettes-job-watcher": {
      "base_url": "https://example.invalid",
      "types": ["testscript", "videoscript", "publish"],
      "software": ["Lunettes"],
      "lease_seconds": 14400,
      "poll_interval_ms": 15000,
      "script_inactivity_timeout_ms": 900000,
      "script_termination_grace_period_ms": 120000,
      "video_profile": "all-channels"
    },
    "live-test-worker": {
      "re_register_after_idle_ms": 15000
    }
  }
}
```

`live-test-worker.re_register_after_idle_ms` sorgt dafuer, dass der Worker ohne feste `worker_session_id` seine Session nach laengerem `wait` ohne `live_test_id` neu registriert. Das bildet den manuellen Neustart nach und hilft, wenn der Server neue Live-Tests nur nach einer frischen Registrierung zuordnet.

## Verhalten

- `testscript`: startet `scripts/test-script-generator/run-generated-testfile.mjs`, uebergibt `payload.szenario_id` als `--scenario-id`, erzwingt mit `--force` eine Neugenerierung, verwendet einen eigenen `--out-dir` pro Szenario unter `temp/lunettes-job-watcher/testfiles/<szenario_id>`, loest Fragmente ausschliesslich ueber die Lunettes-API auf und erzwingt immer `--mode video`
- `videoscript`: startet `scripts/video-script-generator/remotion-render.mjs` und uebergibt `payload.szenario_id` als `--scenario-id`
- `publish`: startet `scripts/publish-to-confluence/publish-scenario-to-confluence.mjs` und uebergibt `payload.szenario_id` sowie `payload.titel`; `payload.confluence_page_id` ist optional und bei fehlendem Wert wird zuerst die in Lunettes hinterlegte `confluence_page_id` fuer das Szenario abgefragt, erst danach wird die in `scenario.config.json > scenario["publish-to-confluence"].parent_page_id` konfigurierte Parent-Seite fuer eine Neuanlage verwendet

Zusatz:

- ueber `scenario["lunettes-job-watcher"].software` oder `--software=<name[,name...]>` kann der Watcher Claim-Requests auf bestimmte Software-Werte einschränken, z. B. `Lunettes`

Beispiel fuer einen Publish-Payload:

```json
{
  "szenario_id": "1",
  "type": "publish",
  "trigger": "manual",
  "triggered_by": "Schulte",
  "titel": "NEO Abfrage erstellen"
}
```

Empfangene XMLs werden unter `neo/interactions/_lunettes-job-watcher/szenario-<szenario_id>/` abgelegt. Die gemeinsame Quelle fuer alle Jobs derselben Lunettes-`szenario_id` ist immer `source.xml`; genau dieser Pfad wird an Testscript- und Videoscript-Laeufe uebergeben. Dadurch koennen dieselben Test-Artefakte spaeter wiedergefunden und weiterverwendet werden. Fuer die Fragment-Aufloesung wird ausschliesslich die Lunettes-API verwendet; app-lokale Fragmentbibliotheken werden nicht mehr genutzt. Pro Job werden Logs unter `temp/lunettes-job-watcher/jobs/<job-id>/job.log` geschrieben.

## Versionsspezifische S3-Artefakte

Wenn `S3_BUCKET` gesetzt ist, verwendet der Watcher zusaetzlich dieses Remote-Schema:

```text
s3://<bucket>/<prefix>/scenario-artifacts/<szenario-id>/versions/<version>/<generator>/<artifact-key>/...
```

Zusaetzlich gibt es eine persistente, nicht-temporaere Artefaktstruktur unter:

```text
szenario/<szenario-id>/<version>/<generator>/
```

Diese Struktur wird im Azure-Container ebenfalls per S3-Sync gespiegelt. Die bisherige temp-/run-orientierte Ablage bleibt parallel bestehen und wird vorerst nicht entfernt.

Dabei gilt:

- `<szenario-id>` ist die Lunettes-`szenario_id`
- `<version>` ist die ermittelte Szenario-Version
- `<generator>` ist aktuell `shared`, `testscript` oder `videoscript`
- `<artifact-key>` ist z. B. `scenario-cache`, `runs`, `testfiles` oder `videogenerator`

Inhalt der persistenten Struktur:

- `szenario/<id>/<version>/testscript/rohvideo/video.webm`
- `szenario/<id>/<version>/testscript/timeline/scenario-step-timeline.json`
- `szenario/<id>/<version>/testscript/screenshots/...`
- `szenario/<id>/<version>/videoscript/final/<dateiname>.mp4`

Restore/Flush pro Job-Typ:

- `testscript`:
  Restore `shared/scenario-cache`, `szenario/<id>/<version>/testscript`
  Flush `shared/scenario-cache`, `testscript/runs`, `testscript/testfiles`, `szenario/<id>/<version>/testscript`
- `videoscript`:
  Restore `shared/scenario-cache`, `szenario/<id>/<version>/testscript`, `szenario/<id>/<version>/videoscript`
  Flush `shared/scenario-cache`, `videoscript/videogenerator`, `szenario/<id>/<version>/videoscript`
- `publish`:
  Restore `shared/scenario-cache`, `testscript/runs`, `videoscript/videogenerator`, `szenario/<id>/<version>/testscript`, `szenario/<id>/<version>/videoscript`
  Flush `shared/scenario-cache`

Verhalten:

- Vor jedem Job wird zuerst die Szenario-Version bestimmt.
- Danach werden nur die potentiell benoetigten Artefakte fuer genau diese `szenario_id` und Version von S3 geholt.
- Nach dem Job werden nur die Artefakte des betroffenen Generators fuer genau diese Version mit `sync --delete` ersetzt.
- Artefakte anderer Versionen bleiben unberuehrt.

Die stdout/stderr-Ausgaben der gestarteten Skripte werden zusaetzlich als gebuendelte `progress`-Events an die Render-Job-API gesendet: spaetestens nach 5 Zeilen oder nach 60 Sekunden, auch wenn bis dahin weniger Zeilen angefallen sind.

Bei erfolgreichem Abschluss eines `testscript`-Jobs sendet der Watcher im `complete`-Request zusaetzlich ein `result`-Objekt mit den wichtigsten Artefaktpfaden und der aufgeloesten Timeline des Testlaufs. Da `testscript` und `videoscript` jetzt mehrstufig sind, enthaelt `result.execution` ausserdem die ausgefuehrten Schritte inklusive Laufzeiten und - falls ein Publish-Schritt gelaufen ist - die aus der Publish-Ausgabe extrahierten Confluence-Metadaten. Relevant sind insbesondere:

- `run_root`: Run-Wurzel unter `output/<szenario_id>/runs/<runId>`
- `artifacts_dir`: Artefaktordner des Playwright-Laufs
- `generated_dir`: exportierte generierte Testdateien und Runtime-Helfer
- `persistent_artifacts_dir`: persistente Artefaktablage unter `szenario/...`
- `persistent_raw_video`: persistentes Test-Rohvideo
- `persistent_scenario_step_timeline`: persistente Timeline-Datei
- `persistent_screenshots_dir`: persistente explizit generierte Screenshots
- `run_meta_path`: Pfad zur `run-meta.json`
- `scenario_step_timeline_path`: relativer Pfad zur gefundenen `scenario-step-timeline.json`
- `scenario_step_timeline`: geparstes JSON der Timeline-Datei
- `persistent_output_video`: persistentes finales Videoscript-Video bei `videoscript`-Jobs

Die Timeline selbst hat dieses Grundformat:

- `scenarioId`: aufgeloeste Szenario-ID des Testlaufs
- `scenarioVersion`: Szenario-Version aus dem XML
- `scenarioSource`: Quelldatei des ausgefuehrten Szenarios
- `generatedAtIso`: Schreibzeitpunkt der Timeline
- `steps`: Liste aller ausgefuehrten, uebersprungenen, fehlgeschlagenen oder in Timeout gelaufenen Schritte
- `video`: vorbereitete Video-Sicht auf dieselbe Timeline fuer den Video-Generator

Felder pro Eintrag in `scenario_step_timeline.steps`:

- `stepId`: technische Timeline-ID des Schritts
- `stepDescription`: menschenlesbare Beschreibung inklusive Selektoren
- `selectors`: Liste der zugeordneten Selektoren aus dem Generator
- `interactionType`: Interaktionstyp wie `click`, `fill`, `scroll`, `open`
- `status`: `executed`, `skipped`, `failed` oder `timeout`
- `skipped`: `true` bei bewusst uebersprungenen Schritten
- `skipReason`: Grund fuer `skipped`, sonst `null`
- `startedAtMs` / `endedAtMs`: Unix-Zeitstempel in Millisekunden
- `startedAtIso` / `endedAtIso`: dieselben Zeitpunkte als ISO-String
- `durationMs`: Laufzeit des einzelnen Schritts
- `error`: Fehlerobjekt bei `failed` oder `timeout`, sonst `null`
- `log`: generische Step-Logs als Liste strukturierter Eintraege
- optional `clickedElement`, `clickPoint`, `clickedAtMs`, `fillPoint`, `scrollDirection`: interaktionsspezifische Metadaten fuer Overlay-/Video-Weiterverarbeitung

Felder in `scenario_step_timeline.video`:

- `viewport`: Browser-Viewport mit `width` und `height`, falls waehrend des Laufs verfuegbar
- `stepSegments`: normalisierte Schrittfenster fuer Video-Overlays
- `clickMarkers`: normalisierte Click-Marker mit final verwendbaren Koordinaten und Zeitpunkten

Felder pro Eintrag in `video.stepSegments`:

- `stepId`: technische Schritt-ID
- `label`: menschenlesbarer Labeltext fuer Overlays
- `interactionType`: normalisierter Interaktionstyp
- `startMs` / `endMs`: normalisierte Zeitfenster in Millisekunden

Felder pro Eintrag in `video.clickMarkers`:

- `stepId`: technische Schritt-ID des Clicks
- `interactionType`: aktuell typischerweise `click`
- `x` / `y`: Click-Koordinate im Video/Viewport
- `atMs`: Click-Zeitpunkt in Millisekunden

Felder in `error`:

- `name`: Fehlerklasse, z. B. `ScenarioStepTimeoutError`
- `code`: technischer Fehlercode, z. B. `SCENARIO_STEP_TIMEOUT`
- `message`: lesbare Fehlermeldung

Felder pro Eintrag in `log`:

- `timestamp`: ISO-Zeitpunkt des Log-Eintrags
- `level`: Log-Level, aktuell z. B. `info`, `warning`, `error`
- `message`: Log-Typ, z. B. `target-availability` oder `step-timeout`
- `data`: frei strukturierte Zusatzdaten zum Log-Eintrag

Typische `data`-Felder bei `target-availability`:

- `interactionType`: Interaktion, fuer die geprueft wurde
- `availableCount`: Anzahl der gefundenen Komponenten fuer die Selektoren
- `selectorStrategy`: verwendete Aufloesungsstrategie wie `testid`, `data-id`, `role`
- `selectors`: konkret verwendete Selektorbeschreibung
- `preferredControl`: gesetzte Steuerungs-Praeferenz fuer die Locator-Aufloesung
- `textMode`: verwendeter Textmodus bei textbasierten Locators
- `targetIndex`: expliziter Trefferindex, falls gesetzt
- `error`: Aufloesungsfehler, falls die Verfuegbarkeitspruefung selbst scheitert

Beispiel fuer den `result`-Payload eines erfolgreichen `testscript`-Jobs:

```json
{
  "job_type": "testscript",
  "szenario_id": 7,
  "payload_szenario_id": "7",
  "scenario_path": "neo/interactions/_lunettes-job-watcher/szenario-7/source.xml",
  "xml_source": "payload",
  "log_path": "temp/lunettes-job-watcher/jobs/42/job.log",
  "run_root": "output/7/runs/20260617-100358-605",
  "artifacts_dir": "output/7/runs/20260617-100358-605/artifacts",
  "generated_dir": "output/7/runs/20260617-100358-605/generated",
  "persistent_artifacts_dir": "szenario/7/2/testscript",
  "persistent_raw_video": "szenario/7/2/testscript/rohvideo/video.webm",
  "persistent_scenario_step_timeline": "szenario/7/2/testscript/timeline/scenario-step-timeline.json",
  "persistent_screenshots_dir": "szenario/7/2/testscript/screenshots",
  "run_meta_path": "output/7/runs/20260617-100358-605/run-meta.json",
  "scenario_step_timeline_path": "output/7/runs/20260617-100358-605/artifacts/temp-lunettes-job-watcher--9d5b3-s-generated-flow-for-source/scenario-step-timeline.json",
  "scenario_step_timeline": {
    "scenarioId": "source",
    "scenarioVersion": "unknown",
    "scenarioSource": "neo/interactions/_lunettes-job-watcher/szenario-7/source.xml",
    "generatedAtIso": "2026-06-17T08:04:39.114Z",
    "steps": [
      {
        "stepId": "[Szenario-7]-Zeile-14-[lunettes-login]-Zeile-10",
        "stepDescription": "Eingabe | value=testtest | selectors: testid=login-username-input",
        "selectors": ["testid=login-username-input"],
        "interactionType": "fill",
        "status": "executed",
        "skipped": false,
        "skipReason": null,
        "startedAtMs": 1781683221734,
        "endedAtMs": 1781683222350,
        "startedAtIso": "2026-06-17T08:00:21.734Z",
        "endedAtIso": "2026-06-17T08:00:22.350Z",
        "durationMs": 616,
        "error": null,
        "log": [
          {
            "timestamp": "2026-06-17T08:00:21.735Z",
            "level": "info",
            "message": "target-availability",
            "data": {
              "interactionType": "fill",
              "availableCount": 1,
              "selectorStrategy": "testid",
              "selectors": ["testid=login-username-input"],
              "preferredControl": null,
              "textMode": "text",
              "targetIndex": null,
              "error": null
            }
          }
        ]
      }
    ]
  },
  "duration_ms": 41823
}
```

Wenn ein gestartetes Script laenger als 180 Sekunden keinerlei Konsolenausgabe mehr liefert, beendet der Watcher die gesamte Prozessgruppe automatisch und markiert den Job als fehlgeschlagen.

Wenn die Render-Job-API bei einem Event- oder Abschluss-Request mit `409 Conflict` und `code = job_canceled` antwortet, behandelt der Watcher den Job als bereits verworfen, bricht die laufende Prozessgruppe ab und sendet keinen Fehlerabschluss mehr.
