# Semantic Remotion Architecture

## Ziel
Die generierte Remotion-Datei soll ein lesbares semantisches Videoskript bleiben und nicht primar eine global aufgeloeste Timeline darstellen.

## Komponentenmodell
Die semantische Ebene besteht aus folgenden Bausteinen:

- VideoScript
- Chapter
- Section
- Step
- Clip
- Freeze
- Pause
- Narration
- Callout
- ClickMarker

Regeln:

- Step ist die zentrale fachliche Einheit.
- Clip referenziert nur Source-Time im Originalvideo.
- Freeze und Pause vergroessern lokal die Plan-Time des Steps.
- Narration, Callout und ClickMarker werden relativ im Step platziert.
- Die Gesamttimeline entsteht aus der Reihenfolge der Steps.

## Datenmodell
Das JSON-Schema liegt in [schemas/lumiere-semantic-video-plan.schema.json](../../schemas/lumiere-semantic-video-plan.schema.json).

Kernidee:

- Source-Time: sourceStartMs/sourceEndMs in Step.clip.
- Plan-Time: wird erst in den Runtime-Komponenten berechnet.

## Generatorarchitektur
Zielpipeline:

1. YAML -> normalized scenario model
2. normalized scenario -> SemanticVideoPlan
3. SemanticVideoPlan -> semantische TSX-Datei
4. semantische TSX -> lokale Zeitberechnung in Runtime-Komponenten
5. Renderer

Vergleich zur bisherigen Pipeline:

- bisher: globale Timeline als primaeres Modell
- neu: Semantik als primaeres Modell, Timeline nur internes Laufzeitdetail

## Uebergangspfad
1. SemanticVideoPlan parallel zum bestehenden muxPlan schreiben.
2. Semantische TSX-Datei zusaetzlich zur architecture.tsx erzeugen.
3. Feature-Flag fuers Rendering einfuehren:
   - legacy: architecture.tsx
   - semantic: semantic-script.tsx
4. Vergleichs-Checks fuer Dauer, Audio-Anker und Marker etablieren.
5. Nach Stabilisierung standardmaessig semantic aktivieren.

## Beispiel YAML
```yaml
interaction:
  id: sus-dublette-zusammenfuehren
  version: 1.1
  title: Schueler*innen-Datensaetze zusammenfuehren
  flow:
    - chapter:
        text: Schueler*innen-Datensaetze zusammenfuehren
    - id: datensatz-oeffnen
      presentation:
        didactics:
          purpose:
            text: Fuehrenden Datensatz oeffnen.
      source:
        from: timeline.step("datensatz oeffnen")
      render:
        click_marker: true
    - id: dublette-auswaehlen
      presentation:
        didactics:
          explanation:
            text: Nachrangigen Datensatz markieren.
      source:
        from: timeline.step("verschmelzen-sus-auswaehlen")
      render:
        freeze:
          at: source+520ms
          duration_ms: 3000
        pause_ms: 800
        callout:
          text: Nachrangigen Datensatz markieren
          at_ms: 400
```

## Beispiel generierte Remotion-Datei
```tsx
import React from 'react'
import { VideoScript, Chapter, Step, Clip, Freeze, Pause, Narration, Callout, ClickMarker } from '../scripts/generator/runtime/semantic-runtime'

export default function GeneratedSemanticScript() {
  return (
    <VideoScript id="sus-dublette-zusammenfuehren" sourceVideo="output/sus-dublette-zusammenfuehren_v1_0/artifacts/video.webm" debug>
      <Chapter id="kapitel-1" title="Schueler*innen-Datensaetze zusammenfuehren">
        <Step id="datensatz-oeffnen" title="Datensatz oeffnen">
          <Clip sourceStartMs={26249} sourceEndMs={26382} />
          <Narration id="datensatz-oeffnen-purpose" file="output/_tts-cache/example-purpose.mp3" atMs={0} />
          <ClickMarker atSourceMs={26260} x={640} y={340} durationMs={900} />
        </Step>

        <Step id="dublette-auswaehlen" title="Dublette auswaehlen">
          <Clip sourceStartMs={29697} sourceEndMs={30888} />
          <Freeze atSourceMs={30220} durationMs={3000} />
          <Pause atSourceMs={30400} durationMs={800} />
          <Narration id="dublette-auswaehlen-explanation" file="output/_tts-cache/example-explanation.mp3" atMs={250} />
          <Callout text="Nachrangigen Datensatz markieren" atMs={400} durationMs={1800} />
        </Step>
      </Chapter>
    </VideoScript>
  )
}
```

## Bewertung gegen globale Timeline
Vorteile:

- deutlich hoehere Lesbarkeit in generierter TSX
- bessere Debugbarkeit je Step
- geringere Seiteneffekte bei lokalen Aenderungen
- fachliche Struktur bleibt sichtbar

Nachteile:

- mehr Laufzeitlogik in Komponenten
- Validierung von Step-Daten wird wichtiger
- fuer globale Optimierungen ist ein optionaler zweiter Pass hilfreich
