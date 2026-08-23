import { randomInt, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../lib/log.js';
import { resolveDataLayout } from '../store/data-layout.js';

export interface AliasWordlists {
  adverbs: readonly string[];
  adjectives: readonly string[];
  nouns: readonly string[];
}

export type AliasRandomIndex = (maxExclusive: number) => number;

function bundled(source: string, kind: string): string[] {
  const words = source.trim().split(/\s+/);
  if (
    words.length < 100 ||
    new Set(words).size !== words.length ||
    words.some((word) => !/^[a-z][a-z0-9]*$/.test(word))
  ) {
    throw new Error(`invalid bundled sandbox ${kind} wordlist`);
  }
  return words;
}

export const BUNDLED_ALIAS_WORDLISTS: Readonly<AliasWordlists> = Object.freeze({
  adverbs: Object.freeze(
    bundled(
      `
    brightly briskly calmly carefully cheerfully cleverly closely boldly curiously daintily dearly deeply eagerly evenly faintly fiercely fondly freely gently gladly gracefully happily honestly hungrily jauntily kindly lightly loudly merrily neatly nimbly openly patiently plainly playfully politely promptly proudly quickly quietly rarely readily safely sharply shyly silently slowly softly solemnly swiftly tenderly warmly wildly wisely zestfully awkwardly busily dreamily fuzzily grandly lazily loosely madly oddly roughly sleepily smoothly snugly sweetly weirdly wryly suspiciously dramatically extremely mildly mostly secretly sincerely suddenly truly vaguely vividly warily yearningly chirpily cozily cryptically delightfully moonily noodly bravely breezily craftily daringly easily faithfully gingerly heartily innocently joyfully keenly lovingly mysteriously naturally optimistically peacefully quirkily rapidly serenely tidily urgently valiantly wistfully youthfully
  `,
      'adverbs',
    ),
  ),
  adjectives: Object.freeze(
    bundled(
      `
    amber ancient aqua bashful blue bold bouncy bright brisk bubbly calm careful cheerful clever cloudy cobalt cozy curious dainty dapper deep dreamy eager electric even faint fierce fluffy fond free fuzzy gentle glad golden graceful green happy honest hungry indigo jaunty kind light lilac loud lucky merry minty mossy neat nimble orange patient pink plain playful polite proud purple quick quiet red round safe saucy sharp shy silent silver sleepy slow small smooth snug soft solemn sparkly swift tender tiny violet warm weird wild wise yellow zesty awkward busy cryptic dramatic dusty earnest frosty grand lazy loose lunar odd pearly plush rainy rough secret sincere sudden sweet vivid wary wooden woolly yearning chirpy cosmic delightful glassy hazy inky jolly keen lucid milky noodly opal peachy quirky rosy starry tidy uncanny velvety wobbly
  `,
      'adjectives',
    ),
  ),
  nouns: Object.freeze(
    bundled(
      `
    alpaca axolotl badger bat bear bee beetle blahaj bun bunny capybara cat chinchilla crab crow deer dog dolphin dove dragon duck ferret finch fox frog gecko goat goose hare hedgehog heron jellyfish koi lamb lemur lizard loon lynx manta marmot mole moth mouse narwhal newt octopus otter owl panda pangolin pigeon possum puffin rabbit raccoon raven robin salamander seal shark sheep shrimp slug snail sparrow squid stoat swan tapir tern toad turtle whale wolf wombat yak beet bot byte cache comet cookie daemon glitch goblin gremlin lantern marble moon noodle orbit pebble pixel quasar ribbon rivet robot satellite shell signal spark tensor thimble thread token tulip velvet widget wisp zephyr star cloud acorn mushroom teacup teapot bookmark blanket cushion fern moss puddle
  `,
      'nouns',
    ),
  ),
});

const FILES: Record<keyof AliasWordlists, string> = {
  adverbs: 'adverbs.txt',
  adjectives: 'adjectives.txt',
  nouns: 'nouns.txt',
};

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function seedMissing(file: string, words: readonly string[]): void {
  if (fs.existsSync(file)) return;
  const directory = path.dirname(file);
  const temp = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const content = `# One lowercase word per line. Existing files are never overwritten.\n${words.join('\n')}\n`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temp, file);
    fs.chmodSync(file, 0o600);
    fsyncDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    fs.unlinkSync(temp);
  }
}

function parseAuthored(file: string): string[] {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const words = lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (words.length === 0) throw new Error('contains no words');
  const invalid = words.find((word) => !/^[a-z][a-z0-9]*$/.test(word));
  if (invalid) throw new Error(`invalid word ${JSON.stringify(invalid)}`);
  if (new Set(words).size !== words.length)
    throw new Error('contains duplicate words');
  return words;
}

export function loadAliasWordlists(
  dataDirectory: string,
  logger: Pick<Logger, 'warn'>,
): AliasWordlists {
  const directory = resolveDataLayout(dataDirectory).wordlists;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const result = {} as AliasWordlists;
  for (const kind of Object.keys(FILES) as (keyof AliasWordlists)[]) {
    const file = path.join(directory, FILES[kind]);
    seedMissing(file, BUNDLED_ALIAS_WORDLISTS[kind]);
    try {
      result[kind] = parseAuthored(file);
    } catch (error) {
      logger.warn(
        `sandbox wordlist: preserving invalid ${file}; using bundled ${kind}: ${error instanceof Error ? error.message : String(error)}`,
      );
      result[kind] = [...BUNDLED_ALIAS_WORDLISTS[kind]];
    }
  }
  return result;
}

export function* aliasCandidates(
  wordlists: AliasWordlists,
  chooseStart: AliasRandomIndex = randomInt,
): Generator<string> {
  const { adverbs, adjectives, nouns } = wordlists;
  if (!adverbs.length || !adjectives.length || !nouns.length)
    throw new Error('sandbox aliases: every wordlist must be non-empty');
  const total = adverbs.length * adjectives.length * nouns.length;
  if (!Number.isSafeInteger(total))
    throw new Error(
      'sandbox aliases: wordlist product exceeds safe allocation space',
    );
  const start = chooseStart(total);
  if (!Number.isInteger(start) || start < 0 || start >= total)
    throw new Error('sandbox aliases: random index is out of range');
  for (let offset = 0; offset < total; offset++) {
    let index = (start + offset) % total;
    const noun = nouns[index % nouns.length];
    index = Math.floor(index / nouns.length);
    const adjective = adjectives[index % adjectives.length];
    const adverb = adverbs[Math.floor(index / adjectives.length)];
    yield `${adverb}-${adjective}-${noun}`;
  }
}
