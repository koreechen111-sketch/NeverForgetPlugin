/**
 * 检索引擎 - 搜索、描述、展开存储的历史记录
 */

import type { ConversationStore } from './conversation-store.js';
import type { SummaryStore } from './summary-store.js';
import type { GrepResult, DescribeResult, ExpandResult } from './types.js';

// 检索引擎主类：整合对话存储、摘要存储，提供历史检索能力
export class RetrievalEngine {
  constructor(
    // 构造函数：注入对话存储、摘要存储实例
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore
  ) {}

  /**
   * 全文检索 / 模糊检索所有存储的消息，支持按对话过滤和摘要范围过滤；
   * 返回消息的基本信息 + 覆盖它的摘要ID（如果有的话，便于后续展开）；
   * 当指定 summaryId 时，优先在该摘要覆盖的消息范围内搜索，提升相关性。
   * 结果按相关性排序，返回前 limit 条。
   */
  grep(query: string, conversationId?: string, limit = 50, summaryId?: string): GrepResult[] {
    // 检索范围变量初始化
    let searchConvId = conversationId;
    let searchLimit = limit;
    let scopeSummary: ReturnType<SummaryStore['getSummary']> = null;
   
    // 如果指定了摘要ID，限定检索该摘要所属对话，并扩大检索数量
    if (summaryId) {
      scopeSummary = this.summaryStore.getSummary(summaryId);
      if (scopeSummary) {
        searchConvId = searchConvId ?? scopeSummary.conversationId;
        searchLimit = Math.max(limit * 5, 200);
      }
    }

    // 执行消息检索
    let messages = this.conversationStore.search(query, searchConvId, searchLimit);

    // 按摘要范围过滤消息（仅保留摘要覆盖的消息）
    if (scopeSummary) {
      messages = messages
        .filter(
          (m) =>
            m.conversationId === scopeSummary!.conversationId &&
            m.sequenceNumber >= scopeSummary!.messageRangeStart &&
            m.sequenceNumber <= scopeSummary!.messageRangeEnd
        )
        .slice(0, limit);
    }

    // 摘要缓存：避免重复查询，提升性能
    const summaryCache = new Map<string, ReturnType<SummaryStore['getSummariesForConversation']>>();

    // 组装检索结果，关联覆盖当前消息的摘要ID（如果有的话）
    return messages.map((m) => {
      const conv = this.conversationStore.getConversation(m.conversationId);

      // 缓存当前对话的所有摘要
      if (!summaryCache.has(m.conversationId)) {
        summaryCache.set(m.conversationId, this.summaryStore.getSummariesForConversation(m.conversationId, 0));
      }
      const convSummaries = summaryCache.get(m.conversationId)!;
      // 查找覆盖当前消息的摘要
      const covering = convSummaries.find(
        (s) => s.messageRangeStart <= m.sequenceNumber && s.messageRangeEnd >= m.sequenceNumber
      );

      return {
        messageId: m.id,
        conversationId: m.conversationId,
        sessionId: conv?.sessionId ?? '',
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        sequenceNumber: m.sequenceNumber,
        coveringSummaryId: covering?.id ?? null,
      };
    });
  }

  // 根据ID查询详情：支持 摘要ID(sum_)、消息ID(msg_)，返回元数据+内容
  describe(id: string): DescribeResult | null {
    if (id.startsWith('sum_')) {
      const summary = this.summaryStore.getSummary(id);
      if (!summary) return null;
      const childCount = this.summaryStore.getChildCount(id);
      return {
        id: summary.id,
        type: 'summary',
        content: summary.content,
        tokenCount: summary.tokenCount,
        level: summary.level,
        parentId: summary.parentId,
        childCount,
        messageRangeStart: summary.messageRangeStart,
        messageRangeEnd: summary.messageRangeEnd,
        createdAt: summary.createdAt,
      };
    }

    // 查询消息详情
    if (id.startsWith('msg_')) {
      const message = this.conversationStore.getMessage(id);
      if (!message) return null;
      return {
        id: message.id,
        type: 'message',
        content: message.content,
        tokenCount: message.tokenCount,
        createdAt: message.timestamp,
      };
    }

    // 不支持的ID类型
    return null;
  }

  /**
   * 展开摘要：递归获取原始消息、子摘要
   * 支持递归深度、Token上限控制，防止上下文溢出
   */
  expand(summaryId: string, depth = 1, tokenCap = 8000): ExpandResult {
    const summary = this.summaryStore.getSummary(summaryId);
    if (!summary) {
      return { summaryId, messages: [], childSummaries: [], truncated: false, totalTokens: 0 };
    }

    // 获取当前摘要的子摘要    
    const childSummaries = this.summaryStore.getChildSummaries(summaryId);

    // 递归展开：深度>1 且存在子摘要时，递归获取子摘要的消息
    if (depth > 1 && childSummaries.length > 0) {
      const messages = [];
      let totalTokens = 0;
      let truncated = false;

      for (const child of childSummaries) {
        if (truncated) break;
        // 递归展开子摘要，剩余Token作为限额
        const childResult = this.expand(child.id, depth - 1, tokenCap - totalTokens);
        for (const msg of childResult.messages) {
          // 超出Token限额则截断
          if (totalTokens + msg.tokenCount > tokenCap) {
            truncated = true;
            break;
          }
          messages.push(msg);
          totalTokens += msg.tokenCount;
        }
        if (childResult.truncated) truncated = true;
      }

      return { summaryId, messages, childSummaries, truncated, totalTokens };
    }

    // 叶子节点展开：直接获取摘要关联的原始消息ID
    const messageIds = this.summaryStore.getMessageIdsForSummary(summaryId);

    let totalTokens = 0;
    const messages = [];
    let truncated = false;

    // 按消息ID加载消息，控制Token总量
    for (const msgId of messageIds) {
      const msg = this.conversationStore.getMessage(msgId);
      if (!msg) continue;
      if (totalTokens + msg.tokenCount > tokenCap) {
        truncated = true;
        break;
      }
      messages.push(msg);
      totalTokens += msg.tokenCount;
    }

    // 无直接关联消息时，按序列号范围加载消息
    if (messages.length === 0 && summary.conversationId) {
      const rangeMessages = this.conversationStore.getMessages(
        summary.conversationId,
        summary.messageRangeStart,
        summary.messageRangeEnd
      );
      for (const msg of rangeMessages) {
        if (totalTokens + msg.tokenCount > tokenCap) {
          truncated = true;
          break;
        }
        messages.push(msg);
        totalTokens += msg.tokenCount;
      }
    }

    return { summaryId, messages, childSummaries, truncated, totalTokens };
  }

  // 组合能力： 一键获取搜索结果的完整上下文（关键词检索 → 自动展开相关摘要）
  expandQuery(query: string, maxResults = 5, tokenCap = 8000): ExpandResult[] {
    // 执行关键词检索
    const grepResults = this.grep(query, undefined, maxResults);
    if (grepResults.length === 0) return [];

    const results: ExpandResult[] = [];
    const seenConvIds = new Set<string>();

    for (const match of grepResults) {
      // 每个对话只处理一次
      if (seenConvIds.has(match.conversationId)) continue;
      seenConvIds.add(match.conversationId);

      // 获取对话的所有摘要，匹配覆盖当前消息的摘要
      const summaries = this.summaryStore.getSummariesForConversation(match.conversationId, 0);
      const relevant = summaries.filter(
        (s) =>
          s.messageRangeStart <= match.sequenceNumber &&
          s.messageRangeEnd >= match.sequenceNumber
      );

      // 有匹配摘要：展开摘要
      if (relevant.length > 0) {
        const summary = relevant[0]!;
        // 平均分配Token限额，展开摘要获取完整上下文
        results.push(this.expand(summary.id, 1, Math.floor(tokenCap / maxResults)));
      } else {
        // 无摘要：直接返回原始消息（兜底方案）
        const msg = this.conversationStore.getMessage(match.messageId);
        if (msg) {
          const perResultCap = Math.floor(tokenCap / maxResults);
          const truncated = msg.tokenCount > perResultCap;
          results.push({
            summaryId: null,
            isFallback: true,
            messages: truncated ? [] : [msg],
            childSummaries: [],
            truncated,
            totalTokens: truncated ? 0 : msg.tokenCount,
          });
        }
      }
    }

    return results;
  }
}
