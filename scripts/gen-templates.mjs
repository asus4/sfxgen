#!/usr/bin/env node
// Collects templates/**/*.sfx.json into src/core/templates/library.json, which the editor and the CLI import.
// Takes (`<name>.takes/*.sfx.json`, versions of a sound waiting for a person to pick one) are not templates.
// Run after adding or editing a template: `npm run templates` (the build runs it too).
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(root, 'templates');
const out = join(root, 'src', 'core', 'templates', 'library.json');

function walk(d) {
  return readdirSync(d).flatMap((name) => {
    const p = join(d, name);
    if (statSync(p).isDirectory()) return name.endsWith('.takes') ? [] : walk(p);
    return name.endsWith('.sfx.json') ? [p] : [];
  });
}

const entries = [];
const problems = [];
for (const file of walk(dir).sort()) {
  const id = relative(dir, file).split(sep).join('/').replace(/\.sfx\.json$/, '');
  try {
    const patch = JSON.parse(readFileSync(file, 'utf8'));
    entries.push({ id, category: id.includes('/') ? id.split('/')[0] : 'misc', patch });
  } catch (err) {
    problems.push(`${id}: ${err.message}`);
  }
}
writeFileSync(out, JSON.stringify(entries) + '\n');
console.log(`templates: ${entries.length} written to ${relative(root, out)}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
