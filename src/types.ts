import type { InboundMessage } from './agent.js';
import type { BgRegistry } from './sandbox/bg.js';
import type { SshRegistry } from './sandbox/ssh.js';
import type {
  ChatMessage,
  StandaloneCompleteOptions,
  StandaloneCompleteResult,
} from './llm/llm.js';
import type { MindService } from './store/mind.js';
import type { MindId } from './store/mind-id.js';
import type { ReplayIdentity } from './llm/provenance.js';
import type { ExtensionRegistry } from './extensions.js';
import type {
  BuiltinModuleRegistry,
  RuntimeProfile,
} from './builtin-modules.js';
import type { SandboxExecutionMetadata } from './sandbox/metadata.js';
import type { WorkerSession } from './worker/spawn.js';
import type { WorkerMailboxMessage } from './worker/mailbox.js';
import type {
  WorkerArtifactFile,
  WorkerArtifactReceipt,
} from './worker/workspace.js';

export type { SandboxExecutionMetadata } from './sandbox/metadata.js';

/** Reserved provenance label for heartbeat / harness-internal traffic. In the monocontext model,
 * (monocontext) this is no longer a separate context — it is a transcript
 * `channel` stamp and the token the `channel` global refuses. Lives here (not
 * context.ts, which is deleted) so the sandbox globals can import it. */
export const INTERNAL_CHANNEL_ID = 'internal';
/** Private operator-console room. Unlike internal, this is a speakable endpoint. */
export const CONSOLE_CHANNEL_ID = 'console';

/** Where inbound Discord attachments are downloaded to (one subdir per message
 * id). Lives here so both the Discord ingest (writer) and the console server's
 * read-only /attachments/ route (reader) agree on it without the console
 * importing the whole Discord module. */
export const ATTACHMENT_DIR = '/tmp/elpis-attach';

export interface OutboundAttachment {
  /** Absolute path to the file to attach. */
  path: string;
  /** Optional display filename. Defaults to the basename of path. */
  name?: string;
}

export interface RunResult {
  ok: boolean;
  preview?: string;
  savedAs?: '_';
  logs?: string;
  error?: string;
  /** Harness-only execution classification; omitted from provider requests. */
  failureKind?: 'preparse' | 'runtime';
  /** Harness-only sandbox attribution. Provider wire translation must omit it. */
  execution?: SandboxExecutionMetadata;
  /** Present when the run detached a still-pending promise into the bg registry (A5). */
  detached?: boolean;
  /** When detached, the bg id the result will be delivered as. */
  bgId?: string;
  note?: string;
  /** The channel().send() calls made during this run, retained for console
   * rendering, feedback localization, transcript recovery, and detached futures. */
  sends?: { channel: string; text: string }[];
}

export interface SandboxLateProcessError {
  kind: 'unhandledRejection' | 'uncaughtException';
  error: unknown;
  alias?: string;
  generation?: number;
  runId?: string;
}

export interface SandboxDeps {
  /** Capability surface. Full preserves the host-local control room; core is the fresh ephemeral allowlist. */
  surface?: 'full' | 'core' | 'worker';
  /** Structural subset of `Config` — the groups the sandbox actually reads. */
  config: {
    sandbox: {
      syncTimeoutMs: number;
      asyncDeadlineMs: number;
      persistentRetirementGraceMs: number;
      previewMaxBytes: number;
      logMaxBytes: number;
    };
    kagi: { apiKey: string | null };
    bluesky: {
      service: string;
      identifier: string;
      appPassword: string;
    } | null;
    modules?: {
      enabled: import('./builtin-modules.js').BuiltinModuleId[] | null;
      disabled: import('./builtin-modules.js').BuiltinModuleId[];
    };
    paths: {
      harnessRoot: string;
      dataDirectory: string;
    };
  };
  memory: {
    read(): string;
    append(text: string): unknown;
    overwrite(text: string): unknown;
  };
  send?: (
    channelId: string,
    content: string,
    opts?: { files?: OutboundAttachment[] },
  ) => Promise<void>;
  logbuf: string[];
  /** Hot-reloaded inhabitant name (SOUL.md frontmatter), used for self-authored records. */
  agentName?: () => string;
  /** Boot-loaded, deeply frozen data-directory extension registry. */
  extensions?: ExtensionRegistry;
  /** Boot-resolved built-in module availability; shared with prompt rendering. */
  modules?: BuiltinModuleRegistry;
  /** Boot-frozen host/container authority profile. */
  profile?: RuntimeProfile;
  /** Structured metadata for the most recent inbound Discord message. */
  inbound?: InboundMessage | null;
  /** Background jobs + futures registry (A3/A5). Shared across the sandbox. */
  bg?: BgRegistry;
  /** Persistent SSH session registry (elpis.ssh): ControlMaster-reused
   * connections. Created in index.ts; dispose is called on shutdown. */
  ssh?: SshRegistry;
  /** Flush transcripts before a self-restart (D5). Optional. */
  flushTranscripts?: () => void;
  /** Test/contained-runtime seam for elpis.restart. Omitted in production,
   * where the sandbox performs the real resume-marker + lifecycle choreography. */
  restart?: (reason?: string) => { ok: true; note: string };
  /** Restricted-runtime transport seam. Production uses the boot-configured
   * internal Kubernetes broker endpoint; tests may intercept it. */
  requestRestrictedRestart?: (reason?: string) => Promise<void>;
  /** Called around elpis.sleep/wait's timer : a sleep is the agent
   * *choosing to wait*, so the typing indicator must not show through it.
   * sleepPause clears typing on the 0->1 depth edge; sleepResume re-fires it
   * once depth returns to 0, only while the turn is still live. Deliberately
   * NOT used by elpis.timeout, which caps real running work. */
  sleepPause?: () => void;
  sleepResume?: () => void;
  /** Returns the known real channel ids. Used by channel() to list known rooms
   * in the throw when called with no/unknown argument (: sourced from the
   * channels.json directory, not live contexts). */
  listChannels?: () => string[];
  /** Returns the known real channels as { id, name } objects. Used by
   * channel.list so the agent sees both ids and names. */
  listChannelsWithNames?: () => { id: string; name: string }[];
  /** Resolve a channel NAME (e.g. "unnamed-agent", with or without a leading
   * '#') or id to a channel id, or null if unknown. Lets channel("name") work
   * from the [meanwhile] digest, which shows names — without this the agent
   * had no id to pass and guessed (→ Unknown Channel). */
  resolveChannel?: (ref: string) => string | null;
  /** Resolve a channel id to its raw (non-qualified) display name, or null if
   * unknown. Used to populate channel(id)'s returned `{ id, name }` object —
   * NOT guild-qualified (see channelLabel for the delivered-echo label). */
  channelName?: (id: string) => string | null;
  /** Resolve a channel id to its guild-qualified display label ('friends-a/lounge'
   * — spelled exactly like the ref elpis.channel accepts, so it can be pasted back,
   * or '#name' for a legacy NULL-guild row, or — for an unknown channel — the
   * raw id itself, never null). Used by channel(id).send's result echo
   * ("message delivered to <label> (<id>)") so a wrong-room send is visible in the
   * very next tool result ( mis-target guardrail, now guild-aware — ). */
  channelLabel?: (id: string) => string;
  /** Trigger Discord's typing indicator in a channel. Used by channel(id).typing(). */
  typing?: (channelId: string) => void;
  /** Enqueue a watch-mode message: image frames from local paths delivered as
   * ephemeral multimodal content for exactly one generation. Used by elpis.watch. */
  watch?: (
    paths: string[],
    note: string,
    channelId?: string | null,
  ) => { ok: boolean; count: number };
  /** Exact wire identity allowed to receive opaque standalone reasoning. */
  replayIdentity?: ReplayIdentity | null;
  /** Isolated classifier lane used by wake advice and other small judgments. */
  completeStandalone?: (
    messages: ChatMessage[],
    opts?: StandaloneCompleteOptions,
  ) => Promise<StandaloneCompleteResult>;
  /** Isolated native-tool lane owned by the configured motor role. */
  motorCompleteStandalone?: (
    messages: ChatMessage[],
    opts?: StandaloneCompleteOptions,
  ) => Promise<StandaloneCompleteResult>;
  /** Durable dependency-aware work graph exposed as elpis.mind. */
  mind?: MindService;
  /** Resident-only supervision over fixed-template bounded workers. */
  worker?: {
    start(mindId: unknown, options?: unknown): Promise<WorkerSession>;
    send(ref: string, text: string): Promise<WorkerMailboxMessage>;
    list(): Promise<WorkerSession[]>;
    status(ref: string): Promise<{
      session: WorkerSession;
      messages: WorkerMailboxMessage[];
      artifacts: Array<Omit<WorkerArtifactReceipt, 'relativePath'>>;
    }>;
    artifact(ref: string, key?: string): Promise<WorkerArtifactFile>;
    dismiss(ref: string): Promise<WorkerSession>;
  };
  /** Bound Mind item for a persistent sandbox. Omitted in unbound control rooms. */
  mindDefaultId?: MindId;
  /** Persistent task scheduler. Used by schedule()/unschedule() globals. */
  scheduler?: {
    create(opts: {
      name: string;
      kind?: string;
      channelId?: string | null;
      payload: string;
      nextRunAt: number;
      intervalMs?: number | null;
      nagIntervalMs?: number | null;
      parentId?: number | null;
    }): unknown;
    delete(id: number): boolean;
    list(): unknown[];
    getByName(name: string): unknown;
    markDone(id: number): unknown;
    markDoneByName(name: string): boolean;
    snooze(id: number, until: number): unknown;
    snoozeByName(name: string, until: number): boolean;
    update(
      id: number,
      patch: {
        payload?: string;
        nextRunAt?: number;
        intervalMs?: number | null;
        nagIntervalMs?: number | null;
        snoozeUntil?: number | null;
      },
    ): unknown;
  };
  /** Called when a detached future settles (A5). The agent enqueues a synthetic
   * [bg <id> settled] message into the one history and wakes the loop. `logs`
   * carries any console output written AFTER the run detached. Under
   * there is one history, so no origin channel is tracked.
   * `sends` carries any channel.send made after the run detached. */
  onFutureSettled?: (
    id: string,
    value: unknown,
    rejected: boolean,
    logs?: string,
    sends?: { channel: string; text: string }[],
  ) => void;
  /** A callback owned by a completed run fired later from a leaked async resource. */
  onLateProcessError?: (event: SandboxLateProcessError) => void;
  /** The killswitch's self-mute path : backs
   * channel(id).mute(reason). SELF-MUTE ONLY — there is no release or deafen
   * member on the sandbox handle; that asymmetry is deliberate (Agent.moderateChannel
   * is the only place a mute can be lifted, and only for an operator actor). */
  moderate?: (
    channelId: string,
    reason?: string,
  ) => { ok: boolean; note: string };
}
