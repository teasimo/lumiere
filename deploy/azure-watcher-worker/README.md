# Azure Watcher Worker

Dieser Ordner kapselt den Lunettes-Job-Watcher als Container-Deployment fuer Azure.

Der Container:

- enthaelt das komplette Repo samt Generator-Skripten
- startet den Watcher als langlebigen Worker-Prozess
- kann Testscript-, Videoscript- und Publish-Jobs direkt aus Lunettes ziehen
- spiegelt Laufzeitdaten in einen S3-Bucket

## Inhalt

- `Dockerfile`: baut das Worker-Image
- `entrypoint.sh`: bereitet Runtime-Daten, Credentials, S3-Sync und Watcher-Args vor
- `prepare-runtime-config.mjs`: schreibt Env-Overrides in `scenario.config.json`
- `.env.example`: Beispiel fuer lokale oder Azure-Umgebungsvariablen
- `containerapp.template.yaml`: Startpunkt fuer Azure Container Apps

## Build

Aus dem Repo-Root:

```bash
docker build -f deploy/azure-watcher-worker/Dockerfile -t lumiere-lunettes-worker:latest .
```

Beispiel fuer Azure Container Registry:

```bash
docker build -f deploy/azure-watcher-worker/Dockerfile -t <acr-login-server>/lumiere-lunettes-worker:latest .
docker push <acr-login-server>/lumiere-lunettes-worker:latest
```

## Pflicht-Umgebungsvariablen

- `LUNETTES_BASE_URL`
- `LUNETTES_API_USERNAME`
- `LUNETTES_API_PASSWORD`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `S3_BUCKET`

Fuer Publish-Jobs zusaetzlich:

- `CONFLUENCE_PUBLISHHELPER_CREDENTIALS`

Fuer Google-TTS per Secret-JSON optional:

- `GOOGLE_APPLICATION_CREDENTIALS_JSON`

## Optionale Worker-Variablen

- `WATCHER_TYPES`
- `WATCHER_SOFTWARE`
- `WATCHER_POLL_INTERVAL_MS`
- `WATCHER_LEASE_SECONDS`
- `WATCHER_SCRIPT_INACTIVITY_TIMEOUT_MS`
- `WATCHER_SCRIPT_TERMINATION_GRACE_PERIOD_MS`
- `WATCHER_WORKER_ID`
- `WATCHER_TESTSCRIPT_MODE`
- `WATCHER_VIDEO_PROFILE`
- `WATCHER_ONCE`
- `WORKER_DATA_ROOT`
- `PERSIST_RUNTIME_DATA`
- `S3_PREFIX`
- `S3_SYNC_INTERVAL_SECONDS`
- `S3_ENDPOINT_URL`
- `AWS_SESSION_TOKEN`
- `SCENARIO_CONFIG_JSON`
- `SCENARIO_CONFIG_PATCH_JSON`

Auf Azure Container Apps wird `WATCHER_WORKER_ID` zur Laufzeit automatisch mit `CONTAINER_APP_REVISION` erweitert, also z. B. `azure-worker-01@my-containerapp--20mh1s9`. Ohne gesetzte Basis-ID wird nur die Revision verwendet.

## Wie die Config im Container entsteht

Vor dem Start schreibt `prepare-runtime-config.mjs` die Runtime-Config nach `scenario.config.json`.

Wichtig:

- Falls `SCENARIO_CONFIG_JSON` gesetzt ist, wird dessen JSON-Inhalt als komplette Basis fuer `scenario.config.json` verwendet.
- `LUNETTES_BASE_URL` wird sowohl auf `scenario["lunettes-job-watcher"].base_url` als auch auf `scenario["test-script"].lunettes_api.base_url` gesetzt.
- `WATCHER_SOFTWARE` wird auf `scenario["lunettes-job-watcher"].software` gesetzt und schraenkt Claim-Requests auf bestimmte Software-Werte ein, z. B. `Lunettes`.
- `WATCHER_SCRIPT_INACTIVITY_TIMEOUT_MS` wird auf `scenario["lunettes-job-watcher"].script_inactivity_timeout_ms` gesetzt.
- `WATCHER_SCRIPT_TERMINATION_GRACE_PERIOD_MS` wird auf `scenario["lunettes-job-watcher"].script_termination_grace_period_ms` gesetzt.
- Dadurch verwenden Watcher und Testscript-Generator dieselbe Lunettes-API-Basis.
- Mit `SCENARIO_CONFIG_PATCH_JSON` kannst du zusaetzlich beliebige Teile der zentralen Config deep-merge'n.

Reihenfolge:

1. `SCENARIO_CONFIG_JSON` falls gesetzt, sonst die im Image enthaltene `scenario.config.json`
2. env-basierte Standard-Overrides wie `LUNETTES_BASE_URL` oder `WATCHER_SOFTWARE`
3. `SCENARIO_CONFIG_PATCH_JSON`

Beispiel fuer `SCENARIO_CONFIG_JSON`:

```json
{
  "scenario": {
    "lunettes-job-watcher": {
      "types": ["testscript", "videoscript"]
    },
    "video-script": {
      "render": {
        "encoding": {
          "crf": 20
        }
      }
    }
  }
}
```

Beispiel:

```json
{
  "scenario": {
    "video-script": {
      "render": {
        "encoding": {
          "crf": 20
        }
      }
    }
  }
}
```

## Persistente Daten ueber S3

Der Container arbeitet lokal unter `/app/runtime-data` und synchronisiert dieses Verzeichnis gegen S3.

Der Entry-Point verlinkt:

- `/app/output` -> `/app/runtime-data/output`
- `/app/temp` -> `/app/runtime-data/temp`
- `/app/neo/interactions/_lunettes-job-watcher` -> `/app/runtime-data/watcher-cache`

S3-Verhalten:

- Restore beim Start
- periodischer `aws s3 sync` waehrend der Laufzeit
- finaler Sync beim Beenden des Containers

Damit bleiben erhalten:

- generierte Videos
- Test-Artefakte
- Watcher-Job-Logs
- gecachte Szenario-XMLs

## Azure Container Apps

Die Datei `containerapp.template.yaml` ist bewusst ein Template mit Platzhaltern.

Typischer Ablauf:

1. Image in ACR pushen.
2. Platzhalter im YAML ersetzen.
3. S3-Credentials und Bucket-Namen als Secrets/Envs setzen.
4. Container App mit einer festen Replik deployen.

Beispiel:

```bash
az containerapp create --resource-group <rg> --environment <env> --yaml deploy/azure-watcher-worker/containerapp.template.yaml
```

## Laufzeitverhalten

Der Container startet standardmaessig den Endlos-Watcher.

Einmaliger Lauf:

```bash
docker run --rm \
  --env-file deploy/azure-watcher-worker/.env.example \
  -e WATCHER_ONCE=1 \
  lumiere-lunettes-worker:latest
```

## Hinweise

- Das Image basiert auf dem Playwright-Image, damit Browser und Systembibliotheken fuer Testscript-Laeufe vorhanden sind.
- `ffmpeg`, `zip` und `unzip` werden zusaetzlich installiert, weil Video-, Trace- und Confluence-Anhangsverarbeitung diese Tools benoetigen.
- `awscli` ist enthalten und uebernimmt Restore und Sync gegen S3.
- Der Container ist als einzelner Worker gedacht. Unter Azure Container Apps wird die Revision automatisch an die Worker-ID angehaengt; ausserhalb davon solltest du bei mehreren Workern weiterhin bewusst unterschiedliche `WATCHER_WORKER_ID` setzen.
- Azure Container Apps mountet S3 nicht nativ als Dateisystem. Deshalb verwendet diese Struktur bewusst ein lokales Runtime-Verzeichnis plus Objekt-Sync.
