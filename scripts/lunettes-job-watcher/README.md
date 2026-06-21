# Lunettes Job Watcher

Der Watcher claimt Render-Jobs aus Lunettes, speichert empfangene Szenario-XMLs lokal und startet pro Job-Typ das passende lokale Script.

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
    }
  }
}
```

## Verhalten

- `testscript`: startet zuerst `scripts/test-script-generator/run-generated-testfile.mjs`, uebergibt `payload.szenario_id` als `--scenario-id`, erzwingt mit `--force` eine Neugenerierung, verwendet einen eigenen `--out-dir` pro Szenario unter `temp/lunettes-job-watcher/testfiles/<szenario_id>`, loest Fragmente ausschliesslich ueber die Lunettes-API auf und erzwingt immer `--mode video`; im selben Job folgt danach automatisch `scripts/publish-to-confluence/publish-scenario-to-confluence.mjs`. Falls das Testscript fehlschlaegt, wird der Publish-Schritt trotzdem noch ausgefuehrt; der Gesamtjob endet danach weiterhin mit Status `failed`.
- `videoscript`: startet zuerst `scripts/video-script-generator/remotion-render.mjs` und uebergibt `payload.szenario_id` als `--scenario-id`; im selben Job folgt danach automatisch `scripts/publish-to-confluence/publish-scenario-to-confluence.mjs`
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

Die stdout/stderr-Ausgaben der gestarteten Skripte werden zusaetzlich als gebuendelte `progress`-Events an die Render-Job-API gesendet: spaetestens nach 5 Zeilen oder nach 60 Sekunden, auch wenn bis dahin weniger Zeilen angefallen sind.

Bei erfolgreichem Abschluss eines `testscript`-Jobs sendet der Watcher im `complete`-Request zusaetzlich ein `result`-Objekt mit den wichtigsten Artefaktpfaden und der aufgeloesten Timeline des Testlaufs. Da `testscript` und `videoscript` jetzt mehrstufig sind, enthaelt `result.execution` ausserdem die ausgefuehrten Schritte inklusive Laufzeiten und - falls ein Publish-Schritt gelaufen ist - die aus der Publish-Ausgabe extrahierten Confluence-Metadaten. Relevant sind insbesondere:

- `run_root`: Run-Wurzel unter `output/<szenario_id>/runs/<runId>`
- `artifacts_dir`: Artefaktordner des Playwright-Laufs
- `generated_dir`: exportierte generierte Testdateien und Runtime-Helfer
- `run_meta_path`: Pfad zur `run-meta.json`
- `scenario_step_timeline_path`: relativer Pfad zur gefundenen `scenario-step-timeline.json`
- `scenario_step_timeline`: geparstes JSON der Timeline-Datei

Die Timeline selbst hat dieses Grundformat:

- `scenarioId`: aufgeloeste Szenario-ID des Testlaufs
- `scenarioVersion`: Szenario-Version aus dem XML
- `scenarioSource`: Quelldatei des ausgefuehrten Szenarios
- `generatedAtIso`: Schreibzeitpunkt der Timeline
- `steps`: Liste aller ausgefuehrten, uebersprungenen, fehlgeschlagenen oder in Timeout gelaufenen Schritte

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
