import fs from 'node:fs/promises';

type ClickMark = { id: string; tMs: number };
type NarrationDef = {
  id: string;
  startAfterEvent?: string;
  endBeforeEvent?: string;
  startAfterClick?: string;
  endBeforeClick?: string;
  after?: string;
  before?: string;
  text?: string;
  ssml?: string;
  voice?: string;
};

type NarrationResolved = {
  id: string;
  startMs: number;
  endMs: number;
  text?: string;
  ssml?: string;
  voice?: string;
};

type VideoRangeDef = {
  startAfter?: string;
  endBefore?: string;
};

function indexClicks(clicks: ClickMark[]): Map<string, ClickMark> {
  const map = new Map<string, ClickMark>();
  for (const click of clicks) {
    if (map.has(click.id)) {
      throw new Error(`Doppelte Click-ID: ${click.id}`);
    }
    map.set(click.id, click);
  }
  return map;
}

async function main() {
  const clicks: ClickMark[] = JSON.parse(
    await fs.readFile('artifacts/demo/timeline.clicks.json', 'utf8')
  );

  const narrations: NarrationDef[] = JSON.parse(
    await fs.readFile('artifacts/demo/timeline.narrations.json', 'utf8')
  );

  let videoRange: VideoRangeDef = {};
  try {
    videoRange = JSON.parse(
      await fs.readFile('artifacts/demo/timeline.video.json', 'utf8')
    );
  } catch {
    videoRange = {};
  }

  const clickMap = indexClicks(clicks);
  const clipStartMs = videoRange.startAfter
    ? clickMap.get(videoRange.startAfter)?.tMs ?? null
    : 0;
  const clipEndMs = videoRange.endBefore
    ? clickMap.get(videoRange.endBefore)?.tMs ?? null
    : null;

  if (clipStartMs === null) {
    throw new Error(`Video-Start nicht gefunden: ${videoRange.startAfter}`);
  }
  if (clipEndMs !== null && clipEndMs <= clipStartMs) {
    throw new Error(`Ungültiger Video-Bereich: ${clipStartMs}..${clipEndMs}`);
  }

  const resolved: NarrationResolved[] = narrations.flatMap((n) => {
    const startId = n.startAfterEvent || n.startAfterClick || n.after;
    const endId = n.endBeforeEvent || n.endBeforeClick || n.before;
    const after = clickMap.get(startId);
    const before = clickMap.get(endId);

    if (!after) throw new Error(`start nicht gefunden: ${startId}`);
    if (!before) throw new Error(`end nicht gefunden: ${endId}`);
    if (after.tMs >= before.tMs) {
      throw new Error(`Ungültiger Bereich in ${n.id}: after >= before`);
    }

    const startMs = Math.max(after.tMs, clipStartMs);
    const endMs = clipEndMs === null
      ? before.tMs
      : Math.min(before.tMs, clipEndMs);
    if (startMs >= endMs) {
      return [];
    }

    return [{
      id: n.id,
      startMs: startMs - clipStartMs,
      endMs: endMs - clipStartMs,
      text: n.text,
      ssml: n.ssml,
      voice: n.voice
    }];
  });

  await fs.writeFile(
    'artifacts/demo/timeline.resolved.json',
    JSON.stringify(resolved, null, 2),
    'utf8'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
