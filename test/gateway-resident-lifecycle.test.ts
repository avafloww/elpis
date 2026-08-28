import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  RESIDENT_CONTROL_FORMATS,
  RESIDENT_CONTROL_PATHS,
  createGatewayHelloAck,
  decodeCredentialVerifier,
  decodeResidentEnrollmentRequest,
  decodeResidentRotationActivationRequest,
  decodeResidentRotationRequest,
  parseNodeBearerAuthorization,
  serializeGatewayFrame,
  serializeResidentEnrollmentResult,
  serializeResidentRotationResult,
  type ResidentEnrollmentResult,
  type ResidentRotationResult,
} from '@elpis/gateway-protocol';
import { openGatewayStore } from '../packages/gateway/src/index.js';
import {
  GatewayEnrollmentController,
  type GatewayEnrollmentFetch,
} from '../src/gateway-enrollment.js';
import {
  GatewayLinkController,
  type GatewayLinkClock,
  type GatewayLinkSocket,
  type GatewayLinkSocketHandlers,
  type GatewayLinkStatus,
} from '../src/gateway-link.js';
import {
  GatewayRotationController,
  type GatewayRotationFetch,
} from '../src/gateway-rotation.js';
import { SecretRegistry } from '../src/lib/secrets.js';
import { openDatabase } from '../src/store/db.js';
import { GatewayResidentStore } from '../src/store/gateway-resident.js';

const ORIGIN = 'https://gateway.example';

class ManualClock implements GatewayLinkClock {
  readonly timers = new Map<number, { callback: () => void; delay: number }>();
  #next = 1;

  now(): number {
    return 1;
  }

  setTimeout(callback: () => void, delay: number): unknown {
    const id = this.#next++;
    this.timers.set(id, { callback, delay });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  fire(): void {
    const entry = [...this.timers.entries()][0];
    assert.ok(entry);
    this.timers.delete(entry[0]);
    entry[1].callback();
  }
}

class ManualSocket extends EventEmitter implements GatewayLinkSocket {
  handlers?: GatewayLinkSocketHandlers;
  readonly sent: string[] = [];
  readonly closed: Array<[number, string]> = [];
  terminated = 0;

  attach(handlers: GatewayLinkSocketHandlers): () => void {
    this.handlers = handlers;
    this.on('open', handlers.open);
    this.on('message-event', handlers.message);
    this.on('error-event', handlers.error);
    this.on('close-event', handlers.close);
    return () => {
      this.off('open', handlers.open);
      this.off('message-event', handlers.message);
      this.off('error-event', handlers.error);
      this.off('close-event', handlers.close);
    };
  }

  sendText(text: string): void {
    this.sent.push(text);
  }

  close(code: number, reason: string): void {
    this.closed.push([code, reason]);
  }

  terminate(): void {
    this.terminated += 1;
  }

  message(text: string): void {
    this.emit('message-event', text, false);
  }
}

function enrollmentResponse(
  receipt: Omit<ResidentEnrollmentResult, 'format'>,
): Response {
  const value: ResidentEnrollmentResult = {
    format: RESIDENT_CONTROL_FORMATS.enrollmentResult,
    ...receipt,
  };
  return new Response(serializeResidentEnrollmentResult(value), {
    status: value.replayed ? 200 : 201,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function rotationResponse(
  receipt: Omit<ResidentRotationResult, 'format'>,
  activation = false,
): Response {
  const value: ResidentRotationResult = {
    format: RESIDENT_CONTROL_FORMATS.rotationResult,
    ...receipt,
  };
  return new Response(serializeResidentRotationResult(value), {
    status: activation || value.replayed ? 200 : 201,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * One transport-neutral witness crosses both durable stores and all resident
 * controllers.  Leaf tests cover hostile codecs and the real HTTP/WS adapter;
 * this test intentionally uses no server, wall clock, or subprocess.
 */
test('resident lifecycle replays exact durable work across restarts', async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-resident-lifecycle-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const residentDirectory = path.join(root, 'resident');
  const gatewayDirectory = path.join(root, 'gateway');
  fs.mkdirSync(residentDirectory, { recursive: true });

  let residentDb = openDatabase(residentDirectory);
  let resident = new GatewayResidentStore(residentDb);
  let gateway = openGatewayStore(gatewayDirectory);
  const grant = gateway.credentials.createEnrollmentGrant();
  const allSecrets = new Set<string>([grant.token]);
  const statuses: unknown[] = [];
  const receipts: unknown[] = [];
  const logs: string[] = [];
  const residentSnapshots: unknown[] = [];
  const socketPublicCaptures: unknown[] = [];

  const recordResident = (): void => {
    residentSnapshots.push(resident.read());
    for (const secret of resident.secretValues()) allSecrets.add(secret);
  };
  const recordStatus = (kind: string, value: unknown): void => {
    statuses.push(value);
    logs.push(kind + ': ' + JSON.stringify(value));
  };
  const restart = (): void => {
    residentDb.close();
    gateway.close();
    residentDb = openDatabase(residentDirectory);
    resident = new GatewayResidentStore(residentDb);
    gateway = openGatewayStore(gatewayDirectory);
    recordResident();
  };

  // The Gateway commits enrollment, but the resident loses that response.
  let enrollmentBody = '';
  const firstEnrollmentFetch: GatewayEnrollmentFetch = async (url, init) => {
    assert.equal(url, ORIGIN + RESIDENT_CONTROL_PATHS.enrollment);
    enrollmentBody = init.body as string;
    const request = decodeResidentEnrollmentRequest(enrollmentBody);
    const receipt = gateway.credentials.enroll({
      grantToken: request.grantToken,
      instanceId: request.instanceId,
      displayName: request.displayName,
      credentialId: request.credentialId,
      credentialVerifier: decodeCredentialVerifier(request.credentialVerifier),
      requestId: request.requestId,
    });
    receipts.push(receipt);
    throw new Error('simulated lost enrollment response');
  };
  const firstEnrollment = new GatewayEnrollmentController({
    store: resident,
    secrets: new SecretRegistry(),
    remote: { url: ORIGIN, enrollmentToken: grant.token },
    displayName: 'Aster',
    fetch: firstEnrollmentFetch,
  });
  const enrollmentFailure = await firstEnrollment.start();
  recordStatus('enrollment', enrollmentFailure);
  assert.deepEqual(enrollmentFailure, { code: 'network_error' });
  recordResident();
  const durableEnrollment = resident.read();
  assert.equal(durableEnrollment.phase, 'enrolling');

  // Both sides restart. The resident sends byte-for-byte identical work and
  // accepts only the Gateway's exact replay receipt.
  restart();
  let enrollmentReplayCalls = 0;
  const enrollmentReplay = new GatewayEnrollmentController({
    store: resident,
    secrets: new SecretRegistry(),
    remote: { url: ORIGIN, enrollmentToken: grant.token },
    displayName: 'A changed display name cannot alter prepared work',
    fetch: async (_url, init) => {
      enrollmentReplayCalls += 1;
      assert.equal(init.body, enrollmentBody);
      const request = decodeResidentEnrollmentRequest(init.body as string);
      const receipt = gateway.credentials.enroll({
        grantToken: request.grantToken,
        instanceId: request.instanceId,
        displayName: request.displayName,
        credentialId: request.credentialId,
        credentialVerifier: decodeCredentialVerifier(
          request.credentialVerifier,
        ),
        requestId: request.requestId,
      });
      receipts.push(receipt);
      assert.equal(receipt.replayed, true);
      return enrollmentResponse(
        receipt as Omit<ResidentEnrollmentResult, 'format'>,
      );
    },
  });
  const enrolled = await enrollmentReplay.start();
  recordStatus('enrollment', enrolled);
  assert.deepEqual(enrolled, { code: 'enrolled' });
  assert.equal(enrollmentReplayCalls, 1);
  assert.equal(resident.read().phase, 'active');
  assert.equal(
    resident.read().activeCredentialId,
    durableEnrollment.pendingCredentialId,
  );
  recordResident();
  const oldToken = resident.activeNodeToken();
  allSecrets.add(oldToken);

  // A fresh resident process reads the active credential only at the outbound
  // attempt. The fake socket asks the real Gateway store to authenticate it,
  // then deterministically drives hello, ack, backoff, reconnect and cancel.
  restart();
  assert.equal(resident.activeNodeToken(), oldToken);
  const linkClock = new ManualClock();
  const sockets: ManualSocket[] = [];
  const linkStatuses: GatewayLinkStatus[] = [];
  const link = new GatewayLinkController({
    remote: { url: ORIGIN, enrollmentToken: null },
    store: resident,
    identity: { name: 'Aster' },
    build: { version: '1.2.3', revision: 'a'.repeat(40), state: 'test' },
    clock: linkClock,
    retryBaseMs: 100,
    retryMaxMs: 200,
    random: () => 0,
    randomBytes: (size) => Buffer.alloc(size, sockets.length + 1),
    socketFactory: (url, options) => {
      assert.equal(url, 'wss://gateway.example' + RESIDENT_CONTROL_PATHS.link);
      const token = parseNodeBearerAuthorization(options.authorization);
      assert.equal(token, oldToken);
      assert.deepEqual(gateway.credentials.authenticateNode(token), {
        instanceId: resident.read().instanceId,
        credentialId: resident.read().activeCredentialId,
      });
      socketPublicCaptures.push({ url, connectionId: options.connectionId });
      const socket = new ManualSocket();
      sockets.push(socket);
      return socket;
    },
    events: {
      status: (value) => {
        linkStatuses.push(value);
        recordStatus('link', value);
      },
    },
  });
  link.start();
  assert.equal(link.status.state, 'connecting');
  sockets[0]!.emit('open');
  assert.equal(sockets[0]!.sent.length, 1);
  const hello = JSON.parse(sockets[0]!.sent[0]!) as {
    connectionId: string;
    instanceId: string;
    identity: { name: string };
  };
  socketPublicCaptures.push(hello);
  assert.equal(hello.instanceId, resident.read().instanceId);
  assert.equal(hello.identity.name, 'Aster');
  sockets[0]!.message(
    serializeGatewayFrame(
      createGatewayHelloAck({
        connectionId: hello.connectionId as never,
        seq: 1,
        instanceId: hello.instanceId as never,
        capabilities: ['identity.v1'],
      }),
    ),
  );
  assert.deepEqual(link.status, { state: 'ready', failures: 0 });
  sockets[0]!.emit('close-event');
  assert.deepEqual(link.status, { state: 'backoff', failures: 1 });
  assert.equal([...linkClock.timers.values()][0]?.delay, 50);
  linkClock.fire();
  assert.equal(sockets.length, 2);
  assert.equal(link.status.state, 'connecting');
  link.stop();
  assert.equal(sockets[1]!.closed.length, 1);
  assert.equal(linkClock.timers.size, 0);
  assert.equal(link.status.state, 'stopped');
  assert.ok(linkStatuses.some((value) => value.state === 'ready'));

  // Proposal commits remotely and loses its response. Old bearer and exact
  // request survive a resident+Gateway restart for replay.
  let proposalBody = '';
  const firstRotation = new GatewayRotationController({
    store: resident,
    secrets: new SecretRegistry(),
    mode: 'trigger',
    fetch: async (url, init) => {
      assert.equal(url, ORIGIN + RESIDENT_CONTROL_PATHS.rotation);
      proposalBody = init.body as string;
      const token = parseNodeBearerAuthorization(
        (init.headers as Record<string, string>).authorization,
      );
      assert.equal(token, oldToken);
      const request = decodeResidentRotationRequest(proposalBody);
      const receipt = gateway.credentials.proposeRotation(
        token,
        request.credentialId,
        decodeCredentialVerifier(request.credentialVerifier),
        request.requestId,
      );
      receipts.push(receipt);
      throw new Error('simulated lost proposal response');
    },
  });
  const proposalFailure = await firstRotation.start();
  recordStatus('rotation', proposalFailure);
  assert.deepEqual(proposalFailure, { code: 'network_error' });
  assert.equal(resident.read().rotationProposedAt, null);
  assert.equal(resident.activeNodeToken(), oldToken);
  const pendingToken = resident.pendingNodeToken();
  allSecrets.add(pendingToken);
  recordResident();

  restart();
  let resumedProposalCalls = 0;
  let firstActivationCalls = 0;
  const proposalReplayAndLostActivation: GatewayRotationFetch = async (
    url,
    init,
  ) => {
    const authorization = (init.headers as Record<string, string>)
      .authorization;
    const token = parseNodeBearerAuthorization(authorization);
    if (url.endsWith(RESIDENT_CONTROL_PATHS.rotation)) {
      resumedProposalCalls += 1;
      assert.equal(init.body, proposalBody);
      assert.equal(token, oldToken);
      const request = decodeResidentRotationRequest(init.body as string);
      const receipt = gateway.credentials.proposeRotation(
        token,
        request.credentialId,
        decodeCredentialVerifier(request.credentialVerifier),
        request.requestId,
      );
      receipts.push(receipt);
      assert.equal(receipt.replayed, true);
      return rotationResponse(
        receipt as Omit<ResidentRotationResult, 'format'>,
      );
    }
    assert.equal(url, ORIGIN + RESIDENT_CONTROL_PATHS.rotationActivation);
    firstActivationCalls += 1;
    assert.equal(token, pendingToken);
    const request = decodeResidentRotationActivationRequest(
      init.body as string,
    );
    const receipt = gateway.credentials.activateRotation(
      token,
      request.requestId,
    );
    receipts.push(receipt);
    assert.equal(receipt.replayed, false);
    throw new Error('simulated lost activation response');
  };
  const proposalReplay = new GatewayRotationController({
    store: resident,
    secrets: new SecretRegistry(),
    mode: 'resume',
    fetch: proposalReplayAndLostActivation,
  });
  const activationFailure = await proposalReplay.start();
  recordStatus('rotation', activationFailure);
  assert.deepEqual(activationFailure, { code: 'network_error' });
  assert.equal(resumedProposalCalls, 1);
  assert.equal(firstActivationCalls, 1);
  assert.notEqual(resident.read().rotationProposedAt, null);
  assert.equal(resident.activeNodeToken(), oldToken);
  assert.equal(gateway.credentials.authenticateNode(oldToken), null);
  assert.deepEqual(gateway.credentials.authenticateNode(pendingToken), {
    instanceId: resident.read().instanceId,
    credentialId: resident.read().pendingCredentialId,
  });
  recordResident();

  // The checkpoint makes the next restart activation-only. It uses the pending
  // bearer, receives the remote exact replay, and finally swaps local active.
  restart();
  let activationReplayCalls = 0;
  const activationReplay = new GatewayRotationController({
    store: resident,
    secrets: new SecretRegistry(),
    mode: 'resume',
    fetch: async (url, init) => {
      activationReplayCalls += 1;
      assert.equal(url, ORIGIN + RESIDENT_CONTROL_PATHS.rotationActivation);
      const token = parseNodeBearerAuthorization(
        (init.headers as Record<string, string>).authorization,
      );
      assert.equal(token, pendingToken);
      const request = decodeResidentRotationActivationRequest(
        init.body as string,
      );
      const receipt = gateway.credentials.activateRotation(
        token,
        request.requestId,
      );
      receipts.push(receipt);
      assert.equal(receipt.replayed, true);
      return rotationResponse(
        receipt as Omit<ResidentRotationResult, 'format'>,
        true,
      );
    },
  });
  const rotated = await activationReplay.start();
  recordStatus('rotation', rotated);
  assert.deepEqual(rotated, { code: 'rotated' });
  assert.equal(activationReplayCalls, 1);
  assert.equal(resident.read().phase, 'active');
  assert.equal(resident.activeNodeToken(), pendingToken);
  assert.deepEqual(resident.secretValues(), [pendingToken]);
  assert.equal(gateway.credentials.authenticateNode(oldToken), null);
  recordResident();

  // Scan every observer-facing capture and both stores' public projections.
  // Transport authorization and the explicitly secret-bearing request bodies
  // were asserted in place above and are intentionally not retained here.
  const publicEvidence = JSON.stringify({
    statuses,
    receipts,
    logs,
    residentSnapshots,
    socketPublicCaptures,
    gateway: {
      config: gateway.config(),
      instances: gateway.instances(),
      audit: gateway.audit(),
    },
  });
  for (const secret of allSecrets) {
    assert.ok(secret.length > 0);
    assert.equal(publicEvidence.includes(secret), false, secret.split('.')[0]);
  }

  gateway.close();
  residentDb.close();
});
