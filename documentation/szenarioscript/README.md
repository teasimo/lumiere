# XML-SzenarioScript schreiben

Diese Doku beschreibt, wie XML-SzenarioScripts in diesem Repo aufgebaut sind, welche Tags und Attribute es gibt und was davon heute im Testscript- und Video-Generator wirklich ausgewertet wird.

Sie basiert auf:

- [schemas/szenarioscript.xsd](/home/simon/Documents/Programming/ssvn-controlling/lumiere/schemas/szenarioscript.xsd)
- [scripts/test-script-generator/generate-tests-from-scenario-xml.mjs](/home/simon/Documents/Programming/ssvn-controlling/lumiere/scripts/test-script-generator/generate-tests-from-scenario-xml.mjs)
- [scripts/test-script-generator/templates/spec-template.mjs](/home/simon/Documents/Programming/ssvn-controlling/lumiere/scripts/test-script-generator/templates/spec-template.mjs)
- [scripts/video-script-generator/run-annotated-video.mjs](/home/simon/Documents/Programming/ssvn-controlling/lumiere/scripts/video-script-generator/run-annotated-video.mjs)

## Zielbild

Ein SzenarioScript beschreibt:

- fachliche Struktur wie Kapitel, Schritte und Hinweise
- technische Interaktionen gegen die UI
- wiederverwendbare Fragmente
- Daten, Variablen und Template-Ausdruecke
- optionale Video-Marker fuer die Video-Pipeline

Kurz gesagt: Das XML ist die fachliche Quelle, aus der Testskripte und Video-Artefakte abgeleitet werden.

## Minimalbeispiel

```xml
<SzenarioScript id="login-demo" titel="Login Demo">
  <Daten>
    <Datensatz name="runtime">
      <Wert name="base_url" value="http://localhost:5173/app/home"/>
    </Datensatz>
  </Daten>

  <Variablen>
    <Variable name="username" default="demo"/>
    <Variable name="password" default="secret"/>
  </Variablen>

  <Gruppe>
    <VideoStart/>
    <Oeffnen url="{{runtime.base_url}}"/>
    <Eingabe data-testid="login-username-input">{{username}}</Eingabe>
    <Eingabe data-testid="login-password-input">{{password}}</Eingabe>
    <Click data-testid="login-submit-button"/>
    <VideoStop/>
  </Gruppe>
</SzenarioScript>
```

## Grundstruktur

Das Root-Element ist immer:

```xml
<SzenarioScript>
  ...
</SzenarioScript>
```

Zulaessige direkte Kindelemente im Root:

- `Notizen`
- `Einstellungen`
- `Daten`
- `Variablen`
- `Gruppe`

## Daten Und Variablen

### `Daten`

`Daten` sind strukturierte Eingabewerte, die per Template referenziert werden.

Einzelwerte:

```xml
<Daten>
  <Wert name="random" value="{{randomNumber()}}"/>
</Daten>
```

Datensaetze:

```xml
<Daten>
  <Datensatz name="runtime">
    <Wert name="base_url" value="https://neo-test.de"/>
  </Datensatz>
  <Datensatz name="actor">
    <Wert name="username" value="schule_05320_schulleitung"/>
    <Wert name="password" value="!Neo-2405Neo!"/>
  </Datensatz>
</Daten>
```

Verwendung:

- `{{random}}`
- `{{runtime.base_url}}`
- `{{actor.username}}`

### `Variablen`

Variablen sind benannte Werte fuer den Szenarioablauf.

```xml
<Variablen>
  <Variable name="start" default="{{heute()}}"/>
  <Variable name="ende" default="{{naechstenMonat()}}"/>
  <Variable name="titel" default="Mein Test"/>
</Variablen>
```

Regeln:

- `name` ist Pflicht
- `default` kann gesetzt werden
- `value` ist im XSD erlaubt, wird vom Testscript-Generator fuer Defaults aktuell aber nicht aktiv ausgewertet

Verwendung:

- `{{start}}`
- `{{ende}}`
- `{{titel}}`

## Template-Ausdruecke

Template-Ausdruecke koennen in Attributen und Textinhalten verwendet werden:

```xml
<Oeffnen url="{{runtime.base_url}}"/>
<Eingabe data-testid="field-a">{{meinWert}}</Eingabe>
```

Eingebaute zentrale Funktionen:

- `randomNumber()`
- `uuid()`
- `timestamp()`
- `dateToday()`
- `heute()`
- `gestern()`
- `morgen()`
- `naechsteWoche()`
- `naechstenMonat()`
- `naechstesJahr()`
- `letzteWoche()`
- `letztenMonat()`
- `letztesJahr()`
- `slug(text)`

Quelle: [scripts/test-script-generator/central-data-functions.mjs](/home/simon/Documents/Programming/ssvn-controlling/lumiere/scripts/test-script-generator/central-data-functions.mjs)

App-spezifische Funktionen koennen zusaetzlich aus `<app>/env/data-functions.mjs` kommen.

## Einstellungen

`Einstellungen` bilden einen frei verschachtelbaren Konfigurationsbaum.

Beispiel:

```xml
<Einstellungen>
  <Gruppe name="video">
    <Einstellung name="wait_between_steps" value="1000"/>
    <Einstellung name="scroll_delay_ms" value="35"/>
    <Einstellung name="scroll_step_px" value="20"/>
    <Einstellung name="autoscroll_smooth" value="false"/>
    <Gruppe name="resolution">
      <Einstellung name="width" value="1280"/>
      <Einstellung name="height" value="720"/>
    </Gruppe>
  </Gruppe>
</Einstellungen>
```

Werte werden automatisch grob typisiert:

- `true` / `false` -> Boolean
- ganze Zahlen -> Number
- alles andere -> String

Heute relevant fuer den Testscript-Generator sind vor allem Werte unter `video`, z. B.:

- `wait_between_steps`
- `scroll_delay_ms`
- `scroll_step_px`
- `autoscroll_smooth`
- `resolution.width`
- `resolution.height`

## Gruppen Und Strukturierung

`Gruppe` ist das zentrale Container-Element fuer Ablaufstruktur.

```xml
<Gruppe>
  <Kapitel>Benutzer anlegen</Kapitel>
  <Schritt>Maske oeffnen</Schritt>
  <Click data-testid="user-create-button"/>
</Gruppe>
```

Moegliche Inhalte in `Gruppe`:

- `Folie`
- `Kapitel`
- `Schritt`
- `VideoStart`
- `VideoStop`
- `Info`
- `Fragment`
- `Click`
- `Eingabe`
- `Auswahl`
- `Upload`
- `Anzeige`
- `Auslesen`
- `GET`
- `POST`
- `Gruppe`
- `Warten`
- `Oeffnen`
- `SucheAuswahl`
- `Wenn`

Attribut:

- `im-fragment-enthalten="true|false"`

Wirkung:

- Beim Einbinden eines Fragments werden Kinder mit `im-fragment-enthalten="false"` aus dem Fragment-Payload entfernt.
- `VideoStart` und `VideoStop` werden beim Fragment-Einbau ebenfalls ignoriert.

## Fachliche Struktur-Tags

Diese Tags strukturieren das Szenario und sind besonders fuer Video-/Narrationskontext relevant:

- `Folie`
- `Kapitel`
- `Schritt`
- `Info`
- `Notizen`

### `Info`

Beispiel:

```xml
<Info typ="Erklärung" interaktion="danach">
  Nach dem Speichern ist der Datensatz sichtbar.
</Info>
```

Zulaessige Attribute laut Schema:

- `typ`: `Erklärung | Zweck | Konsequenz | Hinweis | Bedingung | Warnung`
- `ausgabe`: `sofort | gruppe | overlay | audio`
- `interaktion`: `währenddessen | danach | vorige`

Wichtig:

- Diese Tags erzeugen keine Playwright-Testschritte.
- Sie sind fachliche bzw. videobezogene Metadaten.

## Video-Marker

### `VideoStart`

Markiert den Beginn des fachlichen Videobereichs.

### `VideoStop`

Markiert das Ende des fachlichen Videobereichs.

Wichtig:

- Der Testscript-Generator fuehrt diese Tags nicht als UI-Aktion aus.
- Der Video-Script-Generator nutzt sie, um relevante Segmente einzugrenzen.

## Selektoren Und Zielattribute

Die meisten Interaktions-Tags basieren auf einem gemeinsamen Selektor-Set.

Unterstuetzte Zielattribute:

- `data-testid`
- `data-id`
- `id`
- `text`
- `role`
- `label`
- `aria-label`
- `komponententyp`
- `selektor-regex`
- `treffer-index`

Praktisch bevorzugt:

- `data-testid` fuer moderne testbare UI
- `data-id` fuer bestehende NEO-Strukturen
- `role` + `text` oder `label` fuer semantische Komponenten

### `treffer-index`

Steuert, welcher Treffer benutzt wird:

- `0` oder weggelassen: erster Treffer
- positive Zahl: `nth(index)`
- negative Zahl: vom Ende her

### `selektor-regex`

Wenn `true`, wird z. B. `data-id` als Regex-basiertes Locator-Kriterium behandelt.

Beispiel:

```xml
<Click data-id="g_prp_org_delegate/\$data\d+/prp_name" selektor-regex="true" treffer-index="-1"/>
```

### `komponententyp`

Hilft beim Filtern, wenn mehrere Elemente denselben technischen Selektor teilen.

Beispiel:

```xml
<Click
  data-id="g_prp_org_delegate/\$data\d+/prp_name"
  selektor-regex="true"
  treffer-index="-1"
  komponententyp="input"/>
```

## Interaktionstags

### `Oeffnen`

Oeffnet eine URL.

```xml
<Oeffnen url="{{runtime.base_url}}"/>
```

Attribute:

- `url`
- `neu` ist im XSD erlaubt, wird aktuell vom Testscript-Generator nicht gesondert umgesetzt

### `Click`

Klick auf ein Element.

```xml
<Click data-testid="login-submit-button"/>
<Click text="Ja"/>
<Click role="option" text="{{berechtigung}}"/>
```

### `Eingabe`

Setzt einen Wert in ein Eingabefeld.

```xml
<Eingabe data-testid="login-username-input">{{username}}</Eingabe>
<Eingabe data-id="g_prp_org_delegate/$data0/bbo_wirksam_ab">{{start}}</Eingabe>
```

Der Wert kommt aus:

- dem Textinhalt des Elements
- oder alternativ aus `text` im Attributkontext

### `Auswahl`

Waehlt einen Wert in einer Select-/Combobox-aehnlichen Komponente.

```xml
<Auswahl data-testid="finance-pt-auftrag-form-los-select">1</Auswahl>
<Auswahl data-id="infobeschaffer-container/infog_infob_group/infobeschaffer">{{moderator.name}}</Auswahl>
```

### `Upload`

Lädt eine Datei in ein Upload-Control.

```xml
<Upload data-id="g_scp_zvb/$data0/file_zielvereinbarung">pdfdummy.pdf</Upload>
```

Der Textinhalt ist der Dateipfad bzw. Dateiname.

Mit `temp="true"` wird stattdessen der Inhalt zwischen Start- und End-Tag als temporaere Upload-Datei verwendet. `dateiname` ist dann Pflicht. Variablen im Inhalt werden zur Laufzeit aufgeloest.

```xml
<Upload data-id="g_scp_zvb/$data0/file_zielvereinbarung" temp="true" dateiname="beispiel.csv">kundennummer;name
{{kunde.id}};{{kunde.name}}</Upload>
```

### `Warten`

Wartet auf einen Zustand oder einfach fuer eine Zeitspanne.

Beispiele:

```xml
<Warten data-testid="save-button" status="aktiviert"/>
<Warten data-id="overlay/spinner" status="nicht-sichtbar" timeout-ms="10000"/>
<Warten timeout-ms="2000"/>
```

Unterstuetzte `status`-Werte:

- `sichtbar`
- `nicht-sichtbar`
- `aktiviert`
- `deaktiviert`
- `vorhanden`
- `nicht-vorhanden`

Wichtig:

- Mit Zielselektor wartet der Schritt auf einen UI-Zustand.
- Ohne Zielselektor und mit `timeout-ms` wirkt der Schritt als reines Sleep/Delay.

### `SucheAuswahl`

Sucht in einem Such-/Select-Widget und waehlt danach ein Ergebnis aus.

```xml
<SucheAuswahl
  data-id="person-search"
  suchwert="{{empfaenger_nachname}}"
  result-selector=".q-menu .q-item"
  treffer-index="0"/>
```

Wichtige Attribute:

- `suchwert` ist Pflicht
- `result-selector` wird vom Generator verwendet, obwohl es nicht im XSD steht
- `treffer-index` steuert das Ergebnis innerhalb der Trefferliste
- `wartezeit-ms` ist im XSD erlaubt, wird aktuell vom Generator nicht spezifisch umgesetzt

Wichtig:

- Der Generator erwartet fuer `SucheAuswahl` aktuell ein `data-id`-basiertes Ziel.

### `Auslesen`

Liest Werte aus der UI oder aus Downloads.

Heute vom Testscript-Generator unterstuetzt sind:

- `quelle="download"` zusammen mit `auslesen-regex`
- `quelle="text"`
- `quelle="value"`
- `quelle="url"`

Beispiel:

```xml
<Auslesen
  quelle="download"
  in-variable="freischaltcode"
  auslesen-regex="Freischaltcode:\s*([A-Z0-9-]+)"/>
```

Beispiel fuer UI-Auslesen:

```xml
<Auslesen
  data-id="g_benutzerkonto/p_benutzerkonto/b_kennung"
  in-variable="zugangsname"/>
```

Schema-seitig zulaessige `quelle`-Werte:

- `text`
- `value`
- `attribute`
- `url`
- `download`

Wichtig:

- `quelle="text"` ist der Default.
- Bei `quelle="text"` liest der Generator bei Textfeldern (`input`, `textarea`, `select`) automatisch den Feldwert.
- `quelle="value"` liest explizit den Feldwert.
- `quelle="url"` liest die aktuelle Seiten-URL.
- `quelle="attribute"` ist im Schema vorhanden, wird im Testscript-Generator aktuell aber nicht unterstuetzt.
- Fuer `download` ist `in-variable` empfohlen. `variable` wird als Legacy-Fallback akzeptiert.

### `GET` und `POST`

Ruft eine API auf und liest Werte aus der Response in Runtime-Variablen.

Beispiel:

```xml
<GET url="https://example.internal/api/users/42" payload="{&quot;includeRoles&quot;:true}">
  <Auslesen parameter="user.name" in-variable="api.userName"/>
  <Auslesen parameter="roles[0]" in-variable="api.firstRole"/>
</GET>
```

```xml
<POST url="https://example.internal/api/login" payload="{&quot;username&quot;:&quot;{{api.userName}}&quot;,&quot;password&quot;:&quot;secret&quot;}">
  <Auslesen parameter="token" in-variable="api.token"/>
</POST>
```

Beispiel mit Regex auf einem Response-Feld:

```xml
<GET url="https://mailpit.example/api/v1/message/{{mailpit.latestMessageId}}">
  <Auslesen
    parameter="Text"
    regex="(https://neo-test\\.de/[^\\s&quot;'&lt;&gt;]+)"
    in-variable="freischaltUrl"/>
</GET>
```

Wichtig:

- `url` ist Pflicht.
- `payload` ist optional und kann Runtime-Variablen wie `{{api.userName}}` enthalten.
- `payload` wird, falls moeglich, als JSON geparst und als Request-Body gesendet.
- Innerhalb von `GET`/`POST` ist nur `<Auslesen .../>` vorgesehen.
- `parameter` liest einen Pfad aus der JSON-Response, z. B. `token`, `user.name` oder `roles[0]`.
- `regex` ist optional und wird auf den gelesenen Wert angewendet.
- falls die Regex eine Capture-Group enthaelt, wird Gruppe 1 gespeichert, sonst der gesamte Match.
- `in-variable` ist empfohlen, `variable` wird auch hier als Legacy-Fallback akzeptiert.

### `PinBriefMailAuslesen`

Liest aus einer MailHog-Mail den CSV-Anhang `part/2` und schreibt den Wert aus der Spalte `aktivierungscode` in eine Runtime-Variable.

Beispiel:

```xml
<PinBriefMailAuslesen
  url="https://mailhog.example.internal"
  vornamen="{{person.vorname}}"
  familienname="{{person.nachname}}"
  in-variable="freischaltcode"/>
```

Oder per CSV-Zeile:

```xml
<PinBriefMailAuslesen
  url="https://mailhog.example.internal"
  zeilen-index="0"
  in-variable="freischaltcode"/>
```

Voraussetzung:

- `url` muss auf die MailHog-Basis-URL zeigen

Wichtig:

- der Generator verwendet intern denselben Ablauf wie:
  - `GET <url>/api/v1/messages`
  - erste Mail-ID lesen
  - `GET <url>/api/v1/message/<ID>/part/2`
- `url` ist ein Pflichtattribut
- entweder `zeilen-index` verwenden oder `vornamen` plus `familienname`
- `in-variable` ist empfohlen, `variable` wird als Legacy-Fallback akzeptiert
- der Schritt pollt MailHog kurz an, damit frisch eingetroffene Mails noch gefunden werden

### `Anzeige`

`Anzeige` wird aktuell wie ein `Click` behandelt.

```xml
<Anzeige data-id="my-control"/>
```

Wenn du fachlich wirklich nur einen Klick meinst, ist `Click` klarer.

## Bedingungen Mit `Wenn` Und `Sonst`

`Wenn` ist ein bedingter Branch im Ablauf.

Beispiel:

```xml
<Wenn data-id="g_prp_org_delegate/btn/action-insert-scope" status="nicht-sichtbar">
  <Click data-id="btn/action-expandcollapseall"/>
  <Sonst>
    <Info typ="Hinweis">Bereich war bereits sichtbar.</Info>
  </Sonst>
</Wenn>
```

Moegliche Bedingungsattribute:

- dieselben Zielattribute wie bei Interaktionen
- `status`
- `timeout-ms`
- `attribut`
- `attribut-wert`

Wichtig zur heutigen Implementierung:

- Der Testscript-Generator wertet fuer `Wenn` aktuell vor allem Zielselektor + `status` aus.
- `attribut` und `attribut-wert` sind im XSD vorhanden, werden in der aktuellen Generatorlogik nicht aktiv in eine Guard-Bedingung umgesetzt.

Regeln:

- alles vor `Sonst` ist Then-Branch
- alles in `Sonst` ist Else-Branch
- verschachtelte `Wenn` sind moeglich

## Fragmente

Fragmente erlauben Wiederverwendung.

### Fragment-Definition

Ein Fragment ist ein eigenes XML mit Root `SzenarioScript` und `fragment="true"`.

```xml
<SzenarioScript id="neo-login" fragment="true">
  <Variablen>
    <Variable name="url"/>
    <Variable name="username"/>
    <Variable name="password"/>
  </Variablen>
  <Gruppe>
    <Oeffnen url="{{url}}"/>
    <Eingabe data-testid="login-username-input">{{username}}</Eingabe>
    <Eingabe data-testid="login-password-input">{{password}}</Eingabe>
    <Click data-testid="login-submit-button"/>
  </Gruppe>
</SzenarioScript>
```

### Fragment-Einbindung

```xml
<Fragment name="neo-login">
  <Parameter name="url" value="{{runtime.base_url}}"/>
  <Parameter name="username" value="{{actor.username}}"/>
  <Parameter name="password" value="{{actor.password}}"/>
</Fragment>
```

Oder Variablen-Mapping aus dem Parent-Kontext:

```xml
<Fragment name="neo-login">
  <Auslesen variable="username" in-variable="actor.username"/>
  <Auslesen variable="password" in-variable="actor.password"/>
</Fragment>
```

Regeln:

- `name` ist Pflicht
- Parameter werden in den Variablenkontext des Fragments gelegt
- `Auslesen` innerhalb von `Fragment` mapped Parent-Variablen in Fragment-Variablen
- bei `Auslesen` ist `variable` der Name im Fragment und `in-variable` der Pfad im Parent-Kontext
- fehlende Pflichtparameter ohne Default fuehren zu einem Fehler

Aktuelle Aufloesung:

- in Lunettes-Kontexten werden Fragmente ueber die Lunettes-API aufgeloest
- das Fragment selbst muss wieder Root `SzenarioScript` haben

## Schritt-IDs

Interaktionsschritte bekommen automatisch aufgeloeste IDs auf Basis von:

- Root-Szenario bzw. Fragment
- Parent-Include-Zeile
- Quellzeile im XML

Beispiele:

- `[Szenario-7]-Zeile-16`
- `[Szenario-7]-Zeile-14-[lunettes-login]-Zeile-10`

Autoscroll-Hilfsschritte leiten sich davon ab:

- `[Szenario-7]-Zeile-16__autoscroll`

## Was Wird Vom Testscript-Generator Wirklich Als Schritt Ausgefuehrt

Als echte Testschritte relevant:

- `Oeffnen`
- `Click`
- `Eingabe`
- `Auswahl`
- `Upload`
- `Warten`
- `SucheAuswahl`
- `Auslesen` mit `quelle="download"`
- `Wenn` indirekt als bedingter Branch

Nicht als Playwright-Schritt ausgefuehrt:

- `Notizen`
- `Info`
- `Folie`
- `Kapitel`
- `Schritt`
- `VideoStart`
- `VideoStop`

## Was Der Video-Script-Generator Direkt Aus Dem XML Nutzt

Direkt relevant:

- `SzenarioScript.id`
- `SzenarioScript.titel`
- `VideoStart`
- `VideoStop`
- strukturelle Inhalte wie `Kapitel`, `Schritt`, `Info` fuer spaetere Narrations-/Präsentationskontexte

Der Video-Script-Generator konsumiert zusaetzlich:

- `resolved.json`
- `test-resolved.xml`
- `scenario-step-timeline.json`
- Rohvideo, Trace und weitere Artefakte aus dem Testlauf

## Praktische Schreibregeln

- bevorzuge `data-testid` oder `data-id` statt reinem Text-Matching
- nutze `role`, `label` und `aria-label`, wenn die Komponente semantisch selektiert werden soll
- verwende `treffer-index`, wenn ein Selektor mehrfach matcht
- setze `selektor-regex="true"`, wenn du bewusst Regex-Matching auf `data-id` brauchst
- halte wiederkehrende Ablaeufe in Fragmenten
- markiere nur den fachlich sichtbaren Videoteil mit `VideoStart` und `VideoStop`
- benutze `Variablen` und `Daten`, statt Werte in vielen Schritten zu duplizieren

## Typische Stolperfallen

- `Auslesen` ist heute nicht allgemein implementiert. Sicher unterstuetzt ist nur `quelle="download"`.
- `result-selector` bei `SucheAuswahl` wird vom Generator benutzt, steht aber nicht im XSD.
- `neu` bei `Oeffnen` und `wartezeit-ms` bei `SucheAuswahl` stehen im XSD, haben aktuell aber keine eigene Generatorlogik.
- `attribut` und `attribut-wert` bei `Wenn` sind schema-seitig vorhanden, aber aktuell nicht die primaere Bedingungslogik.
- wenn ein Fragment Pflichtvariablen ohne Default erwartet und kein `Parameter` geliefert wird, bricht die Aufloesung ab.
- fuer komplexe Eingabekomponenten braucht die Zielanwendung oft passende Fill-Strategien unter `<app>/env/fill-strategies.mjs`

## Grösseres Beispiel

```xml
<SzenarioScript id="berechtigung-delegieren" titel="Berechtigung delegieren">
  <Daten>
    <Datensatz name="runtime">
      <Wert name="base_url" value="https://neo-test.de"/>
    </Datensatz>
    <Datensatz name="actor">
      <Wert name="username" value="schule_05320_schulleitung"/>
      <Wert name="password" value="!Neo-2405Neo!"/>
    </Datensatz>
  </Daten>

  <Variablen>
    <Variable name="start" default="{{heute()}}"/>
    <Variable name="ende" default="{{naechstenMonat()}}"/>
    <Variable name="empfaenger_vorname" default="Cheryl"/>
    <Variable name="empfaenger_nachname" default="Edwards"/>
    <Variable name="berechtigung" default="Meldedatenimport"/>
    <Variable name="funktionsquelle" default="Schulleitung"/>
  </Variablen>

  <Gruppe im-fragment-enthalten="false">
    <Fragment name="neo-login">
      <Parameter name="url" value="{{runtime.base_url}}"/>
      <Parameter name="username" value="{{actor.username}}"/>
      <Parameter name="password" value="{{actor.password}}"/>
    </Fragment>
  </Gruppe>

  <Gruppe>
    <VideoStart/>
    <Kapitel>Berechtigungen delegieren</Kapitel>
    <Info typ="Erklärung">Personen mit einer Leitungsfunktion koennen Berechtigungen delegieren.</Info>

    <Fragment name="hauptmenüeintrag-öffnen">
      <Parameter name="hauptmenue-data-id" value="menu/link/mein-profil/"/>
    </Fragment>

    <Click text="Einstellungen"/>

    <Wenn data-id="g_prp_org_delegate/btn/action-insert-scope" status="nicht-sichtbar">
      <Click data-id="btn/action-expandcollapseall"/>
    </Wenn>

    <Click data-id="g_prp_org_delegate/btn/action-insert-scope"/>
    <Click data-id="g_prp_org_delegate/\$data\d+/funktion_anzeige" selektor-regex="true" treffer-index="-1"/>
    <Click role="option" text="{{funktionsquelle}}"/>

    <Click data-id="g_prp_org_delegate/\$data\d+/prp_name" selektor-regex="true" treffer-index="-1" komponententyp="input"/>
    <Click role="option" text="{{berechtigung}}"/>

    <Click data-id="g_prp_org_delegate/\$data\d+/empfaenger_display_name" selektor-regex="true" treffer-index="-1"/>
    <Click role="option" text="{{empfaenger_nachname}}, {{empfaenger_vorname}}"/>

    <Eingabe data-id="g_prp_org_delegate/\$data\d+/bbo_wirksam_ab" selektor-regex="true" treffer-index="-1">{{start}}</Eingabe>
    <Eingabe data-id="g_prp_org_delegate/\$data\d+/bbo_wirksam_bis" selektor-regex="true" treffer-index="-1">{{ende}}</Eingabe>

    <Click data-id="btn/action-save"/>
    <Click text="Ja"/>
    <VideoStop/>
  </Gruppe>
</SzenarioScript>
```

## Validieren Und Ausprobieren

XML in Testscript umsetzen:

```bash
npm run generate:testscript -- neo/interactions/_lunettes-job-watcher/szenario-7/source.xml
```

Testscript ausfuehren:

```bash
npm run check:testscript -- neo/interactions/_lunettes-job-watcher/szenario-7/source.xml --scenario-id 7
```

Video-Plan erzeugen:

```bash
npm run generate:videoscript -- neo/interactions/_lunettes-job-watcher/szenario-7/source.xml --scenario-id=7
```

## Referenzen

- [Readme.md](/home/simon/Documents/Programming/ssvn-controlling/lumiere/Readme.md)
- [scripts/video-script-generator/README.md](/home/simon/Documents/Programming/ssvn-controlling/lumiere/scripts/video-script-generator/README.md)
- [documentation/adr/0001-fill-strategies-for-component-interactions.md](/home/simon/Documents/Programming/ssvn-controlling/lumiere/documentation/adr/0001-fill-strategies-for-component-interactions.md)
