// Driver for the markdown-render-speed-02 entry.
// Reads /input/cases.json (or $MAKEFUN_INPUT_DIR/cases.json), renders every
// case with parse() from ./parse.js, and writes the HTML strings in order to
// /output/html.json (or $MAKEFUN_OUTPUT_DIR/html.json).
// Run by the harness as: node /bot/main.ts  (Node 22, stdlib only).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function main(): void {
  const raw = readFileSync(join(inDir, 'cases.json'), 'utf8');
  const cases = JSON.parse(raw) as Array<{ id: string; markdown: string }>;
  const out: string[] = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) {
    out[i] = parse(cases[i].markdown);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'html.json'), JSON.stringify(out));
}

main();
