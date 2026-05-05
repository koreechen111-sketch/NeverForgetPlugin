#!/usr/bin/env node
/**
 * SessionStart hook
 *
 * 运行时机：Claude Code会话启动时
 * 1. 初始化会话相关的数据库状态（通过ingest和getOrCreate间接完成）
 * 2. 实现跨会话连续性：如果有之前同项目同会话的压缩摘要，注入为additionalContext
 */

import { runHook } from './orchestrator.js';
import type { HookContext } from './orchestrator.js';
import type { HookOutput } from '../core/types.js';
import { ingestNewMessages } from './ingest.js';
import { logger } from '../utils/logger.js';

async function handler(ctx: HookContext): Promise<HookOutput> {
  const { input, conversationStore, summaryStore, config } = ctx;
  const sessionId = input.session_id;
  const projectPath = input.cwd ?? '';

  // 步骤1：处理会话恢复的情况
  if (input.transcript_path) {
    await ingestNewMessages(
      input.transcript_path,
      sessionId,
      projectPath,
      conversationStore,
      summaryStore
    );
  }

  // 步骤2：检查是否有之前同项目同会话的压缩摘要
  const conversation = conversationStore.getConversationBySession(sessionId);
  if (!conversation) {
    logger.debug('SessionStart: no existing conversation', { sessionId });
    return {};
  }

  const summaries = summaryStore.getTopSummaries(conversation.id, config.postCompactInjectionTokens);
  if (summaries.length === 0) return {};

  const contextBlock = buildContextBlock(summaries.map((s) => s.content));
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: contextBlock,
    },
  };
}

function buildContextBlock(summaryTexts: string[]): string {
  return [
    '<lcm-session-context>',
    '## Prior Session Memory (LCM)',
    '',
    'The following context was preserved from earlier in this conversation:',
    '',
    ...summaryTexts.map((t, i) => `### Summary ${i + 1}\n${t}`),
    '',
    'Use lcm_grep or lcm_expand tools to retrieve full details on any topic.',
    '</lcm-session-context>',
  ].join('\n');
}

runHook(handler);
