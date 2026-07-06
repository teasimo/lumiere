# Video-Script-Generator

## Zeitmodell

Diese Doku beschreibt das Zeitmodell des Video-Script-Generators. Sie dokumentiert bewusst die Begriffe, Umrechnungen und Fehlerquellen, die sich in der Entwicklung gezeigt haben.

Wichtig zum aktuellen Stand:

- Der Pfad `--scenario-tts` basiert fuer Schrittsegmente, Click-Marker und Viewport jetzt primaer auf `scenario-step-timeline.json`.
- Der Pfad `--scenario-tts` liest Rohvideo und Timeline bevorzugt aus `szenario/<id>/<version>/testscript/{rohvideo,timeline}` und faellt nur fuer Altbestaende auf `output/*` zurueck.
- Die Playwright-Trace bleibt nur noch fuer explizite Altpfade wie `--annotate-only` und fuer trace-spezifische Debug-/Migrationsfaelle relevant.
- Diese Doku beschreibt deshalb weiterhin das Trace-Modell, aber nicht mehr als einzige Quelle fuer die Video-Zeitdaten.

Betroffene Kernskripte:

- `scripts/video-script-generator/annotate-video-from-trace.mjs`
- `scripts/video-script-generator/run-annotated-video.mjs`
- `scripts/video-script-generator/semantic-remotion.mjs`
- `scripts/video-script-generator/runtime/semantic-runtime.tsx`

## Grundbegriffe

Es gibt vier verschiedene Zeitebenen:

1. Timeline-/Trace-Zeit
2. Quellvideo-Zeit
3. Clip-Zeit
4. Finale Plan-/Video-Zeit

Diese Ebenen duerfen nicht vermischt werden.

## 1. Timeline-/Trace-Zeit

Im aktuellen System gibt es zwei moegliche Rohquellen fuer Interaktionszeitpunkte:

- die persistierte Szenario-Timeline `scenario-step-timeline.json`
- die Playwright-Trace (`test.trace`, `0-trace.trace`)

Fuer `--scenario-tts` gilt:

- Schrittsegmente kommen aus `timeline.video.stepSegments`, ersatzweise aus `timeline.steps`.
- Click-Marker kommen aus `timeline.video.clickMarkers`, ersatzweise aus Click-Schritten mit `clickPoint` und `clickedAtMs`.
- Der Viewport kommt aus `timeline.video.viewport`.

Die Trace-Datei liefert weiterhin nicht nur eine einzige Zeitbasis:

- `test.trace` enthaelt Test- und `test.step`-Events.
- `0-trace.trace` enthaelt Browser-/Frame-/Interaktions-Events, darunter die tatsaechlichen Click-Events und Pointer-Koordinaten.

Wichtige Erfahrung:

- `test.trace` und `0-trace.trace` koennen auf unterschiedlichen Zeitbasen laufen.
- Deshalb duerfen Zeiten aus beiden Dateien nicht direkt verglichen oder gemischt werden.

Aktuelle Entscheidung:

- In `annotate-video-from-trace.mjs` werden die Events beider Dateien zusammen gelesen.
- Fuer `0-trace.trace` wird ein Offset gegen `test.trace` berechnet.
- Erst danach werden Click-Zeitpunkte und Step-Zeitpunkte gemeinsam verarbeitet.

Ohne diese Normalisierung entstehen Marker, die mehrere Sekunden zu spaet sind, obwohl die relativen Zeiten innerhalb der jeweiligen Trace-Datei korrekt aussehen.

## 2. Quellvideo-Zeit

Die Quellvideo-Zeit ist die Zeitachse des Rohvideos aus dem Testlauf.

Eigenschaften:

- Einheit: Millisekunden
- Bezugspunkt: Anfang des aufgenommenen Rohvideos
- Beispiel: `sourceStartMs`, `sourceEndMs`, `atSourceMs`

Diese Zeit ist die wichtigste technische Referenz fuer die semantische Planung.

Regel:

- Sobald die Trace-Zeit in eine Videoposition uebersetzt wurde, sollte moeglichst nur noch in Quellvideo-Zeit weitergerechnet werden.

## 3. Clip-Zeit

Die Clip-Zeit ist die Zeit innerhalb eines ausgeschnittenen Bereichs des Rohvideos.

Sie entsteht, wenn aus dem gesamten Rohvideo nur ein praesentationsrelevanter Bereich verwendet wird:

- per `VideoStart`/`VideoStop`
- per `presentation.video`
- per expliziten `--clip-start-ms` / `--clip-end-ms`

Beispiel:

- Das Rohvideo startet bei `0ms`.
- Der relevante Videobereich startet erst bei `44619ms`.
- Dann ist `44619ms` in Quellvideo-Zeit, aber `0ms` in Clip-Zeit.

Aktuelle Entscheidung:

- `annotate-video-from-trace.mjs` erzeugt Click-Marker und Step-Segmente clip-relativ.
- `semantic-remotion.mjs` rechnet sie bei Bedarf mit `presentationRange.startMs` wieder in Quellvideo-Zeit zurueck.

Regel:

- Clip-Zeit ist eine Transport-/Austauschform fuer Plans.
- Die semantische Remotion-Planung arbeitet intern wieder mit Quellvideo-Zeit.

## 4. Finale Plan-/Video-Zeit

Die finale Plan-Zeit ist die Zeitachse des erzeugten Remotion-Plans.

Sie unterscheidet sich von der Quellvideo-Zeit, weil im finalen Video zusaetzliche Dauer eingefuegt werden kann:

- Click-Freeze
- TTS-bedingte Pausen
- Kapitelkarten
- Folien
- Intro

Beispiel:

- Im Quellvideo liegt ein Click bei `10000ms`.
- Vor diesem Click wird ein Freeze von `800ms` eingefuegt.
- Dann liegt der Marker im finalen Plan spaeter als `10000ms`.

Aktuelle Entscheidung:

- `runtime/semantic-runtime.tsx` berechnet die finale Plan-Zeit aus Quellvideo-Zeit plus allen vorher eingefuegten Holds.
- Diese Umrechnung passiert in `sourceToPlanOffsetMs(...)`.

## Schrittfenster

Ein Interaktionsschritt wird nicht exakt auf seine nackte Laufzeit reduziert.

Aktuell werden in `semantic-remotion.mjs` um jeden Schritt Puffer gelegt. Diese sind konfigurierbar ueber `scenario["video-script"].presentation.step_timing`:

- `before_interaction_ms`
- `after_interaction_ms`

Default:

- `before_interaction_ms = 500`
- `after_interaction_ms = 500`

Zweck:

- Vor dem eigentlichen Click/Fill soll kurz der Kontext sichtbar sein.
- Nach der Interaktion soll das Ergebnis ebenfalls kurz sichtbar bleiben.

Dadurch entstehen zwei Fenster pro Schritt:

- `originalStartMs` / `originalEndMs`
- `sourceStartMs` / `sourceEndMs`

Unterschied:

- `original...` beschreibt die nackte, aus der Timeline abgeleitete Schrittzeit.
- `source...` beschreibt das fuer das Video verwendete Fenster inklusive Vor-/Nachlauf.

Wichtige Erfahrung:

- Diese breiteren `source...`-Fenster koennen sich ueberlappen.
- Marker-Zuordnungen duerfen deshalb nicht blind auf Basis der breiten Clip-Fenster passieren.

Aktuelle Entscheidung:

- Click-Marker werden pro Marker genau einem Schritt zugeordnet.
- Bevorzugt wird das `original...`-Fenster.
- Nur falls dort nichts passt, wird auf das breitere `source...`-Fenster zurueckgefallen.

Sonst entstehen doppelte Marker oder spaete Wiederholungen in Folgeschritten.

## Click-Marker

Ein Click-Marker braucht:

- einen Zeitpunkt
- eine Position (`x`, `y`)
- eine Dauer

### Quelle des Zeitpunkts

Die Position und der fruehe Interaktionszeitpunkt kommen aus `0-trace.trace`:

- `Frame.click`
- zugehoeriges `input`-Event mit `point`

Wichtige Erfahrung:

- Der frueheste brauchbare Markerzeitpunkt ist nicht das spaete `after`-Event.
- Ein spaeter Zeitpunkt verschiebt Marker sichtbar nach hinten.

Aktuelle Entscheidung:

- Der Markerzeitpunkt wird moeglichst frueh aus dem Browser-Trace genommen.
- `annotate-video-from-trace.mjs` bevorzugt fruehe Eventzeiten.

### Quelle der Position

Die Marker-Position kommt aus dem `input`-Event des Frame-Traces.

Wichtige Erfahrung:

- `test.trace` allein reicht nicht fuer verlassliche Markerpositionen.
- Die eigentlichen Pointer-Daten liegen in `0-trace.trace`.

## Click-Freeze / Hold

Ein Click kann im finalen Video mit einem zusaetzlichen Hold versehen werden.

Aktuelle Parameter:

- `beforeMs`
- `highlightDurationMs`
- `afterMs`
- `fadeMs`

Semantisch wichtig sind vor allem:

- `freezeBeforeMs`
- `highlightDurationMs`
- `afterMs`

Aktuelle Entscheidung:

- Wenn `CLICKMARKER_FREEZE = true`, wird vor dem Click ein Hold eingefuegt.
- Der Hold startet bei `clickAtSourceMs - freezeBeforeMs`.
- Der Marker selbst wird auf denselben Hold-Anker gesetzt.

Das bedeutet:

- Der Ring erscheint bereits waehrend des eingefrorenen Frames.
- Das ist gewollt.
- Der Marker soll nicht erst nach dem Freeze erscheinen.

## Narrationspausen

TTS kann zusaetzliche Dauer erzeugen.

Beispiele:

- Ein Schrittfenster ist kuerzer als die benoetigte Sprachdauer.
- Eine `Info` mit `interaktion="währenddessen"` darf den Schritt optisch begleiten.
- Eine normale `Info` blockiert ggf. den weiteren Ablauf.

Aktuelle Entscheidung:

- Narrationen werden zunaechst auf Schritt-/Ankerzeiten gelegt.
- Danach wird geprueft, ob zusaetzliche Pausen eingefuegt werden muessen.
- Diese Pausen werden als Holds in den finalen Plan ueberfuehrt.

Wichtige Folge:

- Finale Video-Zeit ist nie einfach nur Rohvideo-Zeit.
- Jede vorangehende Pause verschiebt alles, was danach kommt.

## Kapitelkarten und Folien

Kapitelkarten und Folien arbeiten technisch wie Standbilder mit eingefuegter Dauer.

Prinzip:

- Die Quelle ist ein minimales Video-Segment von `1ms`.
- Sichtbare Dauer entsteht nicht durch mehr Rohvideo, sondern durch Pausen/Holds.

Deshalb:

- Kapitelkarten haben fast keine Quellvideo-Dauer.
- Ihre sichtbare Dauer entsteht fast vollstaendig in der finalen Plan-Zeit.

## Frames

Die Laufzeit im Remotion-Plan wird am Ende in Frames uebersetzt.

Relevante Funktionen in `runtime/semantic-runtime.tsx`:

- `msToFrameStart`
- `msToFrameEndExclusive`
- `msToDurationFrames`
- `msToDurationFramesCeil`

Wichtige Regeln:

- Start-Frames werden mit `floor(...)` bestimmt.
- End-Frames werden je nach Kontext mit `ceil(...)` bestimmt.
- Dauer wird nie negativ und nie `0` Frames.

Das vermeidet:

- leere Sequenzen
- abgeschnittene Einzelbild-Holds
- Marker oder Kapitelkarten mit `0` Frames

## Absolute und relative Zeiten

Zur Klarheit:

- Absolute Zeit im Rohvideo: `source...Ms`
- Relative Zeit im ausgeschnittenen Clip: clip-relativ
- Relative Zeit im finalen Renderplan: plan-relativ

Regel:

- Variablennamen sollen die Zeitbasis ausdruecken.
- Wenn das nicht klar benannt ist, entsteht schnell ein systematischer Versatz.

## Typische Fehlerquellen

### 1. Zwei unterschiedliche Trace-Uhren mischen

Symptom:

- Marker sind ueberall um mehrere Sekunden verschoben.

Ursache:

- `test.trace` und `0-trace.trace` wurden ohne Offsets zusammen verwendet.

Loesung:

- Browser-Trace auf Test-Trace-Zeitbasis normalisieren.

### 2. Marker an spaetes Event haengen

Symptom:

- Marker erscheint sichtbar nach dem tatsaechlichen Click.

Ursache:

- `after` oder ein spaetes logisches Ende wurde statt des fruehen Pointer-Events genommen.

Loesung:

- fruehen, pointernahen Zeitpunkt verwenden

### 3. Marker mehrfach Schritten zuordnen

Symptom:

- derselbe Marker erscheint noch einmal spaeter
- Verschiebung wirkt "massiv", obwohl eigentlich eine Duplizierung vorliegt

Ursache:

- ueberlappende Schrittfenster

Loesung:

- jeder Marker wird genau einem Schritt zugeordnet

### 4. Hold nicht in Plan-Zeit eingerechnet

Symptom:

- Marker, Callouts oder Narration sitzen relativ zum Rohvideo richtig, aber relativ zum finalen Video zu frueh

Ursache:

- eingefuegte Holds wurden in der finalen Zeitberechnung nicht beruecksichtigt

Loesung:

- alle plan-relevanten Elemente ueber `sourceToPlanOffsetMs(...)` oder aequivalente Logik verschieben

### 5. `info-before`-Narration spielt zu spaet (Koordinaten-Verwechslung)

Symptom:

- Der TTS-Ton einer `<Info>` (ohne `interaktion`-Attribut) ist waehrend des Freeze-Bilds nicht zu hoeren.
- Stattdessen laeuft die Narration spaeter, waehrend nachfolgende Clips normal weiterlaufen.
- Im `semantic-video-plan.json` liegt `narration.atMs` deutlich hinter `step.startMs`.

Ursache:

`buildNarrationGroups` setzt `narration.atMs = finalOutputStartMs`. Dieser Wert ist:

```
finalOutputStartMs = source_step_start_ms + kumulative_narrations_overflows
```

Das ist annotierte-Video-Zeit (Quellvideo-Zeit mit eingefuegten Pausen). Im Remotion-Runtime wird `narration.atMs` aber als Remotion-Kompositions-Zeit interpretiert, d. h. als absolute Position in der summierten Stepfolge (ab 0).

Diese beiden Zeitbasen sind verschieden, weil Remotion die Luecken zwischen den Interaktionsschritten im Rohvideo ueberspringt. Jeder Step spielt nur sein kleines Clip-Fenster (typisch 1-3 s), waehrend die Quellvideo-Zeit des Steps viel groesser ist (kumulierte Rohvideoposition).

Konkretes Beispiel (Video 4, Step R0016):

- Remotion `step.startMs` = 17210 ms → dort beginnt der Freeze
- `narration.atMs` = 24996 ms → Narration startet 7786 ms zu spaet
- Die Narration (10800 ms lang) beginnt mitten im Freeze und laeuft weit in die naechsten Clips

Betroffene Anker:

- `info-before` (sicher betroffen)
- `before` (selbe Logik, betroffen)
- `info-presentation` (aktuell zufaellig korrekt, weil der erste Step bei Remotion-Zeit 0 liegt)

Loesung (implementiert):

In `buildNarrationGroups` (`semantic-remotion.mjs`) wird nach dem Sammeln aller Narrations pro Schritt eine Nachbearbeitung durchgefuehrt: `stepBaseAtMs = min(group.atMs)` wird von jedem `atMs` und `endMs` der Gruppe subtrahiert. Damit ist `atMs` schritt-relativ (0 = Beginn des Freeze-Bilds).

In `semantic-runtime.tsx` wird die absolute Kompositions-Position berechnet als:

```tsx
const absoluteAtMs = Math.max(0, Number(narration.stepStartMs || 0) + Number(narration.atMs || 0))
```

`stepStartMs` wird bereits in `globalNarrations` auf jede Narration gesetzt (via `flatMap`). Damit spielen `info-before`-Narrations genau beim Einfrieren des ersten Frames.

## Aktuelle Architekturentscheidung

Die aktuelle, gewollte Datenrichtung lautet:

1. Trace lesen
2. unterschiedliche Trace-Uhren normalisieren
3. Step- und Click-Zeiten extrahieren
4. in Clip-Zeit umrechnen
5. fuer semantische Planung wieder in Quellvideo-Zeit abbilden
6. Holds/Pausen/Freeze darauf anwenden
7. daraus finale Plan-Zeit berechnen
8. erst ganz am Ende in Frames uebersetzen

Das ist bewusst mehrstufig. Die Stufen existieren, weil:

- XML-/Praesentations-Logik clip-relativ denkt
- Remotion-/Freeze-Logik quellvideo-relativ denkt
- Rendering frame-relativ denkt

## Praktische Debug-Regeln

Wenn Marker oder Narrationen falsch sitzen, zuerst pruefen:

1. Kommt die Zeit aus `test.trace` oder `0-trace.trace`?
2. Ist die Zeit noch absolut im Rohvideo oder schon clip-relativ?
3. Wurde `presentationRange.startMs` bereits abgezogen oder wieder addiert?
4. Wurde vor dem Ereignis ein Hold eingefuegt?
5. Wird das Element in Quellvideo-Zeit oder schon in Plan-Zeit interpretiert?
6. Ist der Marker vielleicht doppelt einem Schritt zugeordnet?

## Offene technische Schulden

- Die Zeitbasis wird an mehreren Stellen implizit statt als eigener Typ modelliert.
- Eine explizite Datenstruktur fuer `traceTimeMs`, `sourceVideoMs`, `clipMs` und `planMs` waere robuster als freie Zahlenwerte.
- `info-before`-Narrations sitzen zeitlich falsch (siehe Fehlerquelle #5). Behoben: `narration.atMs` ist jetzt schritt-relativ, `semantic-runtime.tsx` addiert `step.startMs`.

Bis dahin gilt:

- Bei jeder neuen Zeitrechnung immer zuerst die Zeitbasis benennen.
