import { randomUUID } from 'node:crypto';
import type { VoiceDelivery } from '../types.js';
import { MAX_VOICE_TRANSCRIPT_BYTES } from './receipt.js';

const MAX_RESPONSE_IDENTITIES = 1_024;

export type VoiceSessionEvent =
  | { type: 'ready' }
  | { type: 'inputCommitted'; itemId: string; previousItemId?: string }
  | { type: 'inputTranscript'; itemId: string; transcript: string }
  | { type: 'inputTranscriptFailed'; itemId: string; message?: string }
  | { type: 'speechStarted'; itemId?: string }
  | { type: 'speechStopped'; itemId: string; audioEndMs: number }
  | { type: 'responseCreated'; responseId: string; requestToken: string }
  | { type: 'audio'; responseId: string; itemId: string; pcm: Buffer }
  | { type: 'audioDone'; responseId: string; itemId: string }
  | {
      type: 'outputTranscript';
      responseId: string;
      itemId: string;
      transcript: string;
      final: boolean;
    }
  | { type: 'responseDone'; responseId: string; status: string }
  | { type: 'error'; message: string }
  | { type: 'closed' };

export interface VoiceSessionOptions {
  transport: {
    speakText(text: string, requestToken: string): void;
    cancelResponse(responseId: string): void;
    deleteInput(itemId: string): void;
    close(): void;
  };
  playback: {
    write(pcm: Buffer): void;
    finish(): Promise<number>;
    interrupt(): number;
    close(): void;
  };
  canReceive(): boolean;
  canSend(): boolean;
  onUtterance(itemId: string, transcript: string): void;
  onNotice(text: string): void;
  onClose?(): void;
  transcriptionTimeoutMs?: number;
  responseTimeoutMs?: number;
}

type PendingSpeech = {
  resolve(result: VoiceDelivery): void;
  requestToken: string;
  responseId?: string;
  transcript: string;
  timer: ReturnType<typeof setTimeout>;
  bytes: number;
  requestSent: boolean;
  generationDone: boolean;
  settling: boolean;
};

/** A transient media projection: finalized ingress and explicit sends remain
 * owned by the resident loop. No callback here invokes a model turn or tool. */
export class VoiceSession {
  private closed = false;
  private cleaned = false;
  private readonly inputs = new Map<
    string,
    {
      text?: string;
      done: boolean;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private pending?: PendingSpeech;
  /** Response ids are immutable for this session. Keeping terminal owners as
   * tombstones prevents a late/replayed id from binding a later request. */
  private readonly responseOwners = new Map<string, string>();
  private readonly terminalResponses = new Set<string>();

  constructor(private readonly options: VoiceSessionOptions) {}

  handle(event: VoiceSessionEvent): void {
    if (this.closed) return;
    if (
      event.type === 'ready' ||
      event.type === 'speechStopped' ||
      event.type === 'audioDone'
    ) {
      return;
    }
    if (event.type === 'inputCommitted') {
      if (this.inputs.has(event.itemId)) return;
      if (this.inputs.size >= 32) {
        this.failClosed(
          'Voice input backlog exceeded its limit; the call ended.',
          true,
        );
        return;
      }
      const timer = setTimeout(() => {
        const input = this.inputs.get(event.itemId);
        if (!input) return;
        input.done = true;
        this.options.onNotice(
          'A voice utterance could not be transcribed; please repeat it.',
        );
        this.drain();
      }, this.options.transcriptionTimeoutMs ?? 30_000);
      timer.unref?.();
      this.inputs.set(event.itemId, { done: false, timer });
    } else if (
      event.type === 'inputTranscript' ||
      event.type === 'inputTranscriptFailed'
    ) {
      const input = this.inputs.get(event.itemId);
      if (!input || input.done) return;
      input.done = true;
      clearTimeout(input.timer);
      if (
        event.type === 'inputTranscript' &&
        event.transcript.length <= 16_000
      ) {
        input.text = event.transcript.trim();
      } else {
        this.options.onNotice(
          'A voice utterance could not be transcribed; please repeat it.',
        );
      }
      this.drain();
    } else if (event.type === 'speechStarted') {
      this.interrupt();
    } else if (event.type === 'responseCreated') {
      const owner = this.responseOwners.get(event.responseId);
      if (owner !== undefined) {
        if (owner !== event.requestToken) {
          this.failClosed(
            'Voice provider reused a response identity; the call ended.',
            false,
          );
          return;
        }
        // Identical active duplicates and terminal replays are inert.
        return;
      }
      if (this.responseOwners.size >= MAX_RESPONSE_IDENTITIES) {
        this.failClosed(
          'Voice response identity limit reached; the call ended.',
          true,
        );
        return;
      }
      this.responseOwners.set(event.responseId, event.requestToken);
      const pending = this.pending;
      if (
        this.isActivePending(pending) &&
        event.requestToken === pending.requestToken
      ) {
        if (!pending.responseId) {
          pending.responseId = event.responseId;
          return;
        }
      }
      // An unmatched creation is never authorized to play. Once its concrete
      // id exists it can be cancelled without risking another response.
      try {
        this.options.transport.cancelResponse(event.responseId);
      } catch {
        /* connection may already be closing */
      }
    } else if (event.type === 'error' || event.type === 'closed') {
      // Claim and settle terminal state before invoking external notice code.
      // Reentrant notice callbacks cannot override the failed/no-cancel policy.
      this.closed = true;
      this.finishClose(false, 'failed');
      try {
        this.options.onNotice(
          'Voice connection ended; readable conversation remains available.',
        );
      } catch {
        /* shutdown is independent of notice delivery */
      }
    } else if (event.type === 'responseDone') {
      const owner = this.responseOwners.get(event.responseId);
      if (owner === undefined || this.terminalResponses.has(event.responseId))
        return;
      this.terminalResponses.add(event.responseId);
      const pending = this.pending;
      if (
        !this.isActivePending(pending) ||
        event.responseId !== pending.responseId
      )
        return;
      // A terminal provider response must never receive response.cancel. It
      // may still have locally buffered audio, which barge-in can interrupt.
      if (pending.generationDone) return;
      pending.generationDone = true;
      if (event.status !== 'completed') {
        this.settlePending(pending, 'failed');
        return;
      }
      let canSend: boolean;
      try {
        canSend = this.options.canSend();
      } catch {
        this.settlePending(pending, 'failed');
        return;
      }
      // Policy and playback hooks are external and may synchronously reenter.
      if (!this.isActivePending(pending)) return;
      if (!canSend) {
        this.settlePending(pending, 'interrupted');
        return;
      }
      if (pending.bytes === 0) {
        this.settlePending(pending, 'failed');
        return;
      }
      // Generation ending is not delivery: keep the send pending until the
      // audio player drains, and let barge-in interrupt that drain too.
      let finished: Promise<number>;
      try {
        finished = this.options.playback.finish();
      } catch {
        this.settlePending(pending, 'failed');
        return;
      }
      if (!this.isActivePending(pending)) {
        void finished.catch(() => undefined);
        return;
      }
      try {
        void finished.then(
          (playedMs) => this.settlePending(pending, 'played', playedMs),
          () => this.settlePending(pending, 'failed'),
        );
      } catch {
        this.settlePending(pending, 'failed');
      }
    } else {
      const pending = this.pending;
      if (
        !pending ||
        event.responseId !== pending.responseId ||
        !this.isMediaEligible(pending)
      )
        return;
      let canSend: boolean;
      try {
        canSend = this.options.canSend();
      } catch {
        this.settlePending(pending, 'failed');
        return;
      }
      // canSend may synchronously close/settle the session or deliver
      // response.done. Never resume a stale media handler afterward.
      if (!this.isMediaEligible(pending)) return;
      if (!canSend) {
        this.settlePending(pending, 'interrupted');
        return;
      }
      if (event.type === 'audio') {
        pending.bytes += event.pcm.length;
        if (pending.bytes > 24_000 * 2 * 120) {
          this.settlePending(pending, 'failed');
          return;
        }
        try {
          this.options.playback.write(event.pcm);
        } catch {
          this.settlePending(pending, 'failed');
        }
      } else if (event.type === 'outputTranscript') {
        const transcript = event.final
          ? event.transcript
          : pending.transcript + event.transcript;
        if (
          Buffer.byteLength(transcript, 'utf8') > MAX_VOICE_TRANSCRIPT_BYTES
        ) {
          this.settlePending(pending, 'failed');
          return;
        }
        pending.transcript = transcript;
      }
    }
  }

  async speak(text: string): Promise<VoiceDelivery> {
    if (this.closed || this.cleaned)
      throw new Error('voice sending is disabled');
    let canSend: boolean;
    try {
      canSend = this.options.canSend();
    } catch {
      throw new Error('voice sending is disabled');
    }
    if (!canSend || this.closed || this.cleaned)
      throw new Error('voice sending is disabled');
    if (this.pending) throw new Error('voice playback is already active');
    if (!text.trim() || text.length > 4_000)
      throw new Error('voice speech must contain 1..4000 characters');
    return new Promise<VoiceDelivery>((resolve) => {
      const requestToken = randomUUID();
      let pending!: PendingSpeech;
      const timer = setTimeout(
        () => this.settlePending(pending, 'failed'),
        this.options.responseTimeoutMs ?? 120_000,
      );
      timer.unref?.();
      pending = {
        resolve,
        requestToken,
        transcript: '',
        timer,
        bytes: 0,
        requestSent: false,
        generationDone: false,
        settling: false,
      };
      this.pending = pending;
      try {
        pending.requestSent = true;
        this.options.transport.speakText(text, requestToken);
      } catch {
        if (this.pending === pending && !pending.settling) {
          pending.requestSent = false;
          this.settlePending(pending, 'failed');
        }
      }
    });
  }

  interrupt(): void {
    if (this.closed || this.cleaned) return;
    const pending = this.pending;
    if (pending) this.settlePending(pending, 'interrupted');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.finishClose(true);
  }

  private finishClose(
    cancelGeneration: boolean,
    status: VoiceDelivery['status'] = 'interrupted',
  ): void {
    if (this.cleaned) return;
    this.cleaned = true;
    const pending = this.pending;
    if (pending)
      this.settlePending(pending, status, undefined, cancelGeneration);
    for (const input of this.inputs.values()) clearTimeout(input.timer);
    this.inputs.clear();
    this.responseOwners.clear();
    this.terminalResponses.clear();
    try {
      this.options.playback.close();
    } catch {
      /* best-effort shutdown */
    }
    try {
      this.options.transport.close();
    } catch {
      /* best-effort shutdown */
    }
    try {
      this.options.onClose?.();
    } catch {
      /* owner cleanup cannot compromise terminal session state */
    }
  }

  private drain(): void {
    for (const [id, input] of this.inputs) {
      if (!input.done) break;
      clearTimeout(input.timer);
      this.inputs.delete(id);
      // Audio is request-only working state, never an independent conversation.
      try {
        this.options.transport.deleteInput(id);
      } catch {
        /* close handles transport failure */
      }
      if (this.closed || this.cleaned) return;
      if (!input.text) continue;
      let canReceive: boolean;
      try {
        canReceive = this.options.canReceive();
      } catch {
        return;
      }
      if (this.closed || this.cleaned || !canReceive) return;
      this.options.onUtterance(id, input.text);
    }
  }

  private settlePending(
    pending: PendingSpeech,
    status: VoiceDelivery['status'],
    playedMs?: number,
    cancelGeneration = true,
  ): void {
    if (this.pending !== pending || pending.settling) return;
    pending.settling = true;
    clearTimeout(pending.timer);
    if (status !== 'played') {
      if (
        cancelGeneration &&
        pending.requestSent &&
        pending.responseId &&
        !pending.generationDone
      ) {
        try {
          this.options.transport.cancelResponse(pending.responseId);
        } catch {
          /* connection may already be closed */
        }
      }
      try {
        playedMs = this.options.playback.interrupt();
      } catch {
        playedMs = 0;
      }
    }
    // Keep the identity installed through every synchronous cleanup callback,
    // so reentrant sends cannot overlap the response being settled.
    if (this.pending !== pending) return;
    this.pending = undefined;
    pending.resolve({
      status,
      transcript: pending.transcript,
      playedMs: Math.max(0, Math.round(playedMs ?? 0)),
    });
  }

  private isActivePending(
    pending: PendingSpeech | undefined,
  ): pending is PendingSpeech {
    return (
      pending !== undefined &&
      this.pending === pending &&
      !pending.settling &&
      !this.closed &&
      !this.cleaned
    );
  }

  private isMediaEligible(pending: PendingSpeech): boolean {
    return this.isActivePending(pending) && !pending.generationDone;
  }

  private failClosed(message: string, cancelGeneration: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.finishClose(cancelGeneration, 'failed');
    try {
      this.options.onNotice(message);
    } catch {
      /* shutdown is independent of notice delivery */
    }
  }
}
