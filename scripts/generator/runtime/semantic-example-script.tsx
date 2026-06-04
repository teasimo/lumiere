import React from 'react'
import {
  Callout,
  Chapter,
  ClickMarker,
  Clip,
  Freeze,
  Narration,
  Pause,
  Step,
  VideoScript,
} from './semantic-runtime'

export default function SemanticExampleScript() {
  return (
    <VideoScript
      id="sus-dublette-zusammenfuehren"
      sourceVideo="output/sus-dublette-zusammenfuehren_v1_0/artifacts/video.webm"
      debug
    >
      <Chapter id="kapitel-zusammenfuehren" title="Schueler*innen-Datensaetze zusammenfuehren">
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
