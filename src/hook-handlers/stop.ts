#!/usr/bin/env node
/**
 * Stop hook
 *
 * 运行时机：Claude Code会话结束/停止交互后
 * 1. 递归防护：防止`claude -p`子进程重复触发Stop钩子
 * 2. 实时消息摄入：摄入助手的最新回复、工具调用结果，这次要传fileStore和largeFileThreshold处理大文件
 * 3. 细粒度压缩（尽力而为）：每约granularCompactThreshold Token触发一次
 */

import { runHook } from './orchestrator.js';
import type { HookContext } from './orchestrator.js';
import type { HookOutput } from '../core/types.js';
import { ingestNewMessages } from './ingest.js';
import { summarizeWithEscalation } from '../core/summarize.js';
import { summarizeWithCLIEscalation } from '../core/summarize-cli.js';
import { estimateTokens } from '../core/transcript-reader.js';
import { condenseIfNeeded } from '../core/condense.js';
import { logger } from '../utils/logger.js';

async function handler(ctx: HookContext): Promise<HookOutput> {
  // 递归防护：防止`claude -p`子进程重复触发Stop钩子
  if (process.env['LCM_SUBPROCESS'] === '1') return {};

  const { input, conversationStore, summaryStore, config } = ctx;
  if (!input.transcript_path) return {};

  // 步骤1：实时消息摄入
  const { messagesIngested } = await ingestNewMessages(
    input.transcript_path,
    input.session_id,
    input.cwd ?? '',
    conversationStore,
    summaryStore,
    ctx.fileStore,
    config.largeFileThreshold,
  );

  // 步骤2：细粒度压缩（尽力而为）
  // 优先级：Haiku SDK（有API Key）> Claude CLI（默认开）> 跳过（LCM_USE_CLI=false）
  const granularEnabled = config.anthropicApiKey || config.useCliSummarizer;
  if (granularEnabled && messagesIngested > 0) {
    try {
      // 获取或创建当前会话
      const conversation = conversationStore.getOrCreateConversation(input.session_id, input.cwd ?? '');
      // 获取上次压缩的最大消息序号
      const lastSeq = summaryStore.getMaxCompactedSequence(conversation.id);
      // 获取待压缩的消息：从上次最大序号+1开始
      const pending = conversationStore.getMessages(conversation.id, lastSeq + 1);
      // 计算待压缩消息的总Token数
      const pendingTokens = pending.reduce((sum, m) => sum + m.tokenCount, 0);

      if (pendingTokens >= config.granularCompactThreshold && pending.length > 0) {
        const maxSeq = pending[pending.length - 1]!.sequenceNumber;
        const mode = config.anthropicApiKey ? 'haiku-sdk' : 'claude-cli';
        logger.info('Stop: token threshold reached, summarizing', { tokens: pendingTokens, messages: pending.length, mode });

        const { text: summaryText, level: escalationLevel } = config.anthropicApiKey
          ? await summarizeWithEscalation(pending, config.anthropicApiKey)
          : await summarizeWithCLIEscalation(pending);

        const summary = summaryStore.insertSummary({
          conversationId: conversation.id,
          parentId: null,
          level: 0,
          content: summaryText,
          tokenCount: estimateTokens(summaryText),
          messageRangeStart: lastSeq + 1,
          messageRangeEnd: maxSeq,
        });

        // 关联摘要和它覆盖的原始消息：方便后续检索时回溯原始内容
        summaryStore.linkSummaryToMessages(summary.id, pending.map(m => m.id));

        // 记录信息日志：说明细粒度摘要已存储，包含覆盖范围、模式、降级级别
        logger.info('Stop: granular summary stored', { range: `${lastSeq + 1}-${maxSeq}`, mode, escalationLevel });

        // 触发DAG层级压缩：如果level-0摘要够多，压缩成level-1
        const condensed = await condenseIfNeeded(conversation.id, summaryStore, config);
        if (condensed > 0) {
          // 记录信息日志：说明DAG层级压缩已完成，包含压缩的level-0摘要数
          logger.info('Stop: DAG condensation completed', { condensedCount: condensed });
        }
      }
    } catch (err) {
      // 记录警告日志：细粒度压缩失败，但不阻塞Stop钩子
      logger.warn('Stop: granular summarization failed', { err });
    }
  }

  return {};
}

runHook(handler);
