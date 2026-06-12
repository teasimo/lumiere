# Publish Helper

Dieses Verzeichnis enthaelt ein Script, das ein Szenarioscript auf eine Confluence-Seite publiziert.

## Was das Script macht

Das Script erwartet ein XML-Szenarioscript als Parameter.

Es prueft:

- ob das XML eine `lunettes-id` hat
- ob ein erfolgreich gerendertes Remotion-Video fuer dieses Szenario existiert
- ob die Confluence-Credentials in einer Umgebungsvariable vorhanden sind
- ob das Lunettes-Szenario per API geladen werden kann und eine `confluence_page_id` liefert

Wenn alles vorhanden ist, dann:

- wird das letzte erfolgreich gerenderte Video als Attachment auf die Confluence-Seite hochgeladen
- wird auf der Confluence-Seite ein verwalteter Block geschrieben oder aktualisiert
- wird optional zusaetzlich an Lunettes gemeldet, dass das Szenario auf Confluence veroeffentlicht wurde

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
node publishhelper/publish-scenario-to-confluence.mjs neo/interactions/demo.xml
```

Oder ueber `npm`:

```bash
npm run publish:scenario:confluence -- neo/interactions/demo.xml
```

## Voraussetzungen

- Node.js 20 oder neuer
- gueltige `lunettes-id` im Wurzelknoten `<SzenarioScript>`
- ein erfolgreich erzeugtes Remotion-Video unter `output/<szenario>/videogenerator`
- Confluence Cloud API-Zugriff
- entweder `baseUrl` plus `cloudId` und `accessToken`
- oder `baseUrl` plus `email` und `apiToken`
- `scenario.config.json > scenario["test-script"].lunettes_api.base_url`
- `LUNETTES_API_USERNAME` und `LUNETTES_API_PASSWORD`

## Lunettes-Integration

Das Publish-Script laedt vor dem Confluence-Publish zuerst das Szenario aus Lunettes:

- `GET {base_url}/api/anfo/szenario/{lunettes-id}`

Aus der Antwort wird `confluence_page_id` gelesen und als Zielseite fuer den Confluence-Publish verwendet.

Nach erfolgreichem Confluence-Update sendet das Script anschliessend:

- `POST {base_url}/api/anfo/szenario/{lunettes-id}/confluence-veroeffentlicht`

Wenn Lunettes-Konfiguration, `lunettes-id`, Credentials, `confluence_page_id` oder einer der Requests fehlen bzw. fehlschlagen, beendet das Script den Publish-Lauf mit Fehler.

## Hinweis zur Video-Auswahl

Das Script sucht im passenden `videogenerator`-Ordner nach den Dateien `scenario-tts-remotion-render-*.json` und nimmt den neuesten Eintrag, dessen `outputVideo` existiert. `planOnly`-Laeufe werden ignoriert.
