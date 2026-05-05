#!/usr/bin/env node
import { build } from 'esbuild';

const entryPoints = [
  'src/mcp-server/index.ts',
  'src/hook-handlers/session-start.ts',
  'src/hook-handlers/user-prompt-submit.ts',
  'src/hook-handlers/stop.ts',
  'src/hook-handlers/pre-compact.ts',
  'src/hook-handlers/post-compact.ts',
];

await build({
  entryPoints,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: 'dist',
  outbase: 'src',
  sourcemap: true,
  target: 'node22',
});
