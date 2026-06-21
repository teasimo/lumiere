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
- `SCENARIO_CONFIG_PATCH_JSON`

## Wie die Config im Container entsteht

Vor dem Start schreibt `prepare-runtime-config.mjs` die Env-Overrides nach `scenario.config.json`.

Wichtig:

- `LUNETTES_BASE_URL` wird sowohl auf `scenario["lunettes-job-watcher"].base_url` als auch auf `scenario["test-script"].lunettes_api.base_url` gesetzt.
- `WATCHER_SOFTWARE` wird auf `scenario["lunettes-job-watcher"].software` gesetzt und schraenkt Claim-Requests auf bestimmte Software-Werte ein, z. B. `Lunettes`.
- Dadurch verwenden Watcher und Testscript-Generator dieselbe Lunettes-API-Basis.
- Mit `SCENARIO_CONFIG_PATCH_JSON` kannst du zusaetzlich beliebige Teile der zentralen Config deep-merge'n.

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
- `ffmpeg` und `unzip` werden zusaetzlich installiert, weil Video- und Trace-Verarbeitung diese Tools benoetigen.
- `awscli` ist enthalten und uebernimmt Restore und Sync gegen S3.
- Der Container ist als einzelner Worker gedacht. Mehrere Replikate sind moeglich, sollten aber bewusst mit unterschiedlicher `WATCHER_WORKER_ID` betrieben werden.
- Azure Container Apps mountet S3 nicht nativ als Dateisystem. Deshalb verwendet diese Struktur bewusst ein lokales Runtime-Verzeichnis plus Objekt-Sync.
