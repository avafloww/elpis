import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  createNodeCredential,
  newGatewayInstanceId,
  openGatewayStore,
  verifyGatewayBackup,
} from '../src/index.js';

function fixture(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('online backup captures live WAL state and restores from one isolated DB', async (t) => {
  const sourceDirectory = fixture('elpis-gateway-backup-source-');
  const backupDirectory = fixture('elpis-gateway-backup-artifact-');
  const restoreDirectory = fixture('elpis-gateway-backup-restore-');
  t.after(() => {
    for (const directory of [
      sourceDirectory,
      backupDirectory,
      restoreDirectory,
    ])
      fs.rmSync(directory, { recursive: true, force: true });
  });

  const store = openGatewayStore(sourceDirectory);
  store.setPublicUrl('https://gateway.example.com');
  const grant = store.credentials.createEnrollmentGrant();
  const node = createNodeCredential();
  const instanceId = newGatewayInstanceId();
  store.credentials.enroll({
    grantToken: grant.token,
    instanceId,
    displayName: 'Restored Resident',
    credentialId: node.id,
    credentialVerifier: node.verifier,
  });
  const wal = `${store.databasePath}-wal`;
  assert.equal(fs.existsSync(wal), true);
  assert.ok(fs.statSync(wal).size > 0);

  const artifact = path.join(backupDirectory, 'gateway-backup.db');
  const receipt = await store.backup(artifact);
  assert.deepEqual(receipt, { path: artifact });
  assert.equal(fs.statSync(artifact).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${artifact}-wal`), false);
  assert.equal(fs.existsSync(`${artifact}-shm`), false);
  verifyGatewayBackup(artifact);
  await assert.rejects(() => store.backup(artifact), /already exists/);

  const artifactText = fs.readFileSync(artifact).toString('latin1');
  for (const forbidden of [
    grant.token,
    node.token,
    ...grant.token.split('.').slice(2),
    ...node.token.split('.').slice(2),
  ])
    assert.equal(artifactText.includes(forbidden), false);

  store.close();
  fs.rmSync(sourceDirectory, { recursive: true, force: true });
  const restoredFile = path.join(restoreDirectory, 'gateway.db');
  fs.copyFileSync(artifact, restoredFile, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(restoredFile, 0o600);

  const childSource = `
    import fs from 'node:fs';
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const { openGatewayStore } = await import(input.moduleUrl);
    const store = openGatewayStore(input.restoreDirectory);
    const result = {
      publicUrl: store.config().publicUrl,
      authenticated: store.credentials.authenticateNode(input.token),
      enrolledAudit: store.audit().some((event) => event.action === 'gateway.instance.enroll'),
    };
    store.close();
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '--eval', childSource],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: JSON.stringify({
        moduleUrl: new URL('../src/index.ts', import.meta.url).href,
        restoreDirectory,
        token: node.token,
      }),
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    publicUrl: 'https://gateway.example.com',
    authenticated: { instanceId, credentialId: node.id },
    enrolledAudit: true,
  });
});

test('backup refuses insecure parents and verification rejects foreign DBs', async (t) => {
  const sourceDirectory = fixture('elpis-gateway-backup-source-');
  const insecureDirectory = fixture('elpis-gateway-backup-insecure-');
  const foreignDirectory = fixture('elpis-gateway-backup-foreign-');
  t.after(() => {
    for (const directory of [
      sourceDirectory,
      insecureDirectory,
      foreignDirectory,
    ])
      fs.rmSync(directory, { recursive: true, force: true });
  });
  const store = openGatewayStore(sourceDirectory);
  fs.chmodSync(insecureDirectory, 0o755);
  await assert.rejects(
    () => store.backup(path.join(insecureDirectory, 'backup.db')),
    /must not be accessible/,
  );
  assert.equal(fs.readdirSync(insecureDirectory).length, 0);

  const foreign = path.join(foreignDirectory, 'foreign.db');
  fs.writeFileSync(foreign, 'not a gateway database', { mode: 0o600 });
  assert.throws(() => verifyGatewayBackup(foreign));
  store.close();
});
