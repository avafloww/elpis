import { randomUUID } from 'node:crypto';
import type { VoiceChannel } from 'discord.js';
import type { Agent, InboundMessage } from '../agent.js';
import type { Config } from '../config.js';
import type { MuteStore } from '../store/mutes.js';
import type { VoiceDelivery } from '../types.js';
import { buildGuildIndex, resolveChannelPolicy } from '../discord/wake.js';
import { RealtimeVoiceTransport, type RealtimeVoiceEvent } from './realtime.js';
import { createDiscordAudioSession } from './discord-audio.js';
import { VoiceSession } from './session.js';

const VAD_COMMIT_TIMEOUT_MS = 10_000;

export interface DiscordVoiceController {
  readonly channelId: string | null;
  join(channel: VoiceChannel): Promise<void>;
  leave(): void;
  speak(text: string): Promise<VoiceDelivery>;
  /** Capture the exact active call before another delivery await. The returned
   * capability never follows a later leave/rejoin, even to the same channel. */
  captureSpeech(
    channelId: string,
  ): ((text: string) => Promise<VoiceDelivery>) | null;
}

export interface DiscordVoiceTransport {
  connect(): Promise<void>;
  appendAudio(pcm: Uint8Array): void;
  speakText(text: string, requestToken: string): void;
  cancelResponse(responseId: string): void;
  deleteInput(itemId: string): void;
  close(): void;
}

export interface DiscordVoiceDependencies {
  mutes?: MuteStore;
  createTransport?: (
    options: ConstructorParameters<typeof RealtimeVoiceTransport>[0],
  ) => DiscordVoiceTransport;
  createAudio?: typeof createDiscordAudioSession;
}

/** Authorization is checked at join and again on every ingress/playback path. */
export function voiceChannelAllowed(
  config: Config,
  channelId: string,
  guildId: string,
): boolean {
  const policy = resolveChannelPolicy(
    guildId,
    channelId,
    buildGuildIndex(config.discord.guilds),
  );
  return Boolean(
    config.discord.voice?.enabled &&
    policy?.guild.slug === 'home' &&
    policy.source === 'channel' &&
    policy.tier !== 'drop' &&
    policy.allowSend,
  );
}

export function createDiscordVoice(
  config: Config,
  agent: Pick<Agent, 'enqueue'>,
  deps: DiscordVoiceDependencies = {},
): DiscordVoiceController {
  let active: {
    channel: VoiceChannel;
    session: VoiceSession;
    close(): void;
  } | null = null;
  let joining = false;
  let generation = 0;
  let cancelJoin: (() => void) | undefined;

  const controller: DiscordVoiceController = {
    get channelId() {
      return active?.channel.id ?? null;
    },
    async join(channel) {
      if (joining || active)
        throw new Error(
          'Already joining or joined to voice; use /leave first.',
        );
      const voice = config.discord.voice;
      const operatorId = config.operator.discordId;
      if (!voice?.enabled || !voice.apiKey || !operatorId)
        throw new Error(
          'Voice is not configured. Set discord.voice.enabled and its dedicated api_key.',
        );
      if (!voiceChannelAllowed(config, channel.id, channel.guild.id))
        throw new Error(
          'Voice requires an explicitly configured home voice channel with receive and send enabled.',
        );
      if (deps.mutes?.get(channel.id)?.type === 'deafen')
        throw new Error('This voice channel is deafened.');
      if (config.discord.ignoredUserIds.includes(operatorId))
        throw new Error(
          'The operator is excluded by discord.ignored_user_ids.',
        );
      if (!channel.members.has(operatorId))
        throw new Error('Join the voice channel before using /join.');
      joining = true;
      const epoch = ++generation;
      const callId = randomUUID();
      let closed = false;
      let interval: ReturnType<typeof setInterval> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let vadCommitDeadline: ReturnType<typeof setTimeout> | undefined;
      let lastAudioAt = 0;
      let speechOpen = false;
      let localSpeaking = false;
      let sentAudioBytes = 0;
      let lastLocalAudioEndMs = 0;
      let committedAudioEndMs = -1;
      const stoppedItems = new Map<string, number>();
      let rejectCancelled: ((error: Error) => void) | undefined;
      let session!: VoiceSession;
      let audio!: ReturnType<typeof createDiscordAudioSession>;
      let transport!: DiscordVoiceTransport;
      const current = () => !closed && epoch === generation;
      const retireCommittedTail = () => {
        // Keep the acknowledged offset until Discord's later local end event.
        // Older commits cannot retire microphone data beyond their boundary.
        if (!localSpeaking && committedAudioEndMs >= lastLocalAudioEndMs) {
          speechOpen = false;
          clearTimeout(vadCommitDeadline);
          vadCommitDeadline = undefined;
        }
      };
      const canReceive = () =>
        current() &&
        channel.members.has(operatorId) &&
        voiceChannelAllowed(config, channel.id, channel.guild.id) &&
        deps.mutes?.get(channel.id)?.type !== 'deafen';
      const canSend = () =>
        current() &&
        channel.members.has(operatorId) &&
        voiceChannelAllowed(config, channel.id, channel.guild.id) &&
        !deps.mutes?.get(channel.id);
      const notice = (text: string) => {
        if (!current()) return;
        agent.enqueue({
          id: `voice-notice-${randomUUID()}`,
          channelId: channel.id,
          channelName: channel.name,
          guildId: channel.guild.id,
          guildSlug: 'home',
          author: 'harness',
          authorId: 'harness',
          kind: 'harness',
          content: `[voice] ${text}`,
          createdAt: new Date().toISOString(),
          replyTo: null,
          forwarded: null,
          mentions: [],
          attachments: [],
        });
      };
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        clearTimeout(deadline);
        clearTimeout(vadCommitDeadline);
        stoppedItems.clear();
        rejectCancelled?.(new Error('Voice join was cancelled.'));
        session?.close();
        audio?.close();
        transport?.close();
        if (active?.session === session) active = null;
      };
      const cancelled = new Promise<never>((_resolve, reject) => {
        rejectCancelled = reject;
      });
      // Constructors and callbacks may fail before the first connection race.
      void cancelled.catch(() => {});
      cancelJoin = close;
      try {
        const onEvent = (event: RealtimeVoiceEvent) => {
          if (!current()) return;
          if (event.type === 'speechStarted') speechOpen = true;
          if (event.type === 'speechStopped') {
            if (stoppedItems.size >= 32 && !stoppedItems.has(event.itemId)) {
              notice(
                'Voice boundary backlog exceeded its limit; the call ended.',
              );
              close();
              return;
            }
            stoppedItems.set(event.itemId, event.audioEndMs);
          }
          if (event.type === 'inputCommitted') {
            const audioEndMs = stoppedItems.get(event.itemId);
            stoppedItems.delete(event.itemId);
            // VAD offsets refer to all PCM written during this session.
            if (audioEndMs !== undefined)
              committedAudioEndMs = Math.max(committedAudioEndMs, audioEndMs);
            retireCommittedTail();
          }
          if (
            event.type === 'ready' ||
            event.type === 'speechStopped' ||
            event.type === 'audioDone' ||
            event.type === 'assistantAudioTruncated'
          )
            return;
          session?.handle(event);
        };
        transport = (
          deps.createTransport ??
          ((options) => new RealtimeVoiceTransport(options))
        )({
          apiKey: voice.apiKey,
          model: voice.model,
          voice: voice.voice,
          transcriptionModel: voice.transcriptionModel,
          instructions:
            'You are the audio transport for a persistent resident. Transcribe input speech. Speak only the exact text supplied in an explicit speech request. Never answer input audio autonomously.',
          onEvent,
        });
        audio = (deps.createAudio ?? createDiscordAudioSession)({
          operatorUserId: operatorId,
          onAudio: (pcm) => {
            if (!canReceive()) return;
            clearTimeout(vadCommitDeadline);
            vadCommitDeadline = undefined;
            lastAudioAt = Date.now();
            speechOpen = true;
            sentAudioBytes += pcm.byteLength;
            lastLocalAudioEndMs = sentAudioBytes / 48;
            transport.appendAudio(pcm);
          },
          onSpeechStart: () => {
            if (!canReceive()) return;
            clearTimeout(vadCommitDeadline);
            vadCommitDeadline = undefined;
            speechOpen = true;
            localSpeaking = true;
            lastAudioAt = Date.now();
            session.interrupt();
          },
          onUtteranceEnd: () => {
            localSpeaking = false;
            retireCommittedTail();
            if (!current() || !speechOpen) return;
            clearTimeout(vadCommitDeadline);
            vadCommitDeadline = setTimeout(() => {
              if (!current() || !speechOpen) return;
              notice(
                'Voice input did not reach an utterance boundary; the call ended.',
              );
              close();
            }, VAD_COMMIT_TIMEOUT_MS);
            vadCommitDeadline.unref?.();
          },
          onError: () => {
            notice('Discord audio failed; the call ended.');
            close();
          },
        });
        session = new VoiceSession({
          transport,
          playback: {
            write: (pcm) => {
              if (!audio.playPcm16(pcm))
                throw new Error('Voice playback buffer is full.');
            },
            finish: () => audio.finishPlayback(),
            interrupt: () => audio.interruptPlayback(),
            close: () => audio.close(),
          },
          canReceive,
          canSend,
          onNotice: notice,
          onClose: close,
          onUtterance: (itemId, text) => {
            const member = channel.members.get(operatorId);
            if (!member || !canReceive()) return;
            const message: InboundMessage = {
              id: `voice-${callId}-${itemId}`,
              source: 'voice',
              kind: 'discord',
              channelId: channel.id,
              policyChannelId: channel.id,
              channelName: channel.name,
              guildId: channel.guild.id,
              guildSlug: 'home',
              authorId: operatorId,
              author: member.displayName,
              bot: false,
              content: text,
              createdAt: new Date().toISOString(),
              replyTo: null,
              forwarded: null,
              mentions: [],
              attachments: [],
              wakeClass: 'wake',
            };
            agent.enqueue(message);
          },
        });
        await Promise.race([transport.connect(), cancelled]);
        if (!current()) throw new Error('Voice join was cancelled.');
        await Promise.race([audio.connect(channel), cancelled]);
        if (!current()) throw new Error('Voice join was cancelled.');
        active = { channel, session, close };
        // Discord suppresses silent packets. Feed silence at wall-clock pace
        // only while VAD is deciding an utterance boundary, never commit twice.
        interval = setInterval(() => {
          if (!canReceive()) {
            notice('Voice ended because channel access changed.');
            close();
            return;
          }
          if (!canSend()) session.interrupt();
          if (speechOpen && Date.now() - lastAudioAt >= 40) {
            try {
              sentAudioBytes += 960;
              transport.appendAudio(Buffer.alloc(960));
            } catch {
              notice('Voice audio transport failed; the call ended.');
              close();
            }
          }
        }, 20);
        interval.unref?.();
        deadline = setTimeout(() => {
          notice(
            'Voice session reached its configured time limit. Use /join to start another call.',
          );
          close();
        }, voice.maxSessionMinutes * 60_000);
        deadline.unref?.();
        notice(
          'Joined the operator’s voice channel. Finalized speech enters this conversation. Explicit sends to this channel deliver readable text and streamed speech; use short conversational replies. Other microphones are not ingested. /leave ends the call.',
        );
      } catch (error) {
        close();
        throw error;
      } finally {
        if (epoch === generation) {
          joining = false;
          cancelJoin = undefined;
        }
      }
    },
    leave() {
      generation++;
      // A dependency may ignore close while connecting. Release the join slot
      // synchronously and let the local cancellation race unwind that attempt.
      joining = false;
      cancelJoin?.();
      cancelJoin = undefined;
      active?.close();
      active = null;
    },
    async speak(text) {
      if (!active) throw new Error('Voice is not connected.');
      return active.session.speak(text);
    },
    captureSpeech(channelId) {
      const captured = active;
      if (!captured || captured.channel.id !== channelId) return null;
      return async (text) => {
        if (active?.session !== captured.session)
          throw new Error('The captured voice session has ended.');
        return captured.session.speak(text);
      };
    },
  };
  return controller;
}
