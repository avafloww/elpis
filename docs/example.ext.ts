import type { ExtensionContext, ExtensionDefinition } from '../src/extensions.js';

/**
 * Working Elpis extension example.
 *
 * Copy this file to DATA_DIRECTORY/elpis-data/config/extensions/example.ext.ts, edit it, then
 * restart the harness. The filename becomes a lower-camelCase sandbox namespace, so this file
 * is exposed as elpis.ext.example.
 *
 * Extensions are trusted host code. They run inside the main Node.js process
 * with the service user's authority, not inside the node:vm sandbox.
 */
export const extension = {
  // Shown by elpis.ext.$help() and in the boot-frozen extension prompt block.
  description: 'Small working extension example.',

  // Prompt must be a deterministic string, not a callback. It is copied once
  // at boot and stays byte-stable until the next restart.
  prompt: `\`elpis.ext.example.greet(name)\` returns a greeting from the current agent.`,

  // Names are append-only and sorted. SQL migrations are checksummed automatically
  // and run transactionally before activate. Prefix tables with the extension name.
  migrations: [{
    name: '0001-example-state',
    sql: `CREATE TABLE example_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  }],

  // activate may be synchronous or async. Return a plain API object containing
  // functions, primitives, arrays, and other plain objects.
  activate(context: ExtensionContext) {
    context.log('info', 'example extension activated');
    context.database.prepare('SELECT COUNT(*) FROM example_state').get();
    return {
      greet(name: string) {
        context.runLog('example.greet:', name);
        if (typeof name !== 'string' || !name.trim()) {
          throw new TypeError('elpis.ext.example.greet(name): name must be a non-empty string');
        }
        return `hello, ${name.trim()} — from ${context.agentName()}`;
      },
    };
  },
} satisfies ExtensionDefinition;
