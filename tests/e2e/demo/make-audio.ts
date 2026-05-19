import fs from 'node:fs/promises';
import path from 'node:path';
import textToSpeech from '@google-cloud/text-to-speech';

type NarrationResolved = {
  id: string;
  startMs: number;
  endMs: number;
  text?: string;
  ssml?: string;
  voice?: string;
};

const client = new textToSpeech.TextToSpeechClient();

async function main() {
  const narrations: NarrationResolved[] = JSON.parse(
    await fs.readFile('artifacts/demo/timeline.resolved.json', 'utf8')
  );

  await fs.mkdir('artifacts/demo/audio', { recursive: true });

  for (const n of narrations) {
    const [response] = await client.synthesizeSpeech({
      input: n.ssml ? { ssml: n.ssml } : { text: n.text! },
      voice: {
        languageCode: 'de-DE',
        name: n.voice ?? 'de-DE-Neural2-B'
      },
      audioConfig: {
        audioEncoding: 'MP3'
      }
    });

    await fs.writeFile(
      path.join('artifacts/demo/audio', `${n.id}.mp3`),
      response.audioContent as Uint8Array
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});