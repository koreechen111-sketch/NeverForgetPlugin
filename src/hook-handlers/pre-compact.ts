#!/usr/bin/env node
/**
 * PreCompact hook
 *
 * 运行时机：Claude Code内置的上下文压缩之前
 * 核心职责：执行「最终快照」，确保所有未捕获的转录消息都完整存入SQLite，然后让Claude正常压缩
 * 设计原则：极简，只做消息摄入，不返回任何钩子输出，完全不干扰Claude的正常压缩流程
 * 关联钩子：PostCompact会在Claude压缩完成后，捕获它生成的compact_summary存入SQLite
 */

import { runHook } from './orchestrator.js';
import type { HookContext } from './orchestrator.js';
import type { HookOutput } from '../core/types.js';
import { ingestNewMessages } from './ingest.js';
import { logger } from '../utils/logger.js';

async function handler(ctx: HookContext): Promise<HookOutput> {
  const { input, conversationStore, summaryStore } = ctx;

  // 执行最终快照
  if (input.transcript_path) {
    const { messagesIngested } = await ingestNewMessages(
      input.transcript_path,
      input.session_id,
      input.cwd ?? '',
      conversationStore,
      summaryStore
    );
    logger.info('PreCompact: snapshot complete', { messagesIngested });
  }

  return {};
}

runHook(handler);
