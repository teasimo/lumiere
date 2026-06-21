# Publish Helper

Dieses Verzeichnis enthaelt ein Script, das ein Szenarioscript auf eine Confluence-Seite publiziert.

## Was das Script macht

Das Script erwartet ein XML-Szenarioscript als ersten Parameter. Die Confluence-Page-ID als zweiter Parameter ist optional.

Es prueft:

- ob ein erfolgreich gerendertes Remotion-Video fuer dieses Szenario existiert
- ob die Confluence-Credentials in einer Umgebungsvariable vorhanden sind

Wenn alles vorhanden ist, dann:

- wird das letzte erfolgreich gerenderte Video als Attachment auf die Confluence-Seite hochgeladen
- wird auf der Confluence-Seite ein verwalteter Block geschrieben oder aktualisiert
- oder bei fehlender Page-ID zuerst die in Lunettes hinterlegte `confluence_page_id` fuer die Scenario-ID abgefragt und nur falls dort ebenfalls nichts hinterlegt ist eine neue Unterseite unter der in `scenario.config.json` definierten Parent-Seite angelegt
- und bei neu angelegter Seite deren `confluence_page_id` an Lunettes zurueckgemeldet

Der Seiteninhalt hat diesen Aufbau:

1. `Video`
2. eingebettetes Video
3. `Szenarioscript`
4. Szenarioscript direkt als Plain Text

Bereits vorhandener Inhalt auf der Seite bleibt nicht erhalten. Das Script ersetzt beim Publish den kompletten Seiteninhalt.

## Umgebungsvariable

Die Credentials muessen in genau einer Umgebungsvariable liegen:

`CONFLUENCE_PUBLISHHELPER_CREDENTIALS`

Unterstuetzte Formate:

Variante 1, empfohlen wenn Confluence fuer Token-Aufrufe eine Cloud-ID verlangt:

```json
{
  "baseUrl": "https://dein-tenant.atlassian.net",
  "cloudId": "11223344-a1b2-3b33-c444-def123456789",
  "accessToken": "atlassian-access-token"
}
```

Variante 2, klassischer Basic-Auth-Aufruf:

```json
{
  "baseUrl": "https://dein-tenant.atlassian.net",
  "email": "max.mustermann@example.com",
  "apiToken": "atlassian-api-token"
}
```

Beispiele in `bash`:

Cloud-ID-Modus:

```bash
export CONFLUENCE_PUBLISHHELPER_CREDENTIALS='{"baseUrl":"https://dein-tenant.atlassian.net","cloudId":"11223344-a1b2-3b33-c444-def123456789","accessToken":"atlassian-access-token"}'
```

Basic-Auth-Modus:

```bash
export CONFLUENCE_PUBLISHHELPER_CREDENTIALS='{"baseUrl":"https://dein-tenant.atlassian.net","email":"max.mustermann@example.com","apiToken":"atlassian-api-token"}'
```

Wenn die Umgebungsvariable fehlt oder ungueltig ist, bricht das Script mit einer Fehlermeldung ab.

Im Cloud-ID-Modus verwendet das Script `https://api.atlassian.com/ex/confluence/{cloudId}/...` fuer die Requests.
Fuer die Video-Einbettung verwendet das Script trotzdem die normale Tenant-URL unter `baseUrl`, damit das Video in Confluence direkt im Browser abgespielt werden kann.

## Aufruf

Direkt:

```bash
node scripts/publish-to-confluence/publish-scenario-to-confluence.mjs neo/interactions/demo.xml 2105671681 --scenario-id=1
```

Ohne bestehende Zielseite:

```bash
node scripts/publish-to-confluence/publish-scenario-to-confluence.mjs neo/interactions/demo.xml --scenario-id=1
```

Oder ueber `npm`:

```bash
npm run publish:scenario:confluence -- neo/interactions/demo.xml 2105671681 --scenario-id=1
```

## Voraussetzungen

- Node.js 20 oder neuer
- ein erfolgreich erzeugtes Remotion-Video unter `output/<szenario>/videogenerator`
- entweder Confluence-Page-ID als CLI-Parameter
- oder `scenario.config.json > scenario["publish-to-confluence"].parent_page_id`
- Scenario-ID als CLI-Parameter `--scenario-id=<id>`
- Confluence Cloud API-Zugriff
- entweder `baseUrl` plus `cloudId` und `accessToken`
- oder `baseUrl` plus `email` und `apiToken`
- fuer die Rueckmeldung neu angelegter Seiten: `LUNETTES_API_USERNAME` und `LUNETTES_API_PASSWORD`
- sowie `scenario.config.json > scenario["lunettes-job-watcher"].base_url` oder `scenario["test-script"].lunettes_api.base_url`

## Konfiguration in `scenario.config.json`

Beispiel:

```json
{
  "scenario": {
    "publish-to-confluence": {
      "parent_page_id": "2100000000"
    }
  }
}
```

Wenn weder eine Zielseite per CLI/Payload noch `parent_page_id` gesetzt ist, bricht das Script mit einer Fehlermeldung ab.

## Hinweis zur Video-Auswahl

Das Script sucht im passenden `videogenerator`-Ordner nach den Dateien `scenario-tts-remotion-render-*.json` und nimmt den neuesten Eintrag, dessen `outputVideo` existiert. `planOnly`-Laeufe werden ignoriert.
