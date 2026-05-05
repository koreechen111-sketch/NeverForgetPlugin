#!/usr/bin/env node
/**
 * PostCompact hook
 *
 * 运行时机：Claude Code内置的上下文压缩完成后
 * 1. 捕获Claude Code自己生成的compact_summary → 存入SQLite作为level-0无损摘要
 * 2. 重新注入积累的所有无损摘要作为additionalContext → 让Claude拥有完整的对话历史
 */
import { runHook } from './orchestrator.js';
import type { HookContext } from './orchestrator.js';
import type { HookOutput } from '../core/types.js';
import { ContextAssembler } from '../core/context-assembler.js';
import { estimateTokens } from '../core/transcript-reader.js';
import { logger } from '../utils/logger.js';

async function handler(ctx: HookContext): Promise<HookOutput> {
  const { input, conversationStore, summaryStore, config } = ctx;

  // 获取或创建当前会话：保证会话一定存在
  const conversation = conversationStore.getOrCreateConversation(input.session_id, input.cwd ?? '');

  // 捕获Claude Code自己生成的compact_summary
  const compactSummary = (input['compact_summary'] as string | undefined)?.trim();
  if (compactSummary) {
    // 计算当前会话的总消息数
    const msgCount = conversationStore.getMessageCount(conversation.id);
    // 计算本次摘要覆盖的消息结束序号：总消息数-1（序号从0开始）
    const rangeEnd = Math.max(0, msgCount - 1);
    // 获取上次压缩的最大消息序号：避免重复覆盖之前的摘要
    const existingMax = summaryStore.getMaxCompactedSequence(conversation.id);
    // 计算本次摘要覆盖的消息开始序号：上次最大序号+1
    const rangeStart = Math.max(0, existingMax + 1);

    // 插入Claude生成的摘要到摘要存储：作为level-0无损摘要，无父摘要
    const summary = summaryStore.insertSummary({
      conversationId: conversation.id,
      parentId: null,
      level: 0,
      content: compactSummary,
      tokenCount: estimateTokens(compactSummary),
      messageRangeStart: rangeStart,
      messageRangeEnd: rangeEnd,
    });

    // 关联摘要和它覆盖的原始消息：方便后续检索时回溯原始内容
    const msgsInRange = conversationStore.getMessages(conversation.id, rangeStart, rangeEnd);
    if (msgsInRange.length > 0) {
      summaryStore.linkSummaryToMessages(summary.id, msgsInRange.map(m => m.id));
    }

    // 记录信息日志：方便排查摘要存储的问题，包含Token数和覆盖范围
    logger.info('PostCompact: stored Claude-generated summary', {
      tokens: estimateTokens(compactSummary),
      range: `${rangeStart}-${rangeEnd}`,
    });
  }

  // 步骤2：重新注入积累的所有无损摘要作为上下文
  const assembler = new ContextAssembler(conversationStore, summaryStore);
  // 构建PostCompact专用的上下文块：传入会话ID和配置的最大注入Token数
  const contextBlock = assembler.buildPostCompactContext(
    conversation.id,
    config.postCompactInjectionTokens
  );

  if (!contextBlock) {
    logger.debug('PostCompact: nothing to inject');
    return {};
  }

  // 如果没有可注入的上下文块，直接返回空对象
  logger.info('PostCompact: injecting context block');
  return {
    systemMessage: contextBlock,
  };
}

runHook(handler);
