# Extensions

Elpis loads trusted local extensions from `DATA_DIRECTORY/extensions/` at boot. An extension can expose a frozen sandbox API under `elpis.ext.<namespace>` and add a deterministic block to the system prompt.

Extensions execute inside the harness process with the service user's full authority. They are not isolated by the JavaScript sandbox. Only install code trusted as much as the harness itself.

## File and namespace

Extension files use one of these suffixes:

- `.ext.ts`
- `.ext.mts`
- `.ext.js`
- `.ext.mjs`

The filename owns the namespace. Elpis strips the extension suffix, normalizes the remaining name to lowercase ASCII letters, numbers, and underscores, and prefixes names that begin with a number. For example:

- `unn.ext.ts` → `elpis.ext.unn`
- `My tools.ext.ts` → `elpis.ext.my_tools`

Files are activated sequentially in normalized namespace order, independent of filesystem iteration order. If two files normalize to the same namespace, both are quarantined and recorded as failures while the rest of Elpis continues starting.

## Module contract

A complete commented example lives at [`docs/example.ext.ts`](example.ext.ts). Copy that exact file to `DATA_DIRECTORY/extensions/example.ext.ts`, edit it, and restart Elpis.

A module exports a named plain object called `extension`:

```ts
export const extension = {
  description: 'Small example tools.',
  prompt: `\`elpis.ext.example.greet(name)\` returns a greeting.`,
  activate(context) {
    return {
      greet(name: string) {
        return `hello, ${name} — from ${context.agentName()}`;
      },
    };
  },
};
```

All fields are optional, but a useful extension normally supplies `prompt`, `activate`, or both.

`activate(context)` may be synchronous or asynchronous. Its context contains:

- `namespace` — the normalized namespace;
- `sourceFile` — the extension filename, without an absolute path;
- `dataDirectory` and `harnessRoot`;
- `agentName()` — reads the current `SOUL.md` frontmatter name;
- `log(level, ...args)` — writes through the harness logger.

The returned API must be a plain object. It may contain functions, finite primitive values, arrays, and plain nested objects. Elpis copies and freezes the API tree before exposing it. Circular references, accessors, class instances, non-finite numbers, and prototype-control keys are rejected.

Use `elpis.ext.$help()` to return frozen `{ namespace, file, description, members }[]` summaries for every loaded extension, or `elpis.ext.$help('example')` for one summary. Unknown namespaces throw. `elpis.ext.$failures()` returns frozen `{ file, namespace, stage, error }[]` records for extensions skipped during boot.

## Prompt injection and cache stability

`prompt` must be a string, not a callback. Elpis reads it once at boot, normalizes line endings, trims its outer boundary, and stores the resulting bytes. Prompt blocks are composed in normalized namespace order. The same frozen string is supplied to every system-prompt build until restart, including the Console context view.

Extension activation cannot mutate the copied prompt. Runtime state, timestamps, filesystem iteration order, and activation completion timing do not affect prompt composition. Extension authors should still keep the exported string deterministic; trusted code can compute a different string on each process start if deliberately written to do so.

Each extension prompt is headed by its `elpis.ext.<namespace>` path, description, and sorted exported-member list. The extension's own text follows verbatim.

## Lifecycle and failure

Extensions are discovered and activated before the sandbox, LLM, and Discord runtime are constructed. Discovery, namespace, import/TypeScript parse, definition, prompt, activation, and API-shape errors are caught per extension. The broken extension contributes neither API nor prompt text, its failure is logged and exposed through `$failures()`, and Elpis continues loading the remaining extensions and starts normally. Namespace collisions quarantine every file claiming the collided namespace.

Activation can perform host side effects before throwing; Elpis can prevent exposure of a partial API and prompt, but cannot roll back arbitrary effects made by trusted extension code.

Changes take effect only after a harness restart. There is no hot reload: one process has one extension registry and one prompt projection.

The loader creates `DATA_DIRECTORY/extensions/` with mode `0700` when it is absent. Extension files live with the agent's private data and should be included in encrypted backups. Keep secrets out of prompt strings because extension prompt text is sent to the configured model provider.
