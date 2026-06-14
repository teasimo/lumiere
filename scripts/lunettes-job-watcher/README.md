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
      "lease_seconds": 14400,
      "poll_interval_ms": 15000,
      "testscript_mode": "video",
      "video_profile": "all-channels"
    }
  }
}
```

## Verhalten

- `testscript`: startet `scripts/test-script-generator/run-generated-testfile.mjs`, uebergibt `payload.szenario_id` als `--scenario-id`, erzwingt mit `--force` eine Neugenerierung, verwendet einen eigenen `--out-dir` pro Szenario unter `temp/lunettes-job-watcher/testfiles/<szenario_id>` und loest Fragmente ausschliesslich ueber die Lunettes-API auf
- `videoscript`: startet `scripts/video-script-generator/remotion-render.mjs` und uebergibt `payload.szenario_id` als `--scenario-id`
- `publish`: startet `publishhelper/publish-scenario-to-confluence.mjs` und uebergibt `payload.confluence_page_id`, `payload.szenario_id` sowie `payload.titel`

Beispiel fuer einen Publish-Payload:

```json
{
  "szenario_id": "1",
  "type": "publish",
  "trigger": "manual",
  "triggered_by": "Schulte",
  "titel": "NEO Abfrage erstellen",
  "confluence_page_id": "2105671681"
}
```

Empfangene XMLs werden unter `neo/interactions/_lunettes-job-watcher/szenario-<szenario_id>/` abgelegt. Die gemeinsame Quelle fuer alle Jobs derselben Lunettes-`szenario_id` ist immer `source.xml`; genau dieser Pfad wird an Testscript- und Videoscript-Laeufe uebergeben. Dadurch koennen dieselben Test-Artefakte spaeter wiedergefunden und weiterverwendet werden. Fuer die Fragment-Aufloesung wird ausschliesslich die Lunettes-API verwendet; app-lokale Fragmentbibliotheken werden nicht mehr genutzt. Pro Job werden Logs unter `temp/lunettes-job-watcher/jobs/<job-id>/job.log` geschrieben.

Die stdout/stderr-Ausgaben der gestarteten Skripte werden zusaetzlich als gebuendelte `progress`-Events an die Render-Job-API gesendet: spaetestens nach 5 Zeilen oder nach 60 Sekunden, auch wenn bis dahin weniger Zeilen angefallen sind.

Wenn ein gestartetes Script laenger als 180 Sekunden keinerlei Konsolenausgabe mehr liefert, beendet der Watcher die gesamte Prozessgruppe automatisch und markiert den Job als fehlgeschlagen.

Wenn die Render-Job-API bei einem Event- oder Abschluss-Request mit `409 Conflict` und `code = job_canceled` antwortet, behandelt der Watcher den Job als bereits verworfen, bricht die laufende Prozessgruppe ab und sendet keinen Fehlerabschluss mehr.
