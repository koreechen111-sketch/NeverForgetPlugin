/**
 * 组装 Claude 压缩后需要重新注入的上下文；
 * 在 Token 预算内 筛选最重要的摘要 / 信息；
 * 输出格式化的上下文文本（无内容则返回 null）
 */

import type { SummaryStore } from './summary-store.js';
import type { ConversationStore } from './conversation-store.js';
import { logger } from '../utils/logger.js';

export class ContextAssembler {
  constructor(
    // 对话原始数据存储（未直接使用，预留扩展）
    private conversationStore: ConversationStore,
    // 核心依赖，读取层级摘要、关键上下文项
    private summaryStore: SummaryStore
  ) {}

  /**
   * conversationId：对话唯一 ID
   * tokenBudget：Token 预算（严格限制上下文长度，避免超限）
   * 生成 PostCompact hook 注入的格式化 additionalContext 字符串。
   * 无有效内容时返回 null。
   */
  buildPostCompactContext(conversationId: string, tokenBudget: number): string | null {
    // 1. 获取Token预算内的「顶级摘要」（层级DAG的核心摘要）
    const summaries = this.summaryStore.getTopSummaries(conversationId, tokenBudget);
    // 2. 获取关键上下文项（权重0.5，筛选高优先级信息）
    const contextItems = this.summaryStore.getContextItems(conversationId, 0.5);

    if (summaries.length === 0 && contextItems.length === 0) {
      logger.debug('No summaries or context items to inject', { conversationId });
      return null;
    }

    // 格式化上下文头部（提示 LCM 相关信息，便于后续工具识别）
    const parts: string[] = [
      '<lcm-restored-context>',// 自定义标签：区分用户对话，模型识别这是恢复的上下文
      '## Conversation Memory (LCM)',
      '',
      'The following context was preserved across compaction:',
      '',
    ];

    // 组装层级摘要
    if (summaries.length > 0) {
      parts.push('### Conversation Summaries');
      parts.push('');
      for (const summary of summaries) {
        // 层级标记：level0=最近摘要（未压缩），高层=压缩摘要
        const levelLabel = summary.level === 0 ? 'Recent' : `Level ${summary.level}`;
        // 展示：层级 + 覆盖的消息范围 + 摘要内容
        parts.push(`**[${levelLabel} — messages ${summary.messageRangeStart}–${summary.messageRangeEnd}]**`);
        parts.push(summary.content);
        parts.push('');
      }
    }

    if (contextItems.length > 0) {
      parts.push('### Key Context Items');
      parts.push('');
      // 限制最多10项：控制Token消耗
      for (const item of contextItems.slice(0, 10)) {
        parts.push(`- **[${item.category}]** ${item.content}`);
      }
      parts.push('');
    }
    // tool提示：引导 LLM 使用 lcm_grep/expand 工具扩展详情
    parts.push('> Use `lcm_grep` or `lcm_expand` tools to retrieve full details on any topic above.');
    parts.push('</lcm-restored-context>');

    return parts.join('\n');
  }
}