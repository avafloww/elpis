import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceSession } from '../src/voice/session.js';
import { MAX_VOICE_TRANSCRIPT_BYTES } from '../src/voice/receipt.js';

function setup() {
  const received: string[] = [];
  const removed: string[] = [];
  const spoken: string[] = [];
  const requestTokens: string[] = [];
  const cancelled: string[] = [];
  const played: Buffer[] = [];
  let allowed = true;
  const session = new VoiceSession({
    transport: {
      speakText: (text: string, requestToken: string) => {
        spoken.push(text);
        requestTokens.push(requestToken);
      },
      cancelResponse: (responseId) => cancelled.push(responseId),
      deleteInput: (id: string) => {
        removed.push(id);
      },
      close: () => {},
    },
    playback: {
      write: (pcm) => played.push(Buffer.from(pcm)),
      finish: async () => 120,
      interrupt: () => 40,
      close: () => {},
    },
    canReceive: () => allowed,
    canSend: () => allowed,
    onUtterance: (_id, text) => received.push(text),
    onNotice: () => {},
  });
  return {
    session,
    received,
    removed,
    spoken,
    requestTokens,
    cancelled,
    played,
    deny: () => {
      allowed = false;
    },
  };
}

test('voice ingests only finalized utterances in audio commit order', () => {
  const { session, received, removed } = setup();
  session.handle({ type: 'inputCommitted', itemId: 'first' });
  session.handle({ type: 'inputCommitted', itemId: 'second' });
  session.handle({
    type: 'inputTranscript',
    itemId: 'second',
    transcript: 'second words',
  });
  assert.deepEqual(received, []);
  session.handle({
    type: 'inputTranscript',
    itemId: 'first',
    transcript: 'first words',
  });
  assert.deepEqual(received, ['first words', 'second words']);
  assert.deepEqual(removed, ['first', 'second']);
  session.handle({
    type: 'inputTranscript',
    itemId: 'first',
    transcript: 'duplicate',
  });
  assert.equal(received.length, 2);
  session.close();
});

test('voice plays only explicit sends and rejects overlapping sends', async () => {
  const { session, spoken, requestTokens, cancelled } = setup();
  session.handle({
    type: 'audio',
    responseId: 'unsolicited',
    itemId: 'x',
    pcm: Buffer.alloc(48),
  });
  assert.deepEqual(spoken, []);
  const result = session.speak('Hello.');
  await assert.rejects(session.speak('racing'), /already/);
  session.handle({
    type: 'responseCreated',
    responseId: 'unsolicited-created',
    requestToken: 'foreign-token',
  });
  session.handle({
    type: 'responseCreated',
    responseId: 'r1',
    requestToken: requestTokens[0],
  });
  session.handle({
    type: 'audio',
    responseId: 'r1',
    itemId: 'a1',
    pcm: Buffer.alloc(480),
  });
  session.handle({
    type: 'outputTranscript',
    responseId: 'r1',
    itemId: 'a1',
    transcript: 'Hello.',
    final: true,
  });
  session.handle({
    type: 'responseDone',
    responseId: 'r1',
    status: 'completed',
  });
  assert.deepEqual(await result, {
    status: 'played',
    transcript: 'Hello.',
    playedMs: 120,
  });
  assert.deepEqual(cancelled, ['unsolicited-created']);
  session.close();
});

test('a synchronous speech dispatch failure cannot poison the next response', async () => {
  const cancelled: string[] = [];
  const requestTokens: string[] = [];
  let attempts = 0;
  const session = new VoiceSession({
    transport: {
      speakText: (_text, requestToken) => {
        attempts++;
        if (attempts === 1) throw new Error('socket rejected send');
        requestTokens.push(requestToken);
      },
      cancelResponse: (id) => cancelled.push(id),
      deleteInput: () => {},
      close: () => {},
    },
    playback: {
      write: () => {},
      finish: async () => 100,
      interrupt: () => 0,
      close: () => {},
    },
    canReceive: () => true,
    canSend: () => true,
    onUtterance: () => {},
    onNotice: () => {},
  });

  assert.deepEqual(await session.speak('First.'), {
    status: 'failed',
    transcript: '',
    playedMs: 0,
  });
  assert.deepEqual(cancelled, []);

  const next = session.speak('Second.');
  session.handle({
    type: 'responseCreated',
    responseId: 'next',
    requestToken: requestTokens[0],
  });
  session.handle({
    type: 'audio',
    responseId: 'next',
    itemId: 'assistant-next',
    pcm: Buffer.alloc(480),
  });
  session.handle({
    type: 'responseDone',
    responseId: 'next',
    status: 'completed',
  });
  assert.equal((await next).status, 'played');
  assert.deepEqual(cancelled, []);
  session.close();
});

test('a completed response without audio fails without cancelling a terminal generation', async () => {
  const cancelled: string[] = [];
  const requestTokens: string[] = [];
  let finishes = 0;
  const session = new VoiceSession({
    transport: {
      speakText: (_text, requestToken) => requestTokens.push(requestToken),
      cancelResponse: (id) => cancelled.push(id),
      deleteInput: () => {},
      close: () => {},
    },
    playback: {
      write: () => {},
      finish: async () => {
        finishes++;
        return 0;
      },
      interrupt: () => 0,
      close: () => {},
    },
    canReceive: () => true,
    canSend: () => true,
    onUtterance: () => {},
    onNotice: () => {},
  });

  const result = session.speak('No generated audio.');
  session.handle({
    type: 'responseCreated',
    responseId: 'silent',
    requestToken: requestTokens[0],
  });
  session.handle({
    type: 'outputTranscript',
    responseId: 'silent',
    itemId: 'assistant-silent',
    transcript: 'No generated audio.',
    final: true,
  });
  session.handle({
    type: 'responseDone',
    responseId: 'silent',
    status: 'completed',
  });

  assert.deepEqual(await result, {
    status: 'failed',
    transcript: 'No generated audio.',
    playedMs: 0,
  });
  assert.equal(finishes, 0);
  assert.deepEqual(cancelled, []);
  session.close();
});

test('a provider-terminal failure is not cancelled and does not poison a later send', async () => {
  const cancelled: string[] = [];
  const requestTokens: string[] = [];
  const session = new VoiceSession({
    transport: {
      speakText: (_text, requestToken) => requestTokens.push(requestToken),
      cancelResponse: (id) => cancelled.push(id),
      deleteInput: () => {},
      close: () => {},
    },
    playback: {
      write: () => {},
      finish: async () => 75,
      interrupt: () => 0,
      close: () => {},
    },
    canReceive: () => true,
    canSend: () => true,
    onUtterance: () => {},
    onNotice: () => {},
  });

  const failed = session.speak('Provider failure.');
  session.handle({
    type: 'responseCreated',
    responseId: 'failed',
    requestToken: requestTokens[0],
  });
  session.handle({
    type: 'responseDone',
    responseId: 'failed',
    status: 'failed',
  });
  assert.equal((await failed).status, 'failed');
  assert.deepEqual(cancelled, []);

  const next = session.speak('Recovery.');
  session.handle({
    type: 'responseCreated',
    responseId: 'recovery',
    requestToken: requestTokens[1],
  });
  session.handle({
    type: 'audio',
    responseId: 'recovery',
    itemId: 'assistant-recovery',
    pcm: Buffer.alloc(480),
  });
  session.handle({
    type: 'responseDone',
    responseId: 'recovery',
    status: 'completed',
  });
  assert.equal((await next).status, 'played');
  assert.deepEqual(cancelled, []);
  session.close();
});

test('multi-byte output exceeding the durable receipt bound fails the active response', async () => {
  const cancelled: string[] = [];
  const requestTokens: string[] = [];
  const session = new VoiceSession({
    transport: {
      speakText: (_text, requestToken) => requestTokens.push(requestToken),
      cancelResponse: (responseId) => cancelled.push(responseId),
      deleteInput: () => {},
      close: () => {},
    },
    playback: {
      write: () => {},
      finish: async () => 0,
      interrupt: () => 0,
      close: () => {},
    },
    canReceive: () => true,
    canSend: () => true,
    onUtterance: () => {},
    onNotice: () => {},
  });

  const result = session.speak('Bounded transcript.');
  session.handle({
    type: 'responseCreated',
    responseId: 'oversized',
    requestToken: requestTokens[0],
  });
  session.handle({
    type: 'outputTranscript',
    responseId: 'oversized',
    itemId: 'assistant-oversized',
    transcript: '🙂'.repeat(Math.floor(MAX_VOICE_TRANSCRIPT_BYTES / 4) + 1),
    final: true,
  });

  assert.deepEqual(await result, {
    status: 'failed',
    transcript: '',
    playedMs: 0,
  });
  assert.deepEqual(cancelled, ['oversized']);
  session.close();
});

test('barge-in stops playback without replaying or retracting committed speech', async () => {
  const { session, requestTokens } = setup();
  const result = session.speak('A long reply.');
  session.handle({
    type: 'responseCreated',
    responseId: 'r1',
    requestToken: requestTokens[0],
  });
  session.handle({ type: 'speechStarted', itemId: 'u1' });
  assert.deepEqual(await result, {
    status: 'interrupted',
    transcript: '',
    playedMs: 40,
  });
  // Late packets from the interrupted response cannot become the next reply.
  const next = session.speak('Next.');
  session.handle({
    type: 'responseDone',
    responseId: 'r1',
    status: 'cancelled',
  });
  session.handle({
    type: 'responseCreated',
    responseId: 'r2',
    requestToken: requestTokens[1],
  });
  session.handle({
    type: 'audio',
    responseId: 'r2',
    itemId: 'new',
    pcm: Buffer.alloc(480),
  });
  session.handle({
    type: 'responseDone',
    responseId: 'r2',
    status: 'completed',
  });
  assert.equal((await next).status, 'played');
  session.close();
});

test('reversed response creation cannot bind a retired request to the next send', async () => {
  const { session, requestTokens, cancelled, played } = setup();
  const first = session.speak('First.');
  session.interrupt();
  assert.equal((await first).status, 'interrupted');
  assert.deepEqual(cancelled, []);

  const next = session.speak('Next.');
  assert.notEqual(requestTokens[0], requestTokens[1]);
  // An unsolicited response arrives while the current request is still
  // unbound. It cannot claim the pending send or play audio.
  session.handle({
    type: 'responseCreated',
    responseId: 'unsolicited',
    requestToken: 'not-issued-by-session',
  });
  session.handle({
    type: 'audio',
    responseId: 'unsolicited',
    itemId: 'foreign',
    pcm: Buffer.alloc(240, 2),
  });
  // The current response is then created before the retired one. Exact request
  // tokens bind it correctly even when provider creation order is reversed.
  session.handle({
    type: 'responseCreated',
    responseId: 'current',
    requestToken: requestTokens[1],
  });
  session.handle({
    type: 'responseCreated',
    responseId: 'current',
    requestToken: requestTokens[1],
  });
  session.handle({
    type: 'responseCreated',
    responseId: 'stale',
    requestToken: requestTokens[0],
  });
  session.handle({
    type: 'audio',
    responseId: 'stale',
    itemId: 'old',
    pcm: Buffer.alloc(240, 1),
  });
  session.handle({
    type: 'outputTranscript',
    responseId: 'stale',
    itemId: 'old',
    transcript: 'old response',
    final: true,
  });
  session.handle({
    type: 'responseDone',
    responseId: 'stale',
    status: 'completed',
  });
  session.handle({
    type: 'audio',
    responseId: 'current',
    itemId: 'new',
    pcm: Buffer.alloc(480),
  });
  session.handle({
    type: 'outputTranscript',
    responseId: 'current',
    itemId: 'new',
    transcript: 'new response',
    final: true,
  });
  session.handle({
    type: 'responseDone',
    responseId: 'current',
    status: 'completed',
  });
  assert.deepEqual(await next, {
    status: 'played',
    transcript: 'new response',
    playedMs: 120,
  });
  assert.deepEqual(cancelled, ['unsolicited', 'stale']);
  assert.deepEqual(played, [Buffer.alloc(480)]);
  session.close();
});

test('barge-in during playback drain does not cancel a completed provider response', async () => {
  const cancelled: string[] = [];
  const requestTokens: string[] = [];
  let finishPlayback!: (playedMs: number) => void;
  const playbackFinished = new Promise<number>((resolve) => {
    finishPlayback = resolve;
  });
  const session = new VoiceSession({
    transport: {
      speakText: (_text, requestToken) => requestTokens.push(requestToken),
      cancelResponse: (id) => cancelled.push(id),
      deleteInput: () => {},
      close: () => {},
    },
    playback: {
      write: () => {},
      finish: () => playbackFinished,
      interrupt: () => 85,
      close: () => {},
    },
    canReceive: () => true,
    canSend: () => true,
    onUtterance: () => {},
    onNotice: () => {},
  });
  const result = session.speak('Still draining.');
  session.handle({
    type: 'responseCreated',
    responseId: 'complete',
    requestToken: requestTokens[0],
  });
  session.handle({
    type: 'audio',
    responseId: 'complete',
    itemId: 'assistant-complete',
    pcm: Buffer.alloc(480),
  });
  session.handle({
    type: 'responseDone',
    responseId: 'complete',
    status: 'completed',
  });
  session.handle({ type: 'speechStarted', itemId: 'person' });
  assert.deepEqual(await result, {
    status: 'interrupted',
    transcript: '',
    playedMs: 85,
  });
  assert.deepEqual(cancelled, []);
  finishPlayback(120);
  await playbackFinished;
  session.close();
});

test('ASR timeout preserves commit order and releases later transcripts', async () => {
  const received: string[] = [];
  const removed: string[] = [];
  const notices: string[] = [];
  const session = new VoiceSession({
    transport: {
      speakText: () => {},
      cancelResponse: () => {},
      deleteInput: (id) => removed.push(id),
      close: () => {},
    },
    playback: {
      write: () => {},
      finish: async () => 0,
      interrupt: () => 0,
      close: () => {},
    },
    canReceive: () => true,
    canSend: () => true,
    onUtterance: (_id, text) => received.push(text),
    onNotice: (notice) => notices.push(notice),
    transcriptionTimeoutMs: 10,
  });
  session.handle({ type: 'inputCommitted', itemId: 'first' });
  session.handle({ type: 'inputCommitted', itemId: 'second' });
  session.handle({
    type: 'inputTranscript',
    itemId: 'second',
    transcript: 'second words',
  });
  assert.deepEqual(received, []);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(received, ['second words']);
  assert.deepEqual(removed, ['first', 'second']);
  assert.equal(notices.length, 1);
  session.close();
});

test('ASR backlog overflow closes the whole session exactly once', () => {
  const notices: string[] = [];
  let transportCloses = 0;
  let playbackCloses = 0;
  let callbacks = 0;
  const session = new VoiceSession({
    transport: {
      speakText: () => {},
      cancelResponse: () => {},
      deleteInput: () => {},
      close: () => {
        transportCloses++;
      },
    },
    playback: {
      write: () => {},
      finish: async () => 0,
      interrupt: () => 0,
      close: () => {
        playbackCloses++;
      },
    },
    canReceive: () => true,
    canSend: () => true,
    onUtterance: () => {},
    onNotice: (notice) => notices.push(notice),
    onClose: () => {
      callbacks++;
    },
  });
  for (let index = 0; index < 33; index++) {
    session.handle({ type: 'inputCommitted', itemId: `item-${index}` });
  }
  session.close();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /backlog exceeded/);
  assert.equal(transportCloses, 1);
  assert.equal(playbackCloses, 1);
  assert.equal(callbacks, 1);
});

test('policy denial and session closure discard late audio and ASR', async () => {
  const { session, received, deny } = setup();
  session.handle({ type: 'inputCommitted', itemId: 'u1' });
  deny();
  session.handle({
    type: 'inputTranscript',
    itemId: 'u1',
    transcript: 'private',
  });
  assert.deepEqual(received, []);
  await assert.rejects(session.speak('denied'), /disabled/);
  session.close();
  session.handle({ type: 'inputTranscript', itemId: 'u2', transcript: 'late' });
  assert.deepEqual(received, []);
});
