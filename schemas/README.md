# Schema: Lumiere Test-YAML

JSON-Schema für Validierung und Autovervollständigung der Lumiere Test- und Fragment-YAML-Dateien.

## Voraussetzung

Die Extension **YAML Language Support by Red Hat** (`redhat.vscode-yaml`) muss in VS Code installiert sein.

### Schnell-Installation via Skript

```bash
bash schemas/install-yaml-schema.sh
```

### Manuelle Installation

Über die Befehlspalette (`Ctrl+Shift+P`) oder den Extensions-Marketplace:

```
ext install redhat.vscode-yaml
```

Alternativ direkt im Terminal:

```bash
code --install-extension redhat.vscode-yaml
```

---

## Wie es funktioniert

Die Datei [`.vscode/settings.json`](../.vscode/settings.json) bindet das Schema automatisch an alle YAML-Dateien unter `neo/tests/**` und `lunettes/tests/**`:

```json
"yaml.schemas": {
  "./schemas/lumiere-test.schema.json": [
    "neo/tests/**/*.yaml",
    "lunettes/tests/**/*.yaml"
  ]
}
```

Sobald die Extension installiert ist und das Repo in VS Code geöffnet wird, sind **Validierung**, **Autovervollständigung** und **Hover-Dokumentation** aktiv – ohne weitere Konfiguration.

---

## Schema-Übersicht

Das Schema (`lumiere-test.schema.json`) unterstützt zwei Dokumenttypen:

### `interaction` – Testszenarien

```yaml
interaction:
  id: mein-test
  version: 1.0
  video:
    wait_between_steps: 1000
    resolution:
      width: 1280
      height: 720
  environment:          # optional, lunettes
    start:
      script: ./env/start.sh
  data:
    runtime:
      base_url: https://meine-app.de
    actor:
      username: testuser
      password: geheim
  flow:
    - id: schritt-1
      interaction:
        type: click
        target:
          data-id: btn/submit
```

### `fragment` – Wiederverwendbare Bausteine

```yaml
fragment:
  id: mein-fragment
  parameters:
    - param1
    - param2
  outputs:
    - ergebnis
  flow:
    - id: schritt-1
      include: /auth/login.yaml
      with:
        username: "{{param1}}"
```

### Interaktionstypen

| `type`             | Beschreibung                                      |
|--------------------|---------------------------------------------------|
| `click`            | Element anklicken                                 |
| `fill`             | Textfeld befüllen                                 |
| `open`             | URL im Browser öffnen                             |
| `wait`             | Auf eine Bedingung warten (`until` + `timeout_ms`)|
| `select`           | Dropdown-Option wählen                            |
| `search-and-select`| Suche ausführen und Ergebnis auswählen            |
| `append`           | Text an vorhandenen Feldinhalt anhängen            |

### Element-Selektoren (`target`)

| Eigenschaft  | Verwendung                     |
|--------------|--------------------------------|
| `data-id`    | `data-id`-Attribut (neo)       |
| `testid`     | `data-testid`-Attribut (lunettes) |
| `text`       | Sichtbarer Text                |
| `url`        | URL                            |
| `id`         | HTML-`id`-Attribut             |
| `aria-label` | `aria-label`-Attribut          |

---

## Schema aktualisieren

Das Schema liegt in [`schemas/lumiere-test.schema.json`](lumiere-test.schema.json). Neue Interaktionstypen, Selektoren oder Eigenschaften können dort direkt ergänzt werden. VS Code liest das Schema beim nächsten Öffnen einer YAML-Datei neu ein.

---

## Semantischer Video-Plan

Zusätzlich liegt unter [`schemas/lumiere-semantic-video-plan.schema.json`](lumiere-semantic-video-plan.schema.json) ein JSON-Schema fuer das neue semantische Video-Planformat.

Zweck:

- fachliche Struktur von Kapiteln und Schritten abbilden
- Source-Time und Plan-Time sauber trennen
- generierte Remotion-Skripte semantisch statt timeline-zentriert modellieren

Das Schema ist fuer generatorinterne JSON-Artefakte gedacht, nicht fuer die YAML-Testszenarien selbst.

Weiterfuehrende Beschreibung und ein Beispielskript stehen in [`documentation/requirements/semantic-remotion-architecture.md`](../documentation/requirements/semantic-remotion-architecture.md).
