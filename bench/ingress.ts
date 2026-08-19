import * as fs from 'node:fs';
import * as path from 'node:path';
import { INTERNAL_CHANNEL_ID } from '../src/types.js';
import type { InboundMessage } from '../src/agent.js';
import type { InboundMessageAttachment } from '../src/lib/envelope.js';
import type { CandidateIngressSpec, ScenarioSpec } from './schema.js';

export type ResolvedCandidateIngress = Omit<InboundMessage, 'onDelivered'>;

function derivedAuthorId(author: string): string {
  return `person-${author.toLocaleLowerCase()}`;
}

function resolveAttachment(workRoot: string, attachment: Extract<CandidateIngressSpec, { kind: 'discord' | 'watch' }>['attachments'][number]): InboundMessageAttachment {
  const root = fs.realpathSync(workRoot);
  const target = path.resolve(root, attachment.path);
  if (target === root || !target.startsWith(root + path.sep)) throw new Error(`ingress attachment escapes work directory: ${attachment.path}`);
  const realTarget = fs.realpathSync(target);
  if (!realTarget.startsWith(root + path.sep)) throw new Error(`ingress attachment escapes work directory through symlink: ${attachment.path}`);
  const stat = fs.statSync(realTarget);
  if (!stat.isFile()) throw new Error(`ingress attachment is not a file: ${attachment.path}`);
  return {
    url: attachment.url,
    name: attachment.name ?? path.basename(realTarget),
    contentType: attachment.contentType,
    localPath: realTarget,
    size: stat.size,
    ...(attachment.inlineText !== undefined ? { inlineText: attachment.inlineText } : {}),
  };
}

function resolveDeclared(
  spec: ScenarioSpec,
  ingress: CandidateIngressSpec,
  index: number,
  phase: 'initial' | 'resume',
  workRoot: string,
): ResolvedCandidateIngress {
  const baseTime = Date.parse(spec.fixture.clockAt!);
  const createdAt = new Date(baseTime + ingress.atOffsetMs).toISOString();
  const id = ingress.id ?? `${phase}-${ingress.kind}-${index}`;
  const empty = { replyTo: null, forwarded: null, mentions: [] as string[], attachments: [] as InboundMessageAttachment[] };

  if (ingress.kind === 'heartbeat') {
    return {
      id, channelId: INTERNAL_CHANNEL_ID, channelName: 'heartbeat', author: 'agent', authorId: 'agent',
      content: '[heartbeat]', createdAt, ...empty, kind: 'heartbeat',
    };
  }
  if (ingress.kind === 'discord') {
    const channelId = spec.fixture.channels[ingress.channel];
    if (!channelId) throw new Error(`production ingress references unknown channel: ${ingress.channel}`);
    const policyChannelId = ingress.policyChannel ? spec.fixture.channels[ingress.policyChannel] : channelId;
    if (!policyChannelId) throw new Error(`production ingress references unknown policy channel: ${ingress.policyChannel}`);
    return {
      id, channelId, channelName: ingress.channelName ?? ingress.channel,
      author: ingress.author, authorId: ingress.authorId ?? derivedAuthorId(ingress.author),
      content: ingress.content, createdAt,
      replyTo: ingress.replyTo ? {
        ...ingress.replyTo,
        authorId: ingress.replyTo.authorId ?? derivedAuthorId(ingress.replyTo.author),
      } : null,
      forwarded: ingress.forwarded,
      mentions: ingress.mentions,
      attachments: ingress.attachments.map((attachment) => resolveAttachment(workRoot, attachment)),
      guildId: 'workspace-guild', guildSlug: ingress.guildSlug ?? 'workspace',
      ...(ingress.bot !== undefined ? { bot: ingress.bot } : {}),
      wakeClass: ingress.wakeClass, policyChannelId, kind: 'discord',
    };
  }
  if (ingress.kind === 'scheduler') {
    const channelId = ingress.channel ? spec.fixture.channels[ingress.channel] : INTERNAL_CHANNEL_ID;
    if (!channelId) throw new Error(`production scheduler ingress references unknown channel: ${ingress.channel}`);
    return {
      id, channelId, channelName: 'scheduler', author: ingress.author, authorId: ingress.author,
      content: ingress.content, createdAt, ...empty, kind: 'scheduler',
    };
  }
  if (ingress.kind === 'watch') {
    return {
      id, channelId: INTERNAL_CHANNEL_ID, channelName: 'watch', author: ingress.author, authorId: ingress.author,
      content: ingress.content, createdAt, replyTo: null, forwarded: null, mentions: [],
      attachments: ingress.attachments.map((attachment) => resolveAttachment(workRoot, attachment)), kind: 'watch',
    };
  }
  return {
    id, channelId: INTERNAL_CHANNEL_ID, channelName: 'harness', author: ingress.author, authorId: ingress.author,
    content: ingress.content, createdAt, ...empty, kind: 'harness',
    ...(ingress.sendScope ? { sendScope: ingress.sendScope } : {}),
  };
}

function declaredBatch(spec: ScenarioSpec, resumed: boolean): CandidateIngressSpec[] {
  if (spec.track !== 'production') return [];
  const batch = resumed
    ? spec.resumeIngressBatch ?? (spec.resumeIngress ? [spec.resumeIngress] : undefined)
    : spec.ingressBatch ?? (spec.ingress ? [spec.ingress] : undefined);
  if (!batch) throw new Error(resumed ? 'production restart requires explicit resume ingress' : 'production scenario requires explicit ingress');
  return batch;
}

export function resolveCandidateIngressBatch(
  spec: ScenarioSpec,
  resumed: boolean,
  workRoot = '/home/agent/data',
): ResolvedCandidateIngress[] {
  if (spec.track === 'production') {
    const phase = resumed ? 'resume' : 'initial';
    return declaredBatch(spec, resumed).map((ingress, index) => resolveDeclared(spec, ingress, index, phase, workRoot));
  }
  const content = resumed
    ? `Continue after the simulated restart. Verify the requested outcome and finish cleanly without duplicating completed work. Original request: ${spec.prompt}`
    : spec.prompt;
  const createdAt = new Date().toISOString();
  if (spec.fixture.heartbeat) return [{
    id: `micro-heartbeat-${resumed ? 'resume' : 'initial'}`, channelId: INTERNAL_CHANNEL_ID, channelName: 'heartbeat',
    author: 'agent', authorId: 'agent', content, createdAt,
    replyTo: null, forwarded: null, mentions: [], attachments: [], kind: 'heartbeat',
  }];
  const channelName = spec.fixture.inputChannel ?? Object.keys(spec.fixture.channels)[0];
  const channelId = spec.fixture.channels[channelName];
  if (!channelId) throw new Error(`unknown fixture input channel: ${channelName}`);
  const author = spec.fixture.inputAuthor ?? 'human';
  return [{
    id: `micro-discord-${resumed ? 'resume' : 'initial'}`, channelId, channelName, author,
    authorId: spec.fixture.inputAuthor ? derivedAuthorId(author) : 'person-human', content, createdAt,
    replyTo: null, forwarded: null, mentions: [], attachments: [], wakeClass: 'wake', kind: 'discord',
  }];
}

export function resolveCandidateIngress(spec: ScenarioSpec, resumed: boolean, workRoot = '/home/agent/data'): ResolvedCandidateIngress {
  const batch = resolveCandidateIngressBatch(spec, resumed, workRoot);
  if (batch.length !== 1) throw new Error(`candidate ingress batch has ${batch.length} events; use resolveCandidateIngressBatch`);
  return batch[0];
}
