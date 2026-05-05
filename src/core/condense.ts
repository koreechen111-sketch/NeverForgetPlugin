/**
 * DAG 压缩：从 level-0 基础摘要生成 level-1 高层摘要，后续可扩展 level-2+；
 * 
 * 触发机制：当未压缩（parentId === null）的 level-0 摘要数量达到阈值时，自动执行压缩；
 * 层级关联：新生成的高层摘要作为 DAG 中的父节点，原 level-0 摘要作为子节点，通过 parentId 构建 DAG；
 * 适配双摘要器：支持 Anthropic API 在线摘要 / CLI 本地摘要两种模式
 */

// 类型定义：
import type { SummaryStore } from './summary-store.js';
import type { LcmMessage } from './types.js';
// 核心摘要生成函数（API版/CLI版）
import { summarizeWithEscalation } from './summarize.js';
import { summarizeWithCLIEscalation } from './summarize-cli.js';
// Token 估算工具、日志工具
import { estimateTokens } from './transcript-reader.js';
import { logger } from '../utils/logger.js';

interface CondenseConfig {
  condensationThreshold: number;// 压缩阈值：多少个level-0才触发压缩
  anthropicApiKey: string | null;// Anthropic API密钥（优先使用）
  useCliSummarizer: boolean;// 是否使用CLI本地摘要器（降级方案）
}

/**
 * 检查是否需要压缩并进行压缩操作。
 * 将未压缩的 level-0 摘要分组为批次并创建 level-1 父摘要。
 */
export async function condenseIfNeeded(
  conversationId: string,
  summaryStore: SummaryStore,
  config: CondenseConfig,
): Promise<number> {
  const threshold = config.condensationThreshold;
  const uncondensed = summaryStore.getUncondensedSummaries(conversationId, 0);
  // 校验1：未压缩数量 < 阈值 → 不压缩
  if (uncondensed.length < threshold) {
    return 0;
  }
  // 校验2：无API密钥+未开CLI → 无摘要生成能力，不压缩
  const granularEnabled = config.anthropicApiKey || config.useCliSummarizer;
  if (!granularEnabled) {
    return 0;
  }

  let condensedCount = 0;

  // 循环切割：每threshold个连续摘要为1个批次
  for (let i = 0; i + threshold <= uncondensed.length; i += threshold) {
    const batch = uncondensed.slice(i, i + threshold);
    // 批次处理逻辑
    const rangeStart = batch[0]!.messageRangeStart;
    const rangeEnd = batch[batch.length - 1]!.messageRangeEnd;

    // 把level-0摘要包装成LcmMessage格式（适配 Claude Code 摘要生成函数的入参要求）
    const pseudoMessages: LcmMessage[] = batch.map((s, idx) => ({
      id: s.id,
      conversationId: s.conversationId,
      role: 'assistant' as const,
      content: s.content, // 核心：用摘要内容作为消息内容
      tokenCount: s.tokenCount,
      sequenceNumber: idx,
      timestamp: s.createdAt,
    }));

    try {
      // 优先用API摘要，降级用CLI摘要
      const { text, level: escalationLevel } = config.anthropicApiKey
        ? await summarizeWithEscalation(pseudoMessages, config.anthropicApiKey)
        : await summarizeWithCLIEscalation(pseudoMessages);

      // 插入新的level-1摘要到存储
      const parent = summaryStore.insertSummary({
        conversationId,
        parentId: null,
        level: 1,
        content: text,
        tokenCount: estimateTokens(text),
        messageRangeStart: rangeStart,
        messageRangeEnd: rangeEnd,
      });

      // 把批次内所有level-0摘要的parentId，指向新生成的level-1父摘要
      for (const child of batch) {
        summaryStore.updateParentId(child.id, parent.id);
      }

      condensedCount++;
      // 日志
      logger.info('Condense: created level-1 summary', {
        parentId: parent.id,
        children: batch.length,
        range: `${rangeStart}-${rangeEnd}`,
        escalationLevel,
      });
    } catch (err) {
      logger.warn('Condense: failed to create condensed summary', { err });
    }
  }

  return condensedCount;
}