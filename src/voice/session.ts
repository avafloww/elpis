import { randomUUID } from 'node:crypto';
import type { VoiceDelivery } from '../types.js';
import { MAX_VOICE_TRANSCRIPT_BYTES } from './receipt.js';

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
};

/** A transient media projection: finalized ingress and explicit sends remain
 * owned by the resident loop. No callback here invokes a model turn or tool. */
export class VoiceSession {
  private closed = false;
  private readonly inputs = new Map<
    string,
    {
      text?: string;
      done: boolean;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private pending?: PendingSpeech;

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
        this.options.onNotice(
          'Voice input backlog exceeded its limit; the call ended.',
        );
        this.close();
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
      const pending = this.pending;
      if (pending && event.requestToken === pending.requestToken) {
        if (!pending.responseId) pending.responseId = event.responseId;
        if (pending.responseId === event.responseId) return;
      }
      // An unmatched creation is never authorized to play. Once its concrete
      // id exists it can be cancelled without risking another response.
      try {
        this.options.transport.cancelResponse(event.responseId);
      } catch {
        /* connection may already be closing */
      }
    } else if (event.type === 'error' || event.type === 'closed') {
      this.options.onNotice(
        'Voice connection ended; readable conversation remains available.',
      );
      this.close();
    } else {
      const pending = this.pending;
      if (!pending || event.responseId !== pending.responseId) return;
      if (event.type === 'responseDone') {
        // A terminal provider response must never receive response.cancel. It
        // may still have locally buffered audio, which barge-in can interrupt.
        if (pending.generationDone) return;
        pending.generationDone = true;
        if (event.status !== 'completed') {
          this.settle('failed');
          return;
        }
        if (!this.options.canSend()) {
          this.interrupt();
          return;
        }
        if (pending.bytes === 0) {
          this.settle('failed');
          return;
        }
        // Generation ending is not delivery: keep the send pending until the
        // audio player drains, and let barge-in interrupt that drain too.
        void this.options.playback.finish().then(
          (playedMs) => {
            if (this.pending === pending) this.settle('played', playedMs);
          },
          () => {
            if (this.pending === pending) this.settle('failed');
          },
        );
        return;
      }
      if (pending.generationDone) return;
      if (!this.options.canSend()) {
        this.interrupt();
        return;
      }
      if (event.type === 'audio') {
        pending.bytes += event.pcm.length;
        if (pending.bytes > 24_000 * 2 * 120) {
          this.settle('failed');
          return;
        }
        try {
          this.options.playback.write(event.pcm);
        } catch {
          this.settle('failed');
        }
      } else if (event.type === 'outputTranscript') {
        const transcript = event.final
          ? event.transcript
          : pending.transcript + event.transcript;
        if (
          Buffer.byteLength(transcript, 'utf8') > MAX_VOICE_TRANSCRIPT_BYTES
        ) {
          this.settle('failed');
          return;
        }
        pending.transcript = transcript;
      }
    }
  }

  async speak(text: string): Promise<VoiceDelivery> {
    if (this.closed || !this.options.canSend())
      throw new Error('voice sending is disabled');
    if (this.pending) throw new Error('voice playback is already active');
    if (!text.trim() || text.length > 4_000)
      throw new Error('voice speech must contain 1..4000 characters');
    return new Promise<VoiceDelivery>((resolve) => {
      const requestToken = randomUUID();
      const timer = setTimeout(
        () => this.settle('failed'),
        this.options.responseTimeoutMs ?? 120_000,
      );
      timer.unref?.();
      this.pending = {
        resolve,
        requestToken,
        transcript: '',
        timer,
        bytes: 0,
        requestSent: false,
        generationDone: false,
      };
      try {
        this.pending.requestSent = true;
        this.options.transport.speakText(text, requestToken);
      } catch {
        if (this.pending) this.pending.requestSent = false;
        this.settle('failed');
      }
    });
  }

  interrupt(): void {
    this.settle('interrupted');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.settle('interrupted');
    for (const input of this.inputs.values()) clearTimeout(input.timer);
    this.inputs.clear();
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
    this.options.onClose?.();
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
      if (input.text && this.options.canReceive())
        this.options.onUtterance(id, input.text);
    }
  }

  private settle(status: VoiceDelivery['status'], playedMs?: number): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (status !== 'played') {
      if (
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
    pending.resolve({
      status,
      transcript: pending.transcript,
      playedMs: Math.max(0, Math.round(playedMs ?? 0)),
    });
  }
}
