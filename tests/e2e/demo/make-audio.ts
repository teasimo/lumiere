import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildAzureSpeechAuthContext,
  buildAzureSpeechSsml,
  DEFAULT_AZURE_TTS_OUTPUT_FORMAT,
  normalizeAzureTtsVoiceName,
  resolveAzureSpeechEndpoint,
} from '../../../scripts/shared/azure-speech.mjs';

type NarrationResolved = {
  id: string;
  startMs: number;
  endMs: number;
  text?: string;
  ssml?: string;
  voice?: string;
};

function normalizeVoice(voice?: string) {
  return normalizeAzureTtsVoiceName(voice);
}

async function main() {
  const narrations: NarrationResolved[] = JSON.parse(
    await fs.readFile('artifacts/demo/timeline.resolved.json', 'utf8')
  );
  const authContext = buildAzureSpeechAuthContext();
  if (!authContext) {
    throw new Error('AZURE_SPEECHSERVICES_KEY oder AZURE_SPEECHSERVICES_TOKEN fehlt.');
  }
  const endpoint = resolveAzureSpeechEndpoint();

  await fs.mkdir('artifacts/demo/audio', { recursive: true });

  for (const n of narrations) {
    const voice = normalizeVoice(n.voice);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...authContext.headers,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': DEFAULT_AZURE_TTS_OUTPUT_FORMAT,
        'User-Agent': 'lumiere-scenario-test-generator'
      },
      body: buildAzureSpeechSsml({
        text: n.text ?? '',
        ssml: n.ssml ?? '',
        voice
      })
    });

    if (!response.ok) {
      throw new Error(`Azure Speech Services TTS fehlgeschlagen (${response.status} ${response.statusText}): ${await response.text()}`);
    }

    await fs.writeFile(
      path.join('artifacts/demo/audio', `${n.id}.mp3`),
      new Uint8Array(await response.arrayBuffer())
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
