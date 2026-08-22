import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const DATA_LAYOUT_VERSION = 1;

export const ELPIS_DATA_GITIGNORE = `# elpis-data/.gitignore — owned by Elpis; local edits are overwritten\n/*\n!/.gitignore\n!/config/\n`;

export interface DataLayout {
  dataDirectory: string;
  root: string;
  config: string;
  extensions: string;
  wordlists: string;
  database: string;
  sessions: string;
  bg: string;
  motor: string;
  browser: string;
  computer: string;
  sshSockets: string;
  memoryBackups: string;
  changelogSeen: string;
  resumeMarker: string;
  legacyChannels: string;
  policyDenials: string;
  playwrightCli: string;
  gitignore: string;
  migrationJournal: string;
}

export function resolveDataLayout(dataDirectory: string): DataLayout {
  const root = path.join(dataDirectory, "elpis-data");
  const config = path.join(root, "config");
  return {
    dataDirectory,
    root,
    config,
    extensions: path.join(config, "extensions"),
    wordlists: path.join(config, "wordlists"),
    database: path.join(root, "elpis.db"),
    sessions: path.join(root, "sessions"),
    bg: path.join(root, "bg"),
    motor: path.join(root, "motor"),
    browser: path.join(root, "browser"),
    computer: path.join(root, "computer"),
    sshSockets: path.join(root, "ssh-sockets"),
    memoryBackups: path.join(root, "memory-backups"),
    changelogSeen: path.join(root, "changelog-seen.json"),
    resumeMarker: path.join(root, "resume-after-restart.json"),
    legacyChannels: path.join(root, "channels.json"),
    policyDenials: path.join(root, "policy-denials"),
    playwrightCli: path.join(root, "playwright-cli"),
    gitignore: path.join(root, ".gitignore"),
    migrationJournal: path.join(root, "layout-migration.json"),
  };
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function atomicWrite(file: string, content: string, mode: number): void {
  const directory = path.dirname(file);
  const tmp = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  fsyncDirectory(directory);
}

export function ensureElpisDataScaffold(dataDirectory: string): {
  layout: DataLayout;
  gitignoreRepaired: boolean;
} {
  const layout = resolveDataLayout(dataDirectory);
  fs.mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  fs.chmodSync(layout.root, 0o700);
  fs.mkdirSync(layout.config, { recursive: true, mode: 0o700 });
  fs.chmodSync(layout.config, 0o700);

  let gitignoreRepaired = true;
  try {
    gitignoreRepaired =
      fs.readFileSync(layout.gitignore, "utf8") !== ELPIS_DATA_GITIGNORE;
  } catch {
    /* missing/unreadable is repaired below */
  }
  if (gitignoreRepaired)
    atomicWrite(layout.gitignore, ELPIS_DATA_GITIGNORE, 0o644);
  else fs.chmodSync(layout.gitignore, 0o644);
  return { layout, gitignoreRepaired };
}

interface LegacyMove {
  key: string;
  source: string;
  target: string;
}

interface MigrationJournal {
  version: number;
  status: "running" | "complete";
  startedAt: string;
  completedAt?: string;
  completed: string[];
}

export interface DataLayoutMigrationResult {
  layout: DataLayout;
  moved: string[];
  gitignoreRepaired: boolean;
}

function legacyMoves(layout: DataLayout): LegacyMove[] {
  const root = layout.dataDirectory;
  return [
    {
      key: "database",
      source: path.join(root, "agent.db"),
      target: layout.database,
    },
    {
      key: "sessions",
      source: path.join(root, "sessions"),
      target: layout.sessions,
    },
    {
      key: "extensions",
      source: path.join(root, "extensions"),
      target: layout.extensions,
    },
    { key: "bg", source: path.join(root, "bg"), target: layout.bg },
    { key: "motor", source: path.join(root, "motor"), target: layout.motor },
    {
      key: "browser",
      source: path.join(root, "browser"),
      target: layout.browser,
    },
    {
      key: "computer",
      source: path.join(root, "computer"),
      target: layout.computer,
    },
    {
      key: "ssh-sockets",
      source: path.join(root, ".ssh-sockets"),
      target: layout.sshSockets,
    },
    {
      key: "memory-backups",
      source: path.join(root, ".memory-backups"),
      target: layout.memoryBackups,
    },
    {
      key: "changelog-seen",
      source: path.join(root, ".changelog-seen.json"),
      target: layout.changelogSeen,
    },
    {
      key: "resume-marker",
      source: path.join(root, ".resume-after-restart.json"),
      target: layout.resumeMarker,
    },
    {
      key: "legacy-channels",
      source: path.join(root, "channels.json"),
      target: layout.legacyChannels,
    },
    {
      key: "policy-denials",
      source: path.join(root, "private", "policy-denials"),
      target: layout.policyDenials,
    },
    {
      key: "playwright-cli",
      source: path.join(root, ".playwright-cli"),
      target: layout.playwrightCli,
    },
  ];
}

function liveProcessCommands(): string[] {
  let names: string[];
  try {
    names = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const commands: string[] = [];
  for (const name of names) {
    if (Number(name) === process.pid) continue;
    try {
      const command = fs
        .readFileSync(path.join("/proc", name, "cmdline"))
        .toString("utf8")
        .replace(/\0/g, " ");
      if (command) commands.push(command);
    } catch {
      /* process exited or is unreadable */
    }
  }
  return commands;
}

function preflight(moves: LegacyMove[], commands: string[]): void {
  for (const move of moves) {
    if (fs.existsSync(move.source) && fs.existsSync(move.target)) {
      throw new Error(
        `data layout conflict for ${move.key}: both legacy and elpis-data paths exist (${move.source}, ${move.target})`,
      );
    }
  }
  const database = moves[0];
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${database.source}${suffix}`;
    if (fs.existsSync(sidecar) && !fs.existsSync(database.source)) {
      throw new Error(
        `orphaned legacy SQLite sidecar without agent.db: ${sidecar}`,
      );
    }
  }
  const coupled = moves.filter(
    (move) => move.key === "browser" || move.key === "playwright-cli",
  );
  const live = coupled.filter(
    (move) =>
      fs.existsSync(move.source) &&
      commands.some((command) => command.includes(move.source)),
  );
  if (live.length > 0) {
    throw new Error(
      `data layout migration blocked by live processes using legacy ${live.map((move) => move.key).join(", ")} state; stop them and restart`,
    );
  }
}

function readJournal(file: string): MigrationJournal | null {
  if (!fs.existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `data layout migration journal is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const value = parsed as Partial<MigrationJournal>;
  if (
    value.version !== DATA_LAYOUT_VERSION ||
    (value.status !== "running" && value.status !== "complete") ||
    typeof value.startedAt !== "string" ||
    !Array.isArray(value.completed) ||
    value.completed.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("data layout migration journal is invalid");
  }
  return {
    version: value.version,
    status: value.status,
    startedAt: value.startedAt,
    ...(typeof value.completedAt === "string"
      ? { completedAt: value.completedAt }
      : {}),
    completed: [...new Set(value.completed)],
  };
}

function writeJournal(file: string, journal: MigrationJournal): void {
  atomicWrite(file, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

function prepareLegacyDatabase(file: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    const quick = db.prepare("PRAGMA quick_check").get() as {
      quick_check?: unknown;
    };
    if (quick.quick_check !== "ok")
      throw new Error(
        `legacy agent.db quick_check failed: ${String(quick.quick_check)}`,
      );
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy?: unknown;
    };
    if (checkpoint.busy !== 0)
      throw new Error(
        "legacy agent.db WAL is busy; another process may still be using it",
      );
    const mode = db.prepare("PRAGMA journal_mode=DELETE").get() as {
      journal_mode?: unknown;
    };
    if (String(mode.journal_mode).toLowerCase() !== "delete")
      throw new Error(
        `could not collapse legacy agent.db WAL (journal_mode=${String(mode.journal_mode)})`,
      );
  } finally {
    db.close();
  }
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(`${file}${suffix}`))
      throw new Error(
        `legacy SQLite sidecar remained after clean checkpoint: ${file}${suffix}`,
      );
  }
}

function movePath(move: LegacyMove): boolean {
  if (!fs.existsSync(move.source)) return false;
  fs.mkdirSync(path.dirname(move.target), { recursive: true, mode: 0o700 });
  fs.renameSync(move.source, move.target);
  fsyncDirectory(path.dirname(move.source));
  fsyncDirectory(path.dirname(move.target));
  return true;
}

function replacePrefix(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string")
    return value === from || value.startsWith(`${from}${path.sep}`)
      ? `${to}${value.slice(from.length)}`
      : value;
  if (Array.isArray(value))
    return value.map((entry) => replacePrefix(entry, from, to));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        replacePrefix(entry, from, to),
      ]),
    );
  }
  return value;
}

function rewriteJsonFile(file: string, from: string, to: string): void {
  if (!fs.existsSync(file)) return;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot rewrite migrated JSON ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const rewritten = replacePrefix(value, from, to);
  atomicWrite(file, `${JSON.stringify(rewritten, null, 2)}\n`, 0o600);
}

function rewriteJsonLines(directory: string, from: string, to: string): void {
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(directory, name);
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n");
    const rewritten = lines
      .map((line, index) => {
        if (!line) return "";
      let value: unknown;
        try {
          value = JSON.parse(line);
        } catch (error) {
          throw new Error(
            `cannot rewrite migrated JSONL ${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      return JSON.stringify(replacePrefix(value, from, to));
      })
      .join("\n");
    if (rewritten !== raw) atomicWrite(file, rewritten, 0o600);
  }
}

export function migrateDataLayout(
  dataDirectory: string,
  opts: {
    now?: () => Date;
    log?: (message: string) => void;
    processCommands?: () => string[];
  } = {},
): DataLayoutMigrationResult {
  const layout = resolveDataLayout(dataDirectory);
  const moves = legacyMoves(layout);
  preflight(moves, (opts.processCommands ?? liveProcessCommands)());
  const hasLegacyState = moves.some((move) => fs.existsSync(move.source));
  const { gitignoreRepaired } = ensureElpisDataScaffold(dataDirectory);
  const now = opts.now ?? (() => new Date());
  const priorJournal = readJournal(layout.migrationJournal);
  if (!hasLegacyState && priorJournal === null)
    return { layout, moved: [], gitignoreRepaired };
  if (priorJournal?.status === "complete" && !hasLegacyState) {
    return { layout, moved: [], gitignoreRepaired };
  }
  const journal = priorJournal ?? {
    version: DATA_LAYOUT_VERSION,
    status: "running" as const,
    startedAt: now().toISOString(),
    completed: [],
  };
  journal.status = "running";
  delete journal.completedAt;
  writeJournal(layout.migrationJournal, journal);

  const moved: string[] = [];
  for (const move of moves) {
    if (move.key === "database" && fs.existsSync(move.source))
      prepareLegacyDatabase(move.source);
    if (movePath(move)) {
      moved.push(move.key);
      opts.log?.(
        `migrated ${path.relative(dataDirectory, move.source)} → ${path.relative(dataDirectory, move.target)}`,
      );
    }
    if (!journal.completed.includes(move.key)) journal.completed.push(move.key);
    writeJournal(layout.migrationJournal, journal);
  }

  rewriteJsonFile(
    path.join(layout.bg, "registry.json"),
    path.join(dataDirectory, "bg"),
    layout.bg,
  );
  rewriteJsonLines(
    path.join(layout.motor, "traces"),
    path.join(dataDirectory, "motor"),
    layout.motor,
  );
  journal.completed = [
    ...new Set([
      ...journal.completed,
      "rewrite-bg-paths",
      "rewrite-motor-paths",
    ]),
  ];
  journal.status = "complete";
  journal.completedAt = now().toISOString();
  writeJournal(layout.migrationJournal, journal);
  return { layout, moved, gitignoreRepaired };
}
