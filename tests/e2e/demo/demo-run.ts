import fs from 'node:fs/promises'
import path from 'node:path'

type TimelineEvent = {
  id: string
  tMs: number
}

type NarrationDefinition = {
  id: string
  startAfterEvent: string
  endBeforeEvent: string
  text: string | null
  ssml: string | null
  voice: string | null
}

type StepTitleDefinition = {
  id: string
  atEvent: string
  title: string
  durationMs: number
}

type VideoRangeDefinition = {
  startAfter?: string | null
  endBefore?: string | null
}

export class DemoRun {
  page: any
  testInfo: any
  startedAt: number
  clicks: TimelineEvent[]
  marks: TimelineEvent[]
  narrations: NarrationDefinition[]
  stepTitles: StepTitleDefinition[]
  events: Map<string, number>
  lastMarkId: string | null
  pendingAutoNarrationIndices: number[]
  outputDir: string
  videoRange: VideoRangeDefinition
  videoTitle: string | null

  constructor(page: any, testInfo: any, options: { outputDir?: string } = {}) {
    this.page = page
    this.testInfo = testInfo
    this.startedAt = Date.now()
    this.clicks = []
    this.marks = []
    this.narrations = []
    this.stepTitles = []
    this.events = new Map()
    this.lastMarkId = null
    this.pendingAutoNarrationIndices = []
    this.outputDir = options.outputDir || path.join(testInfo.outputDir, 'demo')
    this.videoRange = {}
    this.videoTitle = null
  }

  nowMs() {
    return Date.now() - this.startedAt
  }

  async click(id: string, locator: any, options = {}) {
    await locator.click(options)
    this._registerEvent(id)
    this.clicks.push({
      id,
      tMs: this.nowMs()
    })
  }

  mark(id: string) {
    this._registerEvent(id)

    // Auto narration blocks end when the next mark is reached.
    for (const narrationIndex of this.pendingAutoNarrationIndices) {
      const narration = this.narrations[narrationIndex]
      if (narration && !narration.endBeforeEvent) {
        narration.endBeforeEvent = id
      }
    }
    this.pendingAutoNarrationIndices = []

    this.lastMarkId = id
    this.marks.push({
      id,
      tMs: this.nowMs()
    })
  }

  _registerEvent(id: string) {
    if (!id) {
      throw new Error('Event-ID darf nicht leer sein.')
    }
    if (this.events.has(id)) {
      throw new Error(`Doppelte Event-ID: ${id}`)
    }
    this.events.set(id, this.nowMs())
  }

  narrateBetween({
    id,
    startAfterEvent,
    endBeforeEvent,
    startAfterClick,
    endBeforeClick,
    text = null,
    ssml = null,
    voice = null
  }: {
    id: string
    startAfterEvent?: string
    endBeforeEvent?: string
    startAfterClick?: string
    endBeforeClick?: string
    text?: string | null
    ssml?: string | null
    voice?: string | null
  }) {
    const resolvedStartAfterEvent = startAfterEvent || startAfterClick || ''
    const resolvedEndBeforeEvent = endBeforeEvent || endBeforeClick || ''

    if (!id) {
      throw new Error('narrateBetween benötigt eine id.')
    }

    if (!resolvedStartAfterEvent || !resolvedEndBeforeEvent) {
      throw new Error(
        `Narration "${id}" benötigt startAfterEvent und endBeforeEvent.`
      )
    }

    if ((!text && !ssml) || (text && ssml)) {
      throw new Error(
        `Narration "${id}" muss genau text oder ssml enthalten.`
      )
    }

    this.narrations.push({
      id,
      startAfterEvent: resolvedStartAfterEvent,
      endBeforeEvent: resolvedEndBeforeEvent,
      text,
      ssml,
      voice
    })
  }

  narrate(textOrOptions: string | {
    id?: string | null,
    text?: string | null,
    ssml?: string | null,
    voice?: string | null,
    useLastMark?: boolean
  }) {
    const opts = typeof textOrOptions === 'string' ? { text: textOrOptions } : (textOrOptions ?? {})
    let { id = null, text = null, ssml = null, voice = null, useLastMark = false } = opts

    if(!voice){
      voice = 'de-DE-Chirp3-HD-Laomedeia'
    }

    if (!id) {
      id = `narration-${this.narrations.length + 1}`
    }

    if ((!text && !ssml) || (text && ssml)) {
      throw new Error(
        `Narration "${id}" muss genau text oder ssml enthalten.`
      )
    }

    let markToUse = null;
    if (!useLastMark) {
      markToUse = `narration-start-${id}`;
      this.mark(markToUse);

    } else {
      markToUse = this.lastMarkId;
    }

    if (!markToUse) {
      throw new Error(
        `Narration "${id}" benötigt einen vorherigen mark(...)-Aufruf.`
      )
    }

    this.narrations.push({
      id,
      startAfterEvent: markToUse,
      endBeforeEvent: '',
      text,
      ssml,
      voice
    })
    this.pendingAutoNarrationIndices.push(this.narrations.length - 1)
  }

  setVideoRange({
    startAfter = null,
    endBefore = null
  }: {
    startAfter?: string | null
    endBefore?: string | null
  }) {
    if (startAfter !== null && !startAfter) {
      throw new Error('setVideoRange: startAfter darf nicht leer sein.')
    }
    if (endBefore !== null && !endBefore) {
      throw new Error('setVideoRange: endBefore darf nicht leer sein.')
    }
    this.videoRange = {
      startAfter,
      endBefore
    }
  }

  startVideoAfter(eventId: string) {
    this.setVideoRange({
      ...this.videoRange,
      startAfter: eventId
    })
  }

  endVideoBefore(eventId: string) {
    this.setVideoRange({
      ...this.videoRange,
      endBefore: eventId
    })
  }

  setVideoTitle(title: string | null) {
    if (title === null) {
      this.videoTitle = null
      return
    }
    const normalizedTitle = String(title).trim()
    if (!normalizedTitle) {
      throw new Error('setVideoTitle: title darf nicht leer sein.')
    }
    this.videoTitle = normalizedTitle
  }

  stepTitle(title: string, { durationMs = 4000 }: { durationMs?: number } = {}) {
    const normalizedTitle = String(title).trim()
    if (!normalizedTitle) {
      throw new Error('stepTitle: title darf nicht leer sein.')
    }

    const stepTitleId = `step-title-${this.stepTitles.length + 1}`

    // Close any pending auto-narrations – they end before the title card
    for (const narrationIndex of this.pendingAutoNarrationIndices) {
      const narration = this.narrations[narrationIndex]
      if (narration && !narration.endBeforeEvent) {
        narration.endBeforeEvent = stepTitleId
      }
    }
    this.pendingAutoNarrationIndices = []

    this._registerEvent(stepTitleId)
    this.lastMarkId = stepTitleId
    this.marks.push({ id: stepTitleId, tMs: this.nowMs() })

    this.stepTitles.push({
      id: stepTitleId,
      atEvent: stepTitleId,
      title: normalizedTitle,
      durationMs,
    })
  }

  async finish(extra = {}) {
    

    if (this.pendingAutoNarrationIndices.length > 0) {
      this.mark('lastMarker')
    }

    await fs.mkdir(this.outputDir, { recursive: true })

    const video = this.page.video()
    let videoPath = null

    if (video) {
      try {
        videoPath = await video.path()
      } catch {
        videoPath = null
      }
    }

    await fs.writeFile(
      path.join(this.outputDir, 'timeline.clicks.json'),
      JSON.stringify(this.clicks, null, 2),
      'utf8'
    )

    await fs.writeFile(
      path.join(this.outputDir, 'timeline.marks.json'),
      JSON.stringify(this.marks, null, 2),
      'utf8'
    )

    const timelineEvents = Array.from(this.events.entries()).map(([id, tMs]: [string, number]) => ({
      id,
      tMs
    }))
    await fs.writeFile(
      path.join(this.outputDir, 'timeline.events.json'),
      JSON.stringify(timelineEvents, null, 2),
      'utf8'
    )

    await fs.writeFile(
      path.join(this.outputDir, 'timeline.narrations.json'),
      JSON.stringify(this.narrations, null, 2),
      'utf8'
    )

    await fs.writeFile(
      path.join(this.outputDir, 'timeline.step-titles.json'),
      JSON.stringify(this.stepTitles, null, 2),
      'utf8'
    )

    await fs.writeFile(
      path.join(this.outputDir, 'timeline.video.json'),
      JSON.stringify(this.videoRange, null, 2),
      'utf8'
    )

    await fs.writeFile(
      path.join(this.outputDir, 'timeline.title.json'),
      JSON.stringify({ title: this.videoTitle }, null, 2),
      'utf8'
    )

    await fs.writeFile(
      path.join(this.outputDir, 'timeline.meta.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          videoPath,
          ...extra
        },
        null,
        2
      ),
      'utf8'
    )
  }
}
