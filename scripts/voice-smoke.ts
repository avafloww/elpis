import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfigFile } from '../src/config.js';
import { RealtimeVoiceTransport } from '../src/voice/realtime.js';

// Synthetic stock speech only. No microphone, resident history, or private files
// are sent by this provider smoke check, and no audio is retained on disk.
class SmokeFailure extends Error {}

const utterance = 'Aster checked the weather, paused, and said: again.';
const reply = 'I heard you. Aster is ready for a voice conversation.';

async function main(): Promise<void> {
  const config = loadConfigFile();
  const voice = config.discord.voice;
  if (!voice?.enabled || !voice.apiKey) {
    throw new SmokeFailure(
      'Voice smoke check requires enabled discord.voice and its dedicated api_key.',
    );
  }
  const synthesis = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `flite=text='${utterance}':voice=slt`,
      '-ar',
      '24000',
      '-ac',
      '1',
      '-f',
      's16le',
      'pipe:1',
    ],
    { maxBuffer: 2 * 1024 * 1024, timeout: 15_000 },
  );
  if (synthesis.status !== 0 || !synthesis.stdout.length)
    throw new SmokeFailure(
      'Synthetic speech requires ffmpeg with its flite filter.',
    );
  let transcript = '';
  let outputTranscript = '';
  let audioBytes = 0;
  let responseStatus = '';
  let failure = false;
  const requestToken = randomUUID();
  let requested = false;
  let responseId = '';
  const transport = new RealtimeVoiceTransport({
    apiKey: voice.apiKey,
    model: voice.model,
    voice: voice.voice,
    transcriptionModel: voice.transcriptionModel,
    instructions:
      'Transcribe incoming audio. Speak only explicitly requested text.',
    onEvent(event) {
      if (event.type === 'inputTranscript') transcript = event.transcript;
      if (event.type === 'responseCreated') {
        if (!requested || event.requestToken !== requestToken) failure = true;
        else responseId = event.responseId;
      }
      if (event.type === 'audio') {
        if (!responseId || event.responseId !== responseId) failure = true;
        else audioBytes += event.pcm.length;
      }
      if (
        event.type === 'outputTranscript' &&
        event.responseId === responseId &&
        event.final
      )
        outputTranscript = event.transcript;
      if (event.type === 'responseDone' && event.responseId === responseId)
        responseStatus = event.status;
      if (event.type === 'error' || event.type === 'inputTranscriptFailed')
        failure = true;
    },
  });
  const deadline = Date.now() + 60_000;
  const waitFor = async (done: () => boolean) => {
    while (!done()) {
      if (failure)
        throw new SmokeFailure(
          'Voice provider reported an error; check model access and dedicated credentials.',
        );
      if (Date.now() >= deadline)
        throw new SmokeFailure('Voice provider smoke check timed out.');
      await delay(20);
    }
  };
  try {
    await transport.connect();
    for (let offset = 0; offset < synthesis.stdout.length; offset += 960) {
      transport.appendAudio(synthesis.stdout.subarray(offset, offset + 960));
      await delay(20);
    }
    for (let i = 0; i < 150 && !transcript && !failure; i++) {
      transport.appendAudio(Buffer.alloc(960));
      await delay(20);
    }
    await waitFor(() => Boolean(transcript));
    if (!/weather/i.test(transcript) || !/again/i.test(transcript))
      throw new SmokeFailure(
        'Voice transcription did not recognize the synthetic test utterance.',
      );
    if (audioBytes > 0)
      throw new SmokeFailure(
        'Voice provider emitted unsolicited audio before an explicit send.',
      );
    requested = true;
    transport.speakText(reply, requestToken);
    await waitFor(() => Boolean(responseStatus));
    if (
      responseStatus !== 'completed' ||
      audioBytes < 4_800 ||
      !/ready/i.test(outputTranscript)
    )
      throw new SmokeFailure(
        'Voice provider did not complete the requested speech.',
      );
    console.log(
      JSON.stringify({
        ok: true,
        inputRecognized: true,
        outputRecognized: true,
        audioBytes,
        model: voice.model,
      }),
    );
  } finally {
    transport.close();
  }
}

main().catch((error: unknown) => {
  // Config/provider exceptions can contain sensitive values. The diagnostic is
  // intentionally static; this script never echoes config or server payloads.
  console.error(
    error instanceof SmokeFailure
      ? error.message
      : 'Voice smoke check failed during configuration or connection setup; verify model access and dedicated credentials.',
  );
  process.exitCode = 1;
});
