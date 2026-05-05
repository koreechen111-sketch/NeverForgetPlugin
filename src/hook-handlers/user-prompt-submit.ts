#!/usr/bin/env node
/**
 * UserPromptSubmit hook handler (async).
 * Ingests new messages from the transcript into SQLite.
 */

import { runHook } from './orchestrator.js';
import type { HookContext } from './orchestrator.js';
import type { HookOutput } from '../core/types.js';
import { ingestNewMessages } from './ingest.js';

async function handler(ctx: HookContext): Promise<HookOutput> {
  const { input, conversationStore, summaryStore } = ctx;
  if (!input.transcript_path) return {};

  await ingestNewMessages(
    input.transcript_path,
    input.session_id,
    input.cwd ?? '',
    conversationStore,
    summaryStore
  );

  return {};
}

runHook(handler);
