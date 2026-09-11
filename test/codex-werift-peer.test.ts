import assert from 'node:assert/strict';
import test from 'node:test';

type Unsubscribe = { unSubscribe(): void };

type Listener<Args extends unknown[]> = (...args: Args) => void;

/** Minimal stand-in for werift 0.24.4's Event (including its spelling). */
class FakeWeriftEvent<Args extends unknown[]> {
  readonly listeners = new Set<Listener<Args>>();
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  subscribeError: Error | undefined;

  subscribe(listener: Listener<Args>): Unsubscribe {
    this.subscribeCalls += 1;
    if (this.subscribeError) throw this.subscribeError;
    this.listeners.add(listener);
    let subscribed = true;
    return {
      unSubscribe: () => {
        if (!subscribed) return;
        subscribed = false;
        this.unsubscribeCalls += 1;
        this.listeners.delete(listener);
      },
    };
  }

  emit(...args: Args): void {
    for (const listener of [...this.listeners]) listener(...args);
  }

  snapshot(): Listener<Args>[] {
    return [...this.listeners];
  }
}

type DataChannelState = 'connecting' | 'open' | 'closing' | 'closed';
type PeerConnectionState =
  'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
type IceGatheringState = 'new' | 'gathering' | 'complete';

type RtpHeaderInput = {
  marker: boolean;
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
};

type FakeRtpPacket = {
  readonly fixture: 'rtp-packet';
  readonly header: RtpHeaderInput;
  readonly payload: Buffer;
};

class FakeDataChannel {
  readonly onMessage = new FakeWeriftEvent<[string | Buffer]>();
  readonly error = new FakeWeriftEvent<[Error]>();
  readonly stateChanged = new FakeWeriftEvent<[DataChannelState]>();
  readyState: DataChannelState = 'connecting';
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closeCalls = 0;
  closeError: Error | undefined;

  send(text: string): void {
    this.sent.push(text);
  }

  setState(state: DataChannelState): void {
    this.readyState = state;
    this.stateChanged.emit(state);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 'closed';
    if (this.closeError) throw this.closeError;
  }
}

/** Both local and receiver tracks intentionally expose the real werift seams. */
class FakeAudioTrack {
  readonly kind = 'audio';
  readonly onReceiveRtp = new FakeWeriftEvent<[FakeRtpPacket]>();
  readonly written: FakeRtpPacket[] = [];
  stopCalls = 0;
  stopError: Error | undefined;

  writeRtp(packet: FakeRtpPacket): void {
    this.written.push(packet);
  }

  stop(): void {
    this.stopCalls += 1;
    if (this.stopError) throw this.stopError;
  }
}

class FakePeerConnection {
  readonly connectionStateChange = new FakeWeriftEvent<[PeerConnectionState]>();
  readonly iceGatheringStateChange = new FakeWeriftEvent<[IceGatheringState]>();
  connectionState: PeerConnectionState = 'new';
  iceGatheringState: IceGatheringState = 'new';
  localDescription: { type: 'offer'; sdp: string } | undefined;
  readonly dataChannel = new FakeDataChannel();
  readonly receiverTrack = new FakeAudioTrack();
  readonly createDataChannelCalls: Array<{
    label: string;
    options: Record<string, unknown> | undefined;
  }> = [];
  readonly addTransceiverCalls: Array<{
    track: unknown;
    options: Record<string, unknown> | undefined;
  }> = [];
  createOfferCalls = 0;
  readonly setLocalDescriptionCalls: unknown[] = [];
  readonly setRemoteDescriptionCalls: unknown[] = [];
  closeCalls = 0;
  closeError: Error | undefined;

  createDataChannel(
    label: string,
    options?: Record<string, unknown>,
  ): FakeDataChannel {
    this.createDataChannelCalls.push({ label, options });
    return this.dataChannel;
  }

  addTransceiver(
    track: unknown,
    options?: Record<string, unknown>,
  ): { receiver: { track: FakeAudioTrack } } {
    this.addTransceiverCalls.push({ track, options });
    return { receiver: { track: this.receiverTrack } };
  }

  async createOffer(): Promise<{ type: 'offer'; sdp: string }> {
    this.createOfferCalls += 1;
    return { type: 'offer', sdp: 'v=0\r\na=x-fixture:ungathered\r\n' };
  }

  async setLocalDescription(description: unknown): Promise<void> {
    this.setLocalDescriptionCalls.push(description);
    this.iceGatheringState = 'gathering';
    this.localDescription = {
      type: 'offer',
      sdp: 'v=0\r\na=x-fixture:gathering\r\n',
    };
  }

  async setRemoteDescription(description: unknown): Promise<void> {
    this.setRemoteDescriptionCalls.push(description);
  }

  completeIce(sdp: string): void {
    this.localDescription = { type: 'offer', sdp };
    this.iceGatheringState = 'complete';
    this.iceGatheringStateChange.emit('complete');
  }

  setConnectionState(state: PeerConnectionState): void {
    this.connectionState = state;
    this.connectionStateChange.emit(state);
  }

  close(): void {
    this.closeCalls += 1;
    this.connectionState = 'closed';
    if (this.closeError) throw this.closeError;
  }
}

class FakeOpusCodec {
  readonly encodedPcm: Buffer[] = [];
  readonly decodedPayloads: Buffer[] = [];
  encodeImpl: (pcm: Buffer) => Buffer = (_pcm) =>
    Buffer.from([0xf0, this.encodedPcm.length]);
  decodeImpl: (payload: Buffer) => Buffer = (payload) =>
    Buffer.from(payload.map((value) => value ^ 0xff));

  encode(pcm: Buffer): Buffer {
    this.encodedPcm.push(Buffer.from(pcm));
    return Buffer.from(this.encodeImpl(pcm));
  }

  decode(payload: Buffer): Buffer {
    this.decodedPayloads.push(Buffer.from(payload));
    return Buffer.from(this.decodeImpl(payload));
  }
}

type MediaPeer = {
  createOffer(): Promise<string>;
  applyAnswer(sdp: string): Promise<void>;
  appendAudio(pcm: Uint8Array): void;
  sendEvent(text: string): void;
  close(): void | Promise<void>;
};

type CreateMediaPeer = (options: Record<string, unknown>) => MediaPeer;

let createCodexWeriftMediaPeer: CreateMediaPeer;
let createDefaultCodexWeriftMediaPeer: CreateMediaPeer;
try {
  ({ createCodexWeriftMediaPeer, createDefaultCodexWeriftMediaPeer } =
    (await import('../src/voice/codex-werift-peer.js')) as {
      createCodexWeriftMediaPeer: CreateMediaPeer;
      createDefaultCodexWeriftMediaPeer: CreateMediaPeer;
    });
} catch (error) {
  assert.fail(
    'missing future module src/voice/codex-werift-peer.ts: ' +
      (error instanceof Error ? error.message : String(error)),
  );
}

type FixtureOverrides = {
  maxInboundPcmBytes?: number;
  maxInboundTextBytes?: number;
  maxBufferedAmount?: number;
};

function fixture(overrides: FixtureOverrides = {}) {
  const pc = new FakePeerConnection();
  const localTrack = new FakeAudioTrack();
  const codec = new FakeOpusCodec();
  const audio: Buffer[] = [];
  const events: string[] = [];
  const errors: Error[] = [];
  const configurations: Array<Record<string, unknown>> = [];
  const packetInputs: Array<{
    header: RtpHeaderInput;
    payload: Buffer;
    packet: FakeRtpPacket;
  }> = [];
  let peerFactoryCalls = 0;
  let trackFactoryCalls = 0;
  const peer = createCodexWeriftMediaPeer({
    createPeerConnection: (configuration: Record<string, unknown>) => {
      peerFactoryCalls += 1;
      configurations.push(configuration);
      return pc;
    },
    createAudioTrack: () => {
      trackFactoryCalls += 1;
      return localTrack;
    },
    opusCodec: codec,
    randomUint16: () => 32_100,
    randomUint32: () => 0x1020_3040,
    createRtpPacket: (
      header: RtpHeaderInput,
      payload: Uint8Array,
    ): FakeRtpPacket => {
      const packet: FakeRtpPacket = {
        fixture: 'rtp-packet',
        header: { ...header },
        payload: Buffer.from(payload),
      };
      packetInputs.push({
        header: { ...header },
        payload: Buffer.from(payload),
        packet,
      });
      return packet;
    },
    maxInboundPcmBytes: overrides.maxInboundPcmBytes ?? 4_096,
    maxInboundTextBytes: overrides.maxInboundTextBytes ?? 1_024,
    maxBufferedAmount: overrides.maxBufferedAmount ?? 64,
    onAudio: (pcm: Uint8Array) => audio.push(Buffer.from(pcm)),
    onEvent: (text: string) => events.push(text),
    onError: (error: Error) => errors.push(error),
  });
  return {
    pc,
    localTrack,
    codec,
    audio,
    events,
    errors,
    packetInputs,
    configurations,
    peer,
    get peerFactoryCalls() {
      return peerFactoryCalls;
    },
    get trackFactoryCalls() {
      return trackFactoryCalls;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

const COMPLETE_SDP =
  'v=0\r\n' +
  'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' +
  'a=rtpmap:111 opus/48000/2\r\n' +
  'a=candidate:fixture 1 udp 1 192.0.2.1 9 typ host\r\n' +
  'a=end-of-candidates\r\n';

test('default binding constructs and closes without offer or media effects', async () => {
  assert.equal(typeof createDefaultCodexWeriftMediaPeer, 'function');
  const audio: Uint8Array[] = [];
  const events: string[] = [];
  const errors: Error[] = [];
  const peer = createDefaultCodexWeriftMediaPeer({
    maxInboundPcmBytes: 5_760,
    maxInboundTextBytes: 65_536,
    maxBufferedAmount: 131_072,
    onAudio: (value: Uint8Array) => audio.push(value),
    onEvent: (value: string) => events.push(value),
    onError: (error: Error) => errors.push(error),
  });
  await peer.close();
  assert.deepEqual(audio, []);
  assert.deepEqual(events, []);
  assert.deepEqual(errors, []);
});

test('creates one ordered event channel and one sendrecv audio transceiver', () => {
  const f = fixture();
  assert.equal(f.peerFactoryCalls, 1);
  assert.equal(f.trackFactoryCalls, 1);
  assert.equal(f.configurations.length, 1);
  const codecs = (
    f.configurations[0]?.codecs as {
      audio?: Array<Record<string, unknown>>;
    }
  )?.audio;
  assert.equal(codecs?.length, 1);
  assert.equal(String(codecs?.[0]?.mimeType).toLowerCase(), 'audio/opus');
  assert.equal(codecs?.[0]?.clockRate, 48_000);
  assert.equal(codecs?.[0]?.channels, 2);
  assert.equal(codecs?.[0]?.payloadType, 111);
  assert.equal(f.pc.createDataChannelCalls.length, 1);
  assert.equal(f.pc.createDataChannelCalls[0]!.label, 'oai-events');
  assert.equal(f.pc.createDataChannelCalls[0]!.options?.ordered, true);
  assert.equal(f.pc.addTransceiverCalls.length, 1);
  assert.equal(f.pc.addTransceiverCalls[0]!.track, f.localTrack);
  assert.equal(f.pc.addTransceiverCalls[0]!.options?.direction, 'sendrecv');
});

test('sets the local offer and waits for complete gathered SDP', async () => {
  const f = fixture();
  let result: string | undefined;
  const offering = f.peer.createOffer().then((sdp) => {
    result = sdp;
    return sdp;
  });
  await flushMicrotasks();
  assert.equal(f.pc.createOfferCalls, 1);
  assert.deepEqual(f.pc.setLocalDescriptionCalls, [
    { type: 'offer', sdp: 'v=0\r\na=x-fixture:ungathered\r\n' },
  ]);
  assert.equal(result, undefined, 'must not expose partially gathered SDP');
  assert.equal(f.pc.iceGatheringStateChange.listeners.size, 1);

  f.pc.completeIce(COMPLETE_SDP);
  assert.equal(await offering, COMPLETE_SDP);
  assert.equal(f.pc.iceGatheringStateChange.listeners.size, 0);
});

test('applyAnswer resolves only after the peer is connected and channel is open', async () => {
  const f = fixture();
  const answerSdp =
    'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=setup:active\r\n';
  let ready = false;
  const applying = f.peer.applyAnswer(answerSdp).then(() => {
    ready = true;
  });
  await flushMicrotasks();
  assert.deepEqual(f.pc.setRemoteDescriptionCalls, [
    { type: 'answer', sdp: answerSdp },
  ]);
  assert.equal(ready, false);

  f.pc.setConnectionState('connected');
  await flushMicrotasks();
  assert.equal(ready, false, 'connected peer alone is not ready');
  f.pc.dataChannel.setState('open');
  await applying;
  assert.equal(ready, true);

  const reverse = fixture();
  let reverseReady = false;
  const reverseApplying = reverse.peer.applyAnswer(answerSdp).then(() => {
    reverseReady = true;
  });
  await flushMicrotasks();
  reverse.pc.dataChannel.setState('open');
  await flushMicrotasks();
  assert.equal(reverseReady, false, 'open channel alone is not ready');
  reverse.pc.setConnectionState('connected');
  await reverseApplying;
  assert.equal(reverseReady, true);
});

test('frames 24 kHz mono s16 PCM and writes one constructed RTP packet per frame', () => {
  const f = fixture();
  const first = Buffer.alloc(960);
  const second = Buffer.alloc(960);
  for (let index = 0; index < 960; index += 1) {
    first[index] = index & 0xff;
    second[index] = (index * 3 + 7) & 0xff;
  }

  f.peer.appendAudio(first.subarray(0, 240));
  assert.equal(f.codec.encodedPcm.length, 0, 'partial frames stay buffered');
  f.peer.appendAudio(first.subarray(240));
  f.peer.appendAudio(second);

  assert.deepEqual(f.codec.encodedPcm, [first, second]);
  assert.equal(f.packetInputs.length, 2);
  assert.equal(f.localTrack.written.length, 2);
  assert.equal(f.localTrack.written[0], f.packetInputs[0]!.packet);
  assert.equal(f.localTrack.written[1], f.packetInputs[1]!.packet);
  assert.deepEqual(
    f.packetInputs.map(({ header }) => ({
      marker: header.marker,
      payloadType: header.payloadType,
      sequenceNumber: header.sequenceNumber,
      timestamp: header.timestamp,
      ssrc: header.ssrc,
    })),
    [
      {
        marker: true,
        payloadType: 111,
        sequenceNumber: 32_100,
        timestamp: 0x1020_3040,
        ssrc: 0x1020_3040,
      },
      {
        marker: false,
        payloadType: 111,
        sequenceNumber: 32_101,
        timestamp: 0x1020_3400,
        ssrc: 0x1020_3040,
      },
    ],
  );
  assert.deepEqual(
    f.packetInputs.map(({ payload }) => payload),
    [Buffer.from([0xf0, 1]), Buffer.from([0xf0, 2])],
  );
});

test('rejects more than one PCM frame per append before encoding', () => {
  const f = fixture();
  assert.throws(
    () => f.peer.appendAudio(Buffer.alloc(961)),
    /frame|audio|large|960/i,
  );
  assert.deepEqual(f.codec.encodedPcm, []);
  assert.deepEqual(f.localTrack.written, []);
});

test('decodes receiver.track.onReceiveRtp payloads and bounds delivered PCM', () => {
  const f = fixture({ maxInboundPcmBytes: 6 });
  f.codec.decodeImpl = () => Buffer.from([1, 2, 3, 4, 5, 6]);
  const encoded = Buffer.from([0xa1, 0xb2, 0xc3]);
  f.pc.receiverTrack.onReceiveRtp.emit({
    fixture: 'rtp-packet',
    header: {
      marker: false,
      payloadType: 111,
      sequenceNumber: 4,
      timestamp: 5,
      ssrc: 6,
    },
    payload: encoded,
  });
  assert.deepEqual(f.codec.decodedPayloads, [encoded]);
  assert.deepEqual(f.audio, [Buffer.from([1, 2, 3, 4, 5, 6])]);
  assert.deepEqual(f.errors, []);

  f.codec.decodeImpl = () => Buffer.alloc(7, 9);
  f.pc.receiverTrack.onReceiveRtp.emit({
    fixture: 'rtp-packet',
    header: {
      marker: false,
      payloadType: 111,
      sequenceNumber: 7,
      timestamp: 8,
      ssrc: 9,
    },
    payload: Buffer.from([0xdd]),
  });
  assert.equal(f.audio.length, 1, 'oversized decoded PCM is never delivered');
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0]!.message, /pcm|audio|byte|limit|exceed/i);
});

test('forwards opaque text exactly and fatally rejects malformed Buffer UTF-8', () => {
  const f = fixture();
  const opaque = '{not-json: true, value: \"neutral ✓\"}\n';
  f.pc.dataChannel.onMessage.emit(opaque);
  f.pc.dataChannel.onMessage.emit(Buffer.from(opaque, 'utf8'));
  assert.deepEqual(f.events, [opaque, opaque]);

  f.pc.dataChannel.onMessage.emit(Buffer.from([0xc3, 0x28]));
  assert.deepEqual(f.events, [opaque, opaque]);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0]!.message, /utf|decode|text/i);
});

test('checks Buffer byte bounds before attempting fatal UTF-8 decode', () => {
  const f = fixture({ maxInboundTextBytes: 4 });
  f.pc.dataChannel.onMessage.emit(Buffer.from('four'));
  assert.deepEqual(f.events, ['four']);

  // Invalid UTF-8 is deliberate: the reported size failure proves that the
  // byte limit is enforced before TextDecoder is allowed to inspect it.
  f.pc.dataChannel.onMessage.emit(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]));
  assert.deepEqual(f.events, ['four']);
  assert.equal(f.errors.length, 1);
  assert.match(
    f.errors[0]!.message,
    /text.*(?:limit|exceed)|(?:limit|exceed).*text/i,
  );
});

test('sendEvent requires an open channel and bounded channel buffering', () => {
  const f = fixture({ maxBufferedAmount: 10 });
  assert.throws(() => f.peer.sendEvent('opaque'), /open/i);
  assert.deepEqual(f.pc.dataChannel.sent, []);

  f.pc.dataChannel.setState('open');
  f.pc.dataChannel.bufferedAmount = 11;
  assert.throws(
    () => f.peer.sendEvent('{still:not-json}'),
    /buffer|backpressure|limit/i,
  );
  assert.deepEqual(f.pc.dataChannel.sent, []);

  f.pc.dataChannel.bufferedAmount = 8;
  assert.throws(() => f.peer.sendEvent('✓'), /buffer|backpressure|limit/i);
  f.pc.dataChannel.bufferedAmount = 9;
  f.peer.sendEvent('x');
  assert.deepEqual(f.pc.dataChannel.sent, ['x']);
});

test('connection, channel, and decode failures each report onError once', async (t) => {
  await t.test('connection failure rejects pending readiness', async () => {
    const f = fixture();
    const applying = f.peer.applyAnswer('v=0\r\n');
    const rejected = assert.rejects(applying, /connection|failed/i);
    await flushMicrotasks();
    f.pc.setConnectionState('failed');
    f.pc.setConnectionState('failed');
    await rejected;
    assert.equal(f.errors.length, 1);
    assert.ok(f.errors[0] instanceof Error);
  });

  await t.test('channel error rejects pending readiness', async () => {
    const f = fixture();
    const applying = f.peer.applyAnswer('v=0\r\n');
    const rejected = assert.rejects(applying, /channel|fixture/i);
    await flushMicrotasks();
    const fault = new Error('fixture channel failure');
    f.pc.dataChannel.error.emit(fault);
    f.pc.dataChannel.error.emit(fault);
    await rejected;
    assert.equal(f.errors.length, 1);
    assert.ok(f.errors[0] instanceof Error);
  });

  await t.test('decode failures are single-shot', () => {
    const f = fixture();
    f.codec.decodeImpl = () => {
      throw new Error('fixture decode failure');
    };
    const packet: FakeRtpPacket = {
      fixture: 'rtp-packet',
      header: {
        marker: false,
        payloadType: 111,
        sequenceNumber: 1,
        timestamp: 2,
        ssrc: 3,
      },
      payload: Buffer.from([4]),
    };
    f.pc.receiverTrack.onReceiveRtp.emit(packet);
    f.pc.receiverTrack.onReceiveRtp.emit(packet);
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0]!.message, /decode|fixture/i);
  });
});

test('subscription failure unwinds prior subscriptions and media resources', () => {
  const pc = new FakePeerConnection();
  const localTrack = new FakeAudioTrack();
  const codec = new FakeOpusCodec();
  const subscriptionFailure = new Error('fixture message subscription failure');
  pc.dataChannel.onMessage.subscribeError = subscriptionFailure;

  assert.throws(
    () =>
      createCodexWeriftMediaPeer({
        createPeerConnection: () => pc,
        createAudioTrack: () => localTrack,
        opusCodec: codec,
        randomUint16: () => 1,
        randomUint32: () => 2,
        createRtpPacket: () => {
          throw new Error('not reached');
        },
        maxInboundPcmBytes: 4_096,
        maxInboundTextBytes: 1_024,
        maxBufferedAmount: 64,
        onAudio: () => undefined,
        onEvent: () => undefined,
        onError: () => undefined,
      }),
    (error) => error === subscriptionFailure,
  );
  assert.equal(pc.connectionStateChange.unsubscribeCalls, 1);
  assert.equal(pc.dataChannel.stateChanged.unsubscribeCalls, 1);
  assert.equal(pc.dataChannel.error.unsubscribeCalls, 1);
  assert.equal(pc.dataChannel.closeCalls, 1);
  assert.equal(localTrack.stopCalls, 1);
  assert.equal(pc.closeCalls, 1);
});

test('construction failure cleans every acquired media resource', () => {
  const pc = new FakePeerConnection();
  const localTrack = new FakeAudioTrack();
  const codec = new FakeOpusCodec();
  const constructionFailure = new Error(
    'fixture transceiver construction failure',
  );
  pc.addTransceiver = () => {
    throw constructionFailure;
  };

  assert.throws(
    () =>
      createCodexWeriftMediaPeer({
        createPeerConnection: () => pc,
        createAudioTrack: () => localTrack,
        opusCodec: codec,
        randomUint16: () => 1,
        randomUint32: () => 2,
        createRtpPacket: () => {
          throw new Error('not reached');
        },
        maxInboundPcmBytes: 4_096,
        maxInboundTextBytes: 1_024,
        maxBufferedAmount: 64,
        onAudio: () => undefined,
        onEvent: () => undefined,
        onError: () => undefined,
      }),
    (error) => error === constructionFailure,
  );
  assert.equal(pc.dataChannel.closeCalls, 1);
  assert.equal(localTrack.stopCalls, 1);
  assert.equal(pc.closeCalls, 1);
});

test('close rejects pending readiness without reporting a transport failure', async () => {
  const f = fixture();
  const applying = f.peer.applyAnswer('v=0\r\n');
  const rejected = assert.rejects(applying, /closed/i);
  await flushMicrotasks();
  f.peer.close();
  await rejected;
  assert.deepEqual(f.errors, []);
});

test('close attempts every resource and preserves the first cleanup failure', async () => {
  const f = fixture();
  const channelFailure = new Error('fixture channel close failure');
  f.pc.dataChannel.closeError = channelFailure;
  f.localTrack.stopError = new Error('fixture track stop failure');
  f.pc.closeError = new Error('fixture peer close failure');

  await assert.rejects(f.peer.close(), (error) => error === channelFailure);
  assert.equal(f.pc.dataChannel.closeCalls, 1);
  assert.equal(f.localTrack.stopCalls, 1);
  assert.equal(f.pc.closeCalls, 1);
  await assert.rejects(f.peer.close(), (error) => error === channelFailure);
  assert.equal(f.pc.dataChannel.closeCalls, 1);
  assert.equal(f.localTrack.stopCalls, 1);
  assert.equal(f.pc.closeCalls, 1);
});

test('close is idempotent, unsubscribes, and fences snapshotted late callbacks', () => {
  const f = fixture();
  const staleConnection = f.pc.connectionStateChange.snapshot();
  const staleChannelState = f.pc.dataChannel.stateChanged.snapshot();
  const staleChannelErrors = f.pc.dataChannel.error.snapshot();
  const staleMessages = f.pc.dataChannel.onMessage.snapshot();
  const staleRtp = f.pc.receiverTrack.onReceiveRtp.snapshot();
  assert.ok(staleConnection.length > 0);
  assert.ok(staleChannelState.length > 0);
  assert.ok(staleChannelErrors.length > 0);
  assert.ok(staleMessages.length > 0);
  assert.ok(staleRtp.length > 0);

  f.peer.close();
  f.peer.close();
  assert.equal(f.pc.dataChannel.closeCalls, 1);
  assert.equal(f.localTrack.stopCalls, 1);
  assert.equal(f.pc.closeCalls, 1);
  assert.equal(f.pc.connectionStateChange.listeners.size, 0);
  assert.equal(f.pc.dataChannel.stateChanged.listeners.size, 0);
  assert.equal(f.pc.dataChannel.error.listeners.size, 0);
  assert.equal(f.pc.dataChannel.onMessage.listeners.size, 0);
  assert.equal(f.pc.receiverTrack.onReceiveRtp.listeners.size, 0);

  const latePacket: FakeRtpPacket = {
    fixture: 'rtp-packet',
    header: {
      marker: false,
      payloadType: 111,
      sequenceNumber: 1,
      timestamp: 2,
      ssrc: 3,
    },
    payload: Buffer.from([4]),
  };
  for (const listener of staleConnection) listener('failed');
  for (const listener of staleChannelState) listener('open');
  for (const listener of staleChannelErrors)
    listener(new Error('late channel failure'));
  for (const listener of staleMessages) listener(Buffer.from('late'));
  for (const listener of staleRtp) listener(latePacket);

  assert.deepEqual(f.audio, []);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.codec.decodedPayloads, []);
  assert.equal(f.pc.dataChannel.closeCalls, 1);
  assert.equal(f.localTrack.stopCalls, 1);
  assert.equal(f.pc.closeCalls, 1);
  assert.throws(() => f.peer.appendAudio(Buffer.alloc(960)), /closed/i);
  assert.throws(() => f.peer.sendEvent('late outbound'), /closed/i);
});
