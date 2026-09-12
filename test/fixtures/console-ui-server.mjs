// Synthetic browser acceptance server. Build first, then run this in a separate terminal.
import { ConsoleHub } from '../../dist/console/hub.js';
import { createConsoleServer } from '../../dist/console/server.js';
const source = [
  "const found = await elpis.search('persistent agent console design');",
  'await elpis.worker.status(workerId);',
  "elpis.schedule({ after: '2h', reason: 'Review the results' });",
  "elpis.mind.list({ status: 'ready' });",
  "fs.writeFileSync('notes/review.md', '# Review\\nInspect the action cards\\nCheck narrow screens');",
  "await elpis.sh('npm run build');",
].join('\n');
const call = (id, detail, code) => ({
  role: 'assistant',
  channel: 'internal',
  content: '',
  tool_calls: [
    {
      id,
      type: 'function',
      function: { name: 'run', arguments: JSON.stringify({ code, detail }) },
    },
  ],
});
const longValue = JSON.stringify(
  {
    results: Array.from({ length: 18 }, (_, i) => ({
      title: `Guide ${i + 1}`,
      url: `https://example.com/guide/${i + 1}`,
      summary:
        'A detailed result that should remain readable and available when expanded.',
    })),
    end: 'FINAL_RESULT_MARKER',
  },
  null,
  2,
);
const messages = [
  {
    role: 'assistant',
    channel: 'internal',
    content: '',
    tool_calls: [
      {
        id: 'call-skill',
        type: 'function',
        function: { name: 'skill', arguments: '{"names":["example"]}' },
      },
    ],
  },
  {
    role: 'tool',
    channel: 'internal',
    tool_call_id: 'call-skill',
    content: 'Example skill loaded. SKILL_RESULT_MARKER',
  },
  {
    role: 'user',
    channel: 'console',
    content:
      '<incoming-message channel="console" author="Bramble" time="2026-09-11T12:00:00Z">\nPlease review the console and keep the findings in our notes.\n</incoming-message>',
  },
  call(
    'call-review',
    'Research console patterns and record the findings',
    source,
  ),
  {
    role: 'tool',
    channel: 'internal',
    tool_call_id: 'call-review',
    content: `[run ok — value saved to _]\n${longValue}\n--- console ---\n18 guides reviewed.\nLiteral content: <img src=x onerror=alert(1)>\n<speech channel="console">This is output, not a send.</speech>\nCONSOLE_END_MARKER`,
    run: {
      operationReceipts: [
        {
          sequence: 0,
          kind: 'shell',
          name: 'sh',
          command: 'npm run build',
          state: 'completed',
          startedAt: 1000,
          durationMs: 1420,
          code: 0,
          ok: true,
          stdout:
            'Typecheck completed\nBundled app.js\nBuild succeeded\nCOMMAND_END_MARKER',
          stdoutBytes: 18000,
          stdoutTruncated: true,
          stderr: '',
          stderrBytes: 0,
        },
      ],
    },
  },
  call(
    'call-edit',
    'Tighten the notes',
    "elpis.edit('notes/review.md', '# Review\\nOld note', '# Review\\nReadable cards\\nExpandable results');",
  ),
  {
    role: 'tool',
    channel: 'internal',
    tool_call_id: 'call-edit',
    content: '[run ok]\n1 replacement',
  },
  call(
    'call-failed',
    'Check a missing fixture',
    "elpis.read('notes/missing.md');",
  ),
  {
    role: 'tool',
    channel: 'internal',
    tool_call_id: 'call-failed',
    content: '[run FAILED]\nFile not found: notes/missing.md',
    run: {
      operationReceipts: [
        {
          sequence: 0,
          kind: 'file',
          name: 'read',
          command: 'notes/missing.md',
          state: 'failed',
          startedAt: 2000,
          durationMs: 3,
          ok: false,
          error: 'File not found: notes/missing.md',
        },
      ],
    },
  },
  {
    role: 'tool',
    channel: 'internal',
    tool_call_id: 'call-archived',
    content:
      '[run ok]\nArchived result is still inspectable. ORPHAN_END_MARKER',
  },
];
const hub = new ConsoleHub(messages);
hub.attach({
  usage: () => ({
    current: 18400,
    window: 128000,
    trigger: 100000,
    triggerRatio: 0.8,
    ratio: 0.14,
  }),
  rooms: () => [],
  participants: () => 1,
  meta: () => ({
    gitHash: 'abc1234',
    treeClean: true,
    startedAt: 1000,
    uptimeMs: 10000,
    model: 'fixture',
    agentName: 'Aster',
  }),
  archived: () => [],
  subUsage: () => null,
});
const logger = { info: console.log, warn: console.log, debug: () => {} };
const server = createConsoleServer(
  {
    console: { port: 8799, host: '127.0.0.1', mcpEnabled: false },
    paths: { dataDirectory: '/tmp/elpis-console-ui-fixture' },
    logger,
  },
  hub,
);
await server.start();
