// fill.ts — opt-in {{key}} substitution into a template string.
//
// The `<<<TAG` heredoc is a deliberately RAW carrier (JSON.stringify, no
// interpolation) so it can hold source code full of `${...}` and `{...}`
// verbatim. `fill` is the SEPARATE, opt-in way to inject a computed value
// without breaking that guarantee: only `{{<identifier>}}` is a placeholder,
// and substitution is strict both ways so a typo throws instead of silently
// producing wrong text. Pure and synchronous.

/** The one placeholder shape: `{{name}}`, name = a JS-ish identifier, no inner
 * spaces. Anything else between double braces (`{{ x }}`, `{{}}`) is literal. */
const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

export function fill(template: string, vars: Record<string, unknown>): string {
  if (typeof template !== 'string') {
    throw new Error('fill(template, vars): template must be a string');
  }
  if (vars === null || typeof vars !== 'object') {
    throw new Error(
      'fill(template, vars): vars must be an object of { key: value }',
    );
  }
  const used = new Set<string>();
  const out = template.replace(PLACEHOLDER, (_m, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      throw new Error(`fill: no value for {{${key}}} in vars`);
    }
    used.add(key);
    return String(vars[key]);
  });
  const unused = Object.keys(vars).filter((k) => !used.has(k));
  if (unused.length > 0) {
    throw new Error(
      `fill: unused key ${unused.map((k) => `"${k}"`).join(', ')} — no {{${unused[0]}}} placeholder in the template`,
    );
  }
  return out;
}
