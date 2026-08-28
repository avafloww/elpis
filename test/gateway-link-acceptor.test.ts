import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  RESIDENT_CONTROL_FORMATS,
  RESIDENT_CONTROL_PATHS,
  createNodeCredential,
  decodeCredentialVerifier,
  type GatewayToResidentFrame,
  type ResidentToGatewayFrame,
} from '@elpis/gateway-protocol';
import {
  GatewayResidentLinkRegistry,
  createGatewayHttpService,
  createGatewayResidentLinkAuditWriter,
  openGatewayStore,
} from '../packages/gateway/src/index.js';
import {
  GatewayLinkController,
  WsGatewayLinkSocket,
  type GatewayLinkSocketFactory,
  type GatewayLinkStatus,
} from '../src/gateway-link.js';
import { openDatabase } from '../src/store/db.js';
import { createGatewayResidentStore } from '../src/store/gateway-resident.js';

const ORIGIN = 'https://gateway.example';

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(label + ' timed out');
}

function mappedFactory(
  localUrl: string,
  requested: Array<{ url: string; connectionId: string }>,
): GatewayLinkSocketFactory {
  return (url, options) => {
    requested.push({ url, connectionId: options.connectionId });
    return new WsGatewayLinkSocket(localUrl, options);
  };
}

function fatalDisconnect(
  connectionId: GatewayToResidentFrame['connectionId'],
): GatewayToResidentFrame {
  return {
    version: PROTOCOL_VERSION,
    connectionId,
    seq: 2,
    type: 'error',
    error: { code: 'invalid_frame', message: 'integration disconnect' },
    fatal: true,
  };
}

test('resident controller authenticates, reconnects, and rejects wrong or revoked tokens', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-gateway-link-acceptor-'),
  );
  const residentDirectory = path.join(directory, 'resident');
  const gatewayDirectory = path.join(directory, 'gateway');
  const publicRoot = path.join(directory, 'public');
  fs.mkdirSync(residentDirectory, { recursive: true });
  fs.mkdirSync(publicRoot, { recursive: true });
  fs.writeFileSync(path.join(publicRoot, 'index.html'), 'gateway');

  const residentDatabase = openDatabase(residentDirectory);
  const resident = createGatewayResidentStore(residentDatabase);
  const gateway = openGatewayStore(gatewayDirectory);
  let service: ReturnType<typeof createGatewayHttpService> | null = null;
  let controller: GatewayLinkController | null = null;
  let wrongController: GatewayLinkController | null = null;

  try {
    const grant = gateway.credentials.createEnrollmentGrant();
    resident.beginEnrollment({
      endpoint: ORIGIN,
      displayName: 'Aster',
      grantToken: grant.token,
    });
    const request = resident.enrollmentRequest();
    const enrollment = gateway.credentials.enroll({
      grantToken: request.grantToken,
      instanceId: request.instanceId,
      displayName: request.displayName,
      credentialId: request.credentialId,
      credentialVerifier: decodeCredentialVerifier(request.credentialVerifier),
      requestId: request.requestId,
    });
    resident.activateEnrollment({
      format: RESIDENT_CONTROL_FORMATS.enrollmentResult,
      instanceId: request.instanceId,
      credentialId: request.credentialId,
      replayed: enrollment.replayed,
    });
    assert.equal(resident.read().phase, 'active');
    const activeToken = resident.activeNodeToken();

    const received: ResidentToGatewayFrame[] = [];
    const registry = new GatewayResidentLinkRegistry({
      clock: {
        now: Date.now,
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (handle) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      supportedCapabilities: CAPABILITIES,
      audit: createGatewayResidentLinkAuditWriter(gateway),
      handshakeTimeoutMs: 1_000,
      onFrame: (_link, frame) => received.push(frame),
    });
    service = createGatewayHttpService({
      publicRoot,
      listen: { host: '127.0.0.1', port: 0 },
      store: gateway,
      residentCredentialStore: gateway.credentials,
      residentLinkRegistry: registry,
      residentRateLimiter: { allow: () => true },
      shutdownGraceMs: 200,
    });
    const address = await service.start();
    const localUrl =
      'ws://127.0.0.1:' + address.port + RESIDENT_CONTROL_PATHS.link;
    const expectedUrl = 'wss://gateway.example' + RESIDENT_CONTROL_PATHS.link;
    const requested: Array<{ url: string; connectionId: string }> = [];
    const statuses: GatewayLinkStatus[] = [];
    controller = new GatewayLinkController({
      remote: { url: ORIGIN, enrollmentToken: null },
      store: resident,
      identity: { name: 'Aster' },
      build: { version: '1.2.3', revision: 'a'.repeat(40), state: 'dev' },
      retryBaseMs: 20,
      retryMaxMs: 40,
      random: () => 0,
      socketFactory: mappedFactory(localUrl, requested),
      events: { status: (status) => statuses.push(status) },
    });
    controller.start();

    try {
      await waitFor(
        'first authenticated ready link',
        () =>
          controller?.status.state === 'ready' &&
          registry.summary(request.instanceId)?.state === 'ready',
      );
    } catch {
      throw new Error(
        'first ready evidence: ' +
          JSON.stringify({
            status: controller.status,
            statuses: statuses.slice(-12),
            summary: registry.summary(request.instanceId) ?? null,
            audit: gateway
              .audit()
              .slice(-12)
              .map((event) => ({ action: event.action, detail: event.detail })),
            attempts: requested.length,
          }),
      );
    }
    const first = registry.summary(request.instanceId)!;
    assert.deepEqual(first.capabilities, ['identity.v1']);
    assert.equal(requested[0]?.url, expectedUrl);
    assert.equal(requested[0]?.connectionId, first.connectionId);
    assert.equal(received[0]?.type, 'hello');
    if (received[0]?.type !== 'hello') throw new Error('missing hello frame');
    assert.equal(received[0].identity.name, 'Aster');
    assert.equal(received[0].build.version, '1.2.3');
    assert.ok(
      gateway
        .audit()
        .some((event) => event.action === 'gateway.resident.link.ready'),
    );

    const reconnectStatusStart = statuses.length;
    assert.equal(
      registry.send(
        request.instanceId,
        first.connectionId,
        fatalDisconnect(first.connectionId),
      ),
      true,
    );
    await waitFor('reconnected authenticated ready link', () => {
      const current = registry.summary(request.instanceId);
      return (
        controller?.status.state === 'ready' &&
        current?.state === 'ready' &&
        current.connectionId !== first.connectionId
      );
    });
    const second = registry.summary(request.instanceId)!;
    assert.ok(
      statuses
        .slice(reconnectStatusStart)
        .some((status) => status.state === 'backoff' && status.failures === 1),
    );
    assert.equal(requested.length >= 2, true);
    assert.equal(
      requested.every(({ url }) => url === expectedUrl),
      true,
    );

    const admittedBeforeWrong = gateway
      .audit()
      .filter(
        (event) => event.action === 'gateway.resident.link.admitted',
      ).length;
    const wrongNode = createNodeCredential();
    const wrongToken =
      `egc1.${request.credentialId}.` + wrongNode.token.split('.')[2];
    const wrongStatuses: GatewayLinkStatus[] = [];
    const wrongRequested: Array<{ url: string; connectionId: string }> = [];
    wrongController = new GatewayLinkController({
      remote: { url: ORIGIN, enrollmentToken: null },
      store: {
        read: () => resident.read(),
        activeNodeToken: () => wrongToken,
      },
      identity: { name: 'Wrong credential' },
      build: { version: '1.2.3' },
      retryBaseMs: 20,
      retryMaxMs: 40,
      random: () => 0,
      socketFactory: mappedFactory(localUrl, wrongRequested),
      events: { status: (status) => wrongStatuses.push(status) },
    });
    wrongController.start();
    await waitFor('wrong credential rejection', () =>
      wrongStatuses.some((status) => status.state === 'backoff'),
    );
    assert.equal(
      wrongStatuses.some((status) => status.state === 'ready'),
      false,
    );
    assert.equal(wrongRequested.length >= 1, true);
    assert.equal(
      wrongRequested.every(({ url }) => url === expectedUrl),
      true,
    );
    assert.equal(
      registry.summary(request.instanceId)?.connectionId,
      second.connectionId,
    );
    assert.equal(
      gateway
        .audit()
        .filter((event) => event.action === 'gateway.resident.link.admitted')
        .length,
      admittedBeforeWrong,
    );
    wrongController.stop();
    wrongController = null;

    const replacement = createNodeCredential();
    gateway.credentials.proposeRotation(
      activeToken,
      replacement.id,
      replacement.verifier,
      'integration-rotation',
    );
    gateway.credentials.activateRotation(replacement.token);
    assert.equal(gateway.credentials.authenticateNode(activeToken), null);

    const revokedStatusStart = statuses.length;
    const requestedBeforeRevoke = requested.length;
    assert.equal(
      registry.send(
        request.instanceId,
        second.connectionId,
        fatalDisconnect(second.connectionId),
      ),
      true,
    );
    await waitFor(
      'revoked credential reconnect rejection',
      () =>
        requested.length > requestedBeforeRevoke &&
        registry.summary(request.instanceId) === undefined &&
        statuses
          .slice(revokedStatusStart)
          .some((status) => status.state === 'backoff'),
    );
    assert.equal(
      statuses
        .slice(revokedStatusStart)
        .some((status) => status.state === 'ready'),
      false,
    );
    assert.equal(
      gateway
        .audit()
        .filter((event) => event.action === 'gateway.resident.link.admitted')
        .length,
      admittedBeforeWrong,
    );

    const publicEvidence = JSON.stringify({
      statuses,
      wrongStatuses,
      requested,
      wrongRequested,
      received,
      audit: gateway.audit(),
      summaries: registry.summaries(),
    });
    for (const secret of [
      grant.token,
      activeToken,
      wrongNode.token,
      wrongToken,
      replacement.token,
    ])
      assert.equal(publicEvidence.includes(secret), false);

    controller.stop();
    controller = null;
    await waitFor('all resident peers closed', () => registry.size === 0);
  } finally {
    wrongController?.stop();
    controller?.stop();
    await service?.stop();
    gateway.close();
    residentDatabase.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
