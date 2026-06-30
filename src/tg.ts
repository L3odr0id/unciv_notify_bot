// Telegram legacy-Markdown formatting helpers.

export type SendOpts = { markdown?: boolean };

// Wrap an id as monospace + tap-to-copy. Ids are UUID/alphanumeric/hyphen and
// contain no backticks, so nothing inside the code span needs escaping.
export const code = (s: string): string => `\`${s}\``;

// Escape the legacy-Markdown specials so free text (civ name, username) shown
// in a Markdown message renders literally and never breaks entity parsing.
export const esc = (s: string): string => s.replace(/[_*[\]`]/g, '\\$&');
