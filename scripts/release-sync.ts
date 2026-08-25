import { runReleaseSyncCli } from '../src/release-sync.js';

try {
  await runReleaseSyncCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'release sync failed'}\n`,
  );
  process.exitCode = 1;
}
