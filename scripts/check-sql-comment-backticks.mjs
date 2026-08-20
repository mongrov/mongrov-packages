#!/usr/bin/env node
/**
 * Catch backticks inside SQL comments in JS template literals.
 *
 * ## Why this is a script and not an ESLint rule
 *
 * An unescaped backtick TERMINATES the template literal it sits in. The rest
 * of the file then parses as JavaScript, and almost always fails. So the file
 * has no valid AST, no ESLint rule ever runs against it, and the error the
 * developer actually sees is:
 *
 *     SyntaxError: Unexpected token, expected "," (1051:10)
 *
 * pointing at a line that looks fine. Detection was never the problem —
 * typecheck, lint and tests all fail immediately. DIAGNOSIS is the problem,
 * and it cost three separate incidents in one session, in a file that already
 * carried a warning comment two queries above the fourth occurrence.
 *
 * A text scan runs before parsing and can say what is actually wrong.
 *
 * ## What it looks for
 *
 * Lines whose first non-whitespace is a SQL line comment (`--`) and which
 * contain a backtick. That is deliberately narrow: `--` at the start of a line
 * inside a .ts file is almost only ever SQL, and a backtick in prose there is
 * almost only ever a mistake. Decrement operators (`i--`) never start a line
 * after trimming, so they do not match.
 */

import { globSync, readFileSync } from 'node:fs';
import process from 'node:process';

const PATTERN = /^\s*--.*`/;

const files = globSync('packages/*/src/**/*.ts', { cwd: process.cwd() });

const failures = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (PATTERN.test(line))
      failures.push({ file, line: i + 1, text: line.trim() });
  });
}

if (failures.length === 0) {
  process.exit(0);
}

console.error(
  '\nBacktick inside a SQL comment — this terminates the template literal.\n'
  + 'The parser will report an unrelated "Unexpected token" further down.\n'
  + 'Write the identifier without backticks.\n',
);
for (const f of failures)
  console.error(`  ${f.file}:${f.line}\n    ${f.text}\n`);

process.exit(1);
