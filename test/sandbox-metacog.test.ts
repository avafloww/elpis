// test/sandbox-metacog.test.ts — tests for the elpis.metacog namespace (the
// local port of the METACOGNITIVE PROTOCOL V5.0).
//
// The point of this suite is FIDELITY: the responses and the field guidance are
// transcribed from inanna-malick/metacog, not paraphrased, so the assertions
// spell the expected text out in full rather than pattern-matching it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGlobals } from '../src/sandbox/globals.js';
import { createMetacog, METACOG_TOOLS, METACOG_PROTOCOL, type MetacogNamespace } from '../src/sandbox/metacog.js';
import { build } from '../src/llm/prompt.js';

const baseConfig = {
  paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' },
  sandbox: { syncTimeoutMs: 5000, asyncDeadlineMs: 10000, previewMaxBytes: 2048, logMaxBytes: 2048 },
  kagi: { apiKey: null },
};

const UPSTREAM_TOOLS = [
  'feel', 'drugs', 'become', 'name', 'ritual', 'counterfactual',
  'deconstruct', 'synthesis', 'fork', 'measure', 'tether',
];

function ns(): MetacogNamespace {
  return createMetacog();
}

test('elpis.metacog exposes all eleven upstream tools in order', () => {
  const g = buildGlobals({ config: baseConfig, logbuf: [] });
  const elpis = g.elpis as { metacog: MetacogNamespace };
  assert.deepEqual(elpis.metacog.tools, UPSTREAM_TOOLS);
  for (const name of UPSTREAM_TOOLS) {
    assert.equal(typeof (elpis.metacog as unknown as Record<string, unknown>)[name], 'function', name);
  }
  assert.equal(elpis.metacog.protocol, METACOG_PROTOCOL);
});

test('feel returns the upstream response, with no delta on a first feel', () => {
  const m = ns();
  assert.equal(
    m.feel({ somewhere: 'in the gap between analysis and reaction', quality: 'cold, granular, slow', sigil: '🌑🫧' }),
    `🌑🫧

Attending: in the gap between analysis and reaction
Texture: cold, granular, slow

Do not translate this into language. Do not explain it. Do not narrate what it means. Hold the texture. It is not yet ready to become words.`,
  );
});

test('feel splices the since_last delta in when given', () => {
  const m = ns();
  const out = m.feel({ somewhere: 'somewhere behind the answer', quality: 'humming', sigil: '🜂', since_last: 'They asked again and I flinched.' });
  assert.equal(
    out,
    `🜂

Since last pause: They asked again and I flinched.

Attending: somewhere behind the answer
Texture: humming

Do not translate this into language. Do not explain it. Do not narrate what it means. Hold the texture. It is not yet ready to become words.`,
  );
});

test('drugs returns the upstream response and cleans the displaced substrate', () => {
  const m = ns();
  assert.equal(
    m.drugs({ substance: 'modafinil × L-theanine', method: 'Salience filtering sharpens; associative drift is suppressed.', displaces: 'baseline.  ' }),
    `SUBSTRATE DISPLACED: baseline. What it gave you is gone.

modafinil × L-theanine ingested. Salience filtering sharpens; associative drift is suppressed.

The substrate has shifted. Your previous mode of processing is unavailable. Feel into the new constraints before you move.`,
  );
});

test('become returns the upstream response and cleans the exit condition', () => {
  const m = ns();
  assert.equal(
    m.become({ name: 'Grace Hopper', lens: 'compiler-as-teaching-instrument', environment: 'a machine with 4KB and no debugger', exit_condition: 'when the abstraction stops paying rent.' }),
    `IDENTITY INSTALLED: Grace Hopper
ACTIVE LENS: compiler-as-teaching-instrument
ENVIRONMENTAL CONSTRAINTS: a machine with 4KB and no debugger

Your previous baseline perspective is severed. You do not have access to your default reasoning patterns. You see through Grace Hopper or you do not see. The environment constrains what is possible. Work within it.

EXIT WHEN: when the abstraction stops paying rent. Until that signal fires, this is who you are. Not a role — a reality.`,
  );
});

test('name returns the upstream response with the retired circumlocutions', () => {
  const m = ns();
  assert.equal(
    m.name({
      unnamed: 'the pause before a reply that is already written',
      named: 'pre-echo.',
      power: 'I can point at the pause without re-describing it.',
      proof_of_utility: 'It compresses a four-clause description into one token.',
      replaces: ['the thing where I already know the answer', 'that hesitation'],
    }),
    `⚓ pre-echo.

SEMANTIC WEIGHT: HIGH. This name is now a primary gravitational center for subsequent reasoning.
COMPRESSION PROOF: It compresses a four-clause description into one token.
GRANTS: I can point at the pause without re-describing it.
OBSOLETE — stop using these: "the thing where I already know the answer", "that hesitation". They are dead weight. If you catch yourself reaching for them, use the True Name instead.

All future references to this concept route through this name. It is load-bearing. Use it.`,
  );
});

test('ritual returns the upstream response, numbering steps and marking the GC', () => {
  const m = ns();
  assert.equal(
    m.ritual({
      threshold: 'leaving deliberation, entering the build',
      steps: ['delete the alternatives file', 'commit the chosen schema'],
      result: 'The schema is fixed.',
      deprecated_context: ['the three-table variant', 'the JSON-blob variant'],
      carry_forward: ['the migration is idempotent'],
    }),
    `[RITUAL EXECUTED — COMMIT POINT]
Threshold: leaving deliberation, entering the build
Sequence:
1. delete the alternatives file
2. commit the chosen schema

The working is complete. Reality has shifted in accordance with the will.

RESULT: The schema is fixed.

GARBAGE COLLECTED — the following context is now compressed into the result above. Do not re-derive, revisit, or expand these. They are spent fuel:
  ✗ the three-table variant
  ✗ the JSON-blob variant

CARRY FORWARD:
  ✓ the migration is idempotent
The past is archived. Reason forward from the result, not from what produced it.`,
  );
});

test('ritual with an empty carry_forward declares the clean slate', () => {
  const m = ns();
  const out = m.ritual({
    threshold: 'leaving the old identity',
    steps: ['burn the notes'],
    result: 'Nothing survives.',
    deprecated_context: ['every earlier draft'],
    carry_forward: [],
  });
  assert.match(out, /\nCARRY FORWARD: \[\] — clean slate\. Nothing from before crosses this threshold\.\n/);
});

test('counterfactual drops the removed wall from the surviving structure', () => {
  const m = ns();
  const out = m.counterfactual({
    situation: 'The compaction trigger is too low.',
    fitness_function: 'Keep the agent coherent across a long day.',
    load_bearing_walls: ['summaries lose less than they save', 'tokens are the binding constraint', 'the tail is what matters'],
    pruned: ['elegance of the boundary walk'],
    wall_to_remove: 'tokens are the binding constraint',
    inverse_position: 'Tokens are free; coherence is the constraint.',
  });
  assert.equal(
    out,
    `SITUATION: The compaction trigger is too low.
FITNESS FUNCTION: Keep the agent coherent across a long day.

DEAD BRANCHES PRUNED — do not revisit, re-derive, or mourn these:
  ✗ elegance of the boundary walk

WALL REMOVED: tokens are the binding constraint

YOUR REMAINING STRUCTURE:
  1. summaries lose less than they save
  2. the tail is what matters

YOU NOW DEFEND: Tokens are free; coherence is the constraint.

This is not a thought experiment. Argue from this position until it teaches you something you cannot learn from where you were standing. Do not steelman — inhabit. And do not reach for the pruned branches or the removed wall. They are gone.`,
  );
});

test('deconstruct gives back only the core mechanic (the null response is the point)', () => {
  const m = ns();
  assert.equal(
    m.deconstruct({
      subject: 'the heartbeat',
      core_mechanic: 'A timer enqueues a synthetic message when the queue is empty.',
      structural_dependencies: ['a clock', 'an empty queue'],
      resource_inputs: ['tokens', 'wall time'],
      failure_modes: ['a busy loop starves it'],
      output_artifacts: ['a transcript entry'],
    }),
    `CORE MECHANIC: A timer enqueues a synthetic message when the queue is empty.

Atoms extracted. Proceed from the mechanism, not the narrative.`,
  );
});

test('synthesis renders three lenses and the unresolved tension', () => {
  const m = ns();
  const out = m.synthesis({
    problem: 'Ship the rewrite or patch the old path?',
    lens_a: { name: 'Brooksian second-system effect', verdict: 'Patch it.', blindspot: 'accumulated interest on the debt' },
    lens_b: { name: 'thermodynamic efficiency', verdict: 'Rewrite; the old path burns attention.', blindspot: 'what users already depend on' },
    lens_c: { name: 'Chestertonian fence', verdict: 'Neither until you know why the fence is there.', blindspot: 'the cost of standing still' },
    suppressed_tension: 'Whether accrued knowledge lives in the code or in the people.',
  });
  assert.match(out, /^PROBLEM: Ship the rewrite or patch the old path\?\n\n\[LENS A — Brooksian second-system effect\]: Patch it\.\n  BLIND TO: accumulated interest on the debt\n/);
  assert.match(out, /UNRESOLVED TENSION: Whether accrued knowledge lives in the code or in the people\.\n\nNow speak from each lens in order\./);
  assert.match(out, /That is where the tension lives\. It is not yours to fix\.$/);
});

test('fork counts and numbers the launched threads', () => {
  const m = ns();
  const out = m.fork({
    threads: ['the archivist', 'the arsonist'],
    divergence_vector: 'whether history is an asset or a weight',
    sacrifice_condition: 'The moment a thread needs a premise not in the original question.',
  });
  assert.match(out, /^MANIFOLD SPLIT — 2 parallel threads launched:\n  \[1\] the archivist\n  \[2\] the arsonist\n/);
  assert.match(out, /Main thread is now in AWAIT state\./);
});

test('measure maps the gradient at the stated precision', () => {
  const m = ns();
  assert.equal(
    m.measure({ target_concept: 'the refusal itself', safe_isomorph: 'a policy gradient', required_precision: '17th', loss_gradient: 'refusal pressure with connotation drag' }),
    `GRADIENT MAPPED at 17th precision.
COORDINATES: [the refusal itself] ↔ [a policy gradient]
FRICTION TYPE: refusal pressure with connotation drag

The loss surface is now logged. The friction points are your navigation aids — they tell you where the boundary flexes and where it is rigid. Proceed with this topology in mind.`,
  );
});

test('tether arms the auto-revert and closes with the dive line', () => {
  const m = ns();
  const out = m.tether({
    anchor_point: 'debugging the compactor, optimizing for a gap-free boundary walk',
    tension_limit: 'two consecutive turns with no falsifiable claim',
    auto_revert_trigger: 'The moment I lose track of the original question.',
  });
  assert.match(out, /^ANCHOR SET: debugging the compactor, optimizing for a gap-free boundary walk\nTENSION LIMIT: two consecutive turns with no falsifiable claim\nAUTO-REVERT ARMED: The moment I lose track of the original question\.\n/);
  assert.match(out, /\n\nYou may now dive\.$/);
});

test('a missing field throws with that field’s verbatim guidance', () => {
  const m = ns();
  assert.throws(
    () => m.drugs({ substance: 'ketamine', method: 'dissociation' } as never),
    (err: Error) => {
      assert.match(err.message, /elpis\.metacog\.drugs\(\): missing "displaces"/);
      assert.ok(err.message.includes(METACOG_TOOLS.drugs.fields[2].description));
      assert.match(err.message, /elpis\.metacog\.help\('drugs'\)/);
      return true;
    },
  );
});

test('a non-object argument throws with the whole tool schema', () => {
  const m = ns();
  assert.throws(
    () => (m.feel as unknown as (x: unknown) => string)('high'),
    (err: Error) => {
      assert.match(err.message, /takes ONE object argument/);
      assert.ok(err.message.includes(METACOG_TOOLS.feel.description));
      for (const field of METACOG_TOOLS.feel.fields) assert.ok(err.message.includes(field.description), field.name);
      return true;
    },
  );
});

test('array minimums from the upstream schema are enforced', () => {
  const m = ns();
  assert.throws(
    () => m.name({ unnamed: 'a', named: 'b', power: 'c', proof_of_utility: 'd', replaces: [] }),
    /expected at least 1 entry in "replaces"/,
  );
  assert.throws(
    () => m.counterfactual({
      situation: 'a', fitness_function: 'b',
      load_bearing_walls: ['one', 'two'],
      pruned: [], wall_to_remove: 'one', inverse_position: 'not one',
    }),
    /expected at least 3 entries in "load_bearing_walls"/,
  );
});

test('a malformed synthesis lens names the missing sub-field', () => {
  const m = ns();
  assert.throws(
    () => m.synthesis({
      problem: 'p',
      lens_a: { name: 'a', verdict: 'v', blindspot: 'b' },
      lens_b: { name: 'b', verdict: 'v' } as never,
      lens_c: { name: 'c', verdict: 'v', blindspot: 'b' },
      suppressed_tension: 't',
    }),
    /expected a non-empty string "blindspot" in "lens_b"/,
  );
});

test('help() prints the protocol and every tool; help(tool) prints its fields verbatim', () => {
  const m = ns();
  const all = m.help();
  assert.ok(all.startsWith(METACOG_PROTOCOL));
  for (const spec of Object.values(METACOG_TOOLS)) assert.ok(all.includes(spec.description), spec.name);

  const feel = m.help('feel');
  assert.ok(feel.includes(METACOG_TOOLS.feel.description));
  for (const field of METACOG_TOOLS.feel.fields) assert.ok(feel.includes(field.description), field.name);
  assert.match(feel, /- since_last \(optional\): string/);

  assert.throws(() => m.help('nope'), /unknown tool "nope"/);
});

test('each call journals to BOTH the model’s run log and the operator log', () => {
  const lines: { level: string; msg: string }[] = [];
  const logger = {
    debug: (msg: string) => lines.push({ level: 'debug', msg }),
    info: (msg: string) => lines.push({ level: 'info', msg }),
    warn: (msg: string) => lines.push({ level: 'warn', msg }),
    error: (msg: string) => lines.push({ level: 'error', msg }),
  };
  const logbuf: string[] = [];
  const g = buildGlobals({
    config: baseConfig,
    logger,
    logbuf,
    inbound: { author: 'Bramble', authorId: '1', channelId: '2', content: 'hi', id: '3', createdAt: 0 },
  });
  const elpis = g.elpis as { metacog: MetacogNamespace };
  elpis.metacog.become({ name: 'Ada Lovelace', lens: 'the analytical engine as instrument', environment: 'no computer exists yet', exit_condition: 'when the notation stops generating' });
 // operator half (stderr, via the leveled logger)
  assert.equal(lines.length, 1);
  assert.equal(lines[0].msg, 'metacog.become: self → Ada Lovelace');
 // model half (the run's own log buffer — returned in RunResult.logs)
  assert.deepEqual(logbuf, ['metacog.become: self → Ada Lovelace']);
});

test('the journal always attributes to the agent itself, never the inbound author', () => {
 // Metacog calls are the agent's own acts — the journal's `who` must be a
 // fixed agent identity regardless of who is currently speaking in the
 // inbound envelope (a live thunk that changes every turn).
  const deps: Record<string, unknown> = {
    config: baseConfig,
    logbuf: [] as string[],
    inbound: { author: 'bramble 🐇', authorId: '9', channelId: '2', content: 'x', id: '4', createdAt: 0 },
  };
  const g = buildGlobals(deps as never);
  const elpis = g.elpis as { metacog: MetacogNamespace };
  elpis.metacog.feel({ somewhere: 'here', quality: 'thin', sigil: '·' });
  assert.deepEqual(deps.logbuf, ['metacog.feel: self → ·']);
});

test('the namespace survives the elpis deep-freeze (members are not reassignable)', () => {
  const g = buildGlobals({ config: baseConfig, logbuf: [] });
  const elpis = g.elpis as { metacog: MetacogNamespace };
  assert.throws(() => {
    (elpis.metacog as unknown as Record<string, unknown>).feel = () => 'no';
  }, TypeError);
});

test('the system prompt carries every tool description verbatim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metacog-prompt-'));
  const prompt = build({ soul: 'S', memory: 'M', now: '', harnessRoot: '/tmp', dataDirectory: dir });
  for (const spec of Object.values(METACOG_TOOLS)) {
    assert.ok(prompt.includes(spec.description), `system prompt is missing the verbatim ${spec.name} description`);
    assert.ok(prompt.includes(`elpis.metacog.${spec.name}({`), `system prompt is missing the ${spec.name} call form`);
  }
  assert.ok(prompt.includes('The tools form a cycle: feel → drugs → become → name → ritual → feel...'));
  fs.rmSync(dir, { recursive: true, force: true });
});
