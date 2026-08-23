import { loadConfigFile } from '../src/config.js';
import {
  OPENAI_CODEX_CREDENTIAL_KEY,
  refreshOpenAICodexToken,
} from '../src/llm/oauth/openai-codex.js';
import { OAuthStore } from '../src/llm/oauth/store.js';
import { replayPolicyDenial } from '../src/llm/policy-denial-replay.js';
import { openDatabase } from '../src/store/db.js';
import { migrateDataLayout } from '../src/store/data-layout.js';

function usage(): never {
  console.error(
    'usage: npm run replay-policy-denial -- <bundle-directory|manifest.json> --yes',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = args.find((arg) => !arg.startsWith('--'));
  if (!target || !args.includes('--yes')) {
    console.error(
      'refusing to replay a private provider request without an artifact path and --yes',
    );
    usage();
  }
  const config = loadConfigFile();
  const db = openDatabase(
    migrateDataLayout(config.paths.dataDirectory).layout.root,
  );
  try {
    const store = new OAuthStore(
      db,
      OPENAI_CODEX_CREDENTIAL_KEY,
      refreshOpenAICodexToken,
    );
    console.log(
      JSON.stringify(await replayPolicyDenial(config, store, target), null, 2),
    );
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
