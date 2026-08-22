import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import type { WorkerWorkspaceSource } from "../src/worker/client.js";
import {
  checkoutWorkerSource,
  createWorkerPatch,
} from "../src/worker/worktree.js";

function sourceFixture(options: { symlink?: boolean } = {}): {
  root: string;
  source: WorkerWorkspaceSource;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-worktree-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\ndist/\n");
  fs.writeFileSync(
    path.join(repo, "src", "value.ts"),
    "export const value = 1;\n",
  );
  fs.writeFileSync(path.join(repo, "src", "delete.ts"), "delete me\n");
  if (options.symlink)
    fs.symlinkSync("/etc/passwd", path.join(repo, "unsafe-link"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "fixture"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], {
    cwd: repo,
  });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: repo });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const archive = path.join(root, "source.tar.gz");
  execFileSync(
    "git",
    ["archive", "--format=tar.gz", `--output=${archive}`, "HEAD"],
    {
      cwd: repo,
    },
  );
  const data = fs.readFileSync(archive);
  return {
    root,
    source: {
      revision,
      sha256: createHash("sha256").update(data).digest("hex"),
      sizeBytes: data.length,
      data,
    },
  };
}

test("worker checkout and patch export are deterministic, binary-capable, and apply cleanly", async () => {
  const f = sourceFixture();
  const workspace = path.join(f.root, "workspace");
  const scratch = path.join(f.root, "scratch");
  fs.mkdirSync(scratch);
  try {
    await checkoutWorkerSource(f.source, workspace, scratch);
    assert.equal(
      fs.readFileSync(path.join(workspace, "src", "value.ts"), "utf8"),
      "export const value = 1;\n",
    );
    fs.writeFileSync(
      path.join(workspace, "src", "value.ts"),
      "export const value = 2;\n",
    );
    fs.rmSync(path.join(workspace, "src", "delete.ts"));
    fs.writeFileSync(path.join(workspace, "src", "new.ts"), "new file\n");
    fs.writeFileSync(
      path.join(workspace, "src", "binary.bin"),
      Buffer.from([0, 1, 2, 255]),
    );
    fs.mkdirSync(path.join(workspace, "node_modules"));
    fs.writeFileSync(
      path.join(workspace, "node_modules", "ignored.js"),
      "ignored\n",
    );

    const first = await createWorkerPatch(f.source, workspace, scratch);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await createWorkerPatch(f.source, workspace, scratch);
    assert.deepEqual(second, first);
    assert.equal(first.readUInt32LE(4), 0, "gzip mtime is reproducibly zero");
    const patch = gunzipSync(first);
    const text = patch.toString("utf8");
    assert.match(text, /a\/src\/value\.ts/);
    assert.match(text, /a\/src\/delete\.ts/);
    assert.match(text, /b\/src\/new\.ts/);
    assert.match(text, /GIT binary patch/);
    assert.doesNotMatch(text, /node_modules|ignored\.js/);

    const applied = path.join(f.root, "applied");
    await checkoutWorkerSource(f.source, applied, scratch);
    const patchFile = path.join(f.root, "workspace.patch");
    fs.writeFileSync(patchFile, patch);
    execFileSync("git", ["apply", "--binary", patchFile], { cwd: applied });
    assert.equal(
      fs.readFileSync(path.join(applied, "src", "value.ts"), "utf8"),
      "export const value = 2;\n",
    );
    assert.equal(fs.existsSync(path.join(applied, "src", "delete.ts")), false);
    assert.equal(
      fs.readFileSync(path.join(applied, "src", "new.ts"), "utf8"),
      "new file\n",
    );
    assert.deepEqual(
      fs.readFileSync(path.join(applied, "src", "binary.bin")),
      Buffer.from([0, 1, 2, 255]),
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("worker checkout rejects nonempty destinations and source symlinks", async () => {
  const normal = sourceFixture();
  const unsafe = sourceFixture({ symlink: true });
  try {
    const occupied = path.join(normal.root, "occupied");
    fs.mkdirSync(occupied);
    fs.writeFileSync(path.join(occupied, "keep"), "do not overwrite");
    await assert.rejects(
      () => checkoutWorkerSource(normal.source, occupied, normal.root),
      /must be empty/,
    );
    await assert.rejects(
      () =>
        checkoutWorkerSource(
          { ...normal.source, sha256: "0".repeat(64) },
          path.join(normal.root, "tampered"),
          normal.root,
        ),
      /failed verification/,
    );
    await assert.rejects(
      () =>
        checkoutWorkerSource(
          unsafe.source,
          path.join(unsafe.root, "workspace"),
          unsafe.root,
        ),
      /non-file entry/,
    );
  } finally {
    fs.rmSync(normal.root, { recursive: true, force: true });
    fs.rmSync(unsafe.root, { recursive: true, force: true });
  }
});
