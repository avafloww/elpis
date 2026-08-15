import { INTERNAL_CHANNEL_ID } from '../src/types.js';
import type { InboundMessage } from '../src/agent.js';
import type { CandidateIngressSpec, ScenarioSpec } from './schema.js';

export type ResolvedCandidateIngress = Pick<InboundMessage, 'channelId' | 'channelName' | 'author' | 'authorId' | 'content' | 'kind'>;

function resolveDeclared(spec: ScenarioSpec, ingress: CandidateIngressSpec): ResolvedCandidateIngress {
  if (ingress.kind === 'heartbeat') {
    return { channelId: INTERNAL_CHANNEL_ID, channelName: 'heartbeat', author: 'agent', authorId: 'agent', content: '[heartbeat]', kind: 'heartbeat' };
  }
  if (ingress.kind === 'discord') {
    const channelId = spec.fixture.channels[ingress.channel];
    if (!channelId) throw new Error(`production ingress references unknown channel: ${ingress.channel}`);
    return { channelId, channelName: ingress.channel, author: ingress.author, authorId: ingress.authorId ?? `person-${ingress.author.toLocaleLowerCase()}`, content: ingress.content, kind: 'discord' };
  }
  return { channelId: INTERNAL_CHANNEL_ID, channelName: ingress.kind, author: ingress.author, authorId: ingress.author, content: ingress.content, kind: ingress.kind };
}

export function resolveCandidateIngress(spec: ScenarioSpec, resumed: boolean): ResolvedCandidateIngress {
  if (spec.track === 'production') {
    const declared = resumed ? spec.resumeIngress : spec.ingress;
    if (!declared) throw new Error(resumed ? 'production restart requires explicit resumeIngress' : 'production scenario requires explicit ingress');
    return resolveDeclared(spec, declared);
  }
  const content = resumed
    ? `Continue after the simulated restart. Verify the requested outcome and finish cleanly without duplicating completed work. Original request: ${spec.prompt}`
    : spec.prompt;
  if (spec.fixture.heartbeat) return { channelId: INTERNAL_CHANNEL_ID, channelName: 'heartbeat', author: 'agent', authorId: 'agent', content, kind: 'heartbeat' };
  const channelName = spec.fixture.inputChannel ?? Object.keys(spec.fixture.channels)[0];
  const channelId = spec.fixture.channels[channelName];
  if (!channelId) throw new Error(`unknown fixture input channel: ${channelName}`);
  const author = spec.fixture.inputAuthor ?? 'human';
  return { channelId, channelName, author, authorId: spec.fixture.inputAuthor ? `person-${author.toLocaleLowerCase()}` : 'person-human', content, kind: 'discord' };
}
