/**
 * 多个钩子处理器共享的通用消息摄入逻辑
 * 核心职责：1. 从Claude Code的JSONL转录文件增量读取新条目 2. 解析并存储到ConversationStoreReads
 */

import { readNewTranscriptEntries, estimateTokens } from '../core/transcript-reader.js';
import type { ConversationStore } from '../core/conversation-store.js';
import type { SummaryStore } from '../core/summary-store.js';
import type { FileStore } from '../core/file-store.js';
import { detectFileType, generateExplorationSummary } from '../core/file-analyzer.js';
import { logger } from '../utils/logger.js';

// 通用消息摄入函数
export async function ingestNewMessages(
  transcriptPath: string,
  sessionId: string,
  projectPath: string,
  conversationStore: ConversationStore,
  summaryStore: SummaryStore,
  fileStore?: FileStore,
  largeFileThreshold?: number,
): Promise<{ messagesIngested: number }> {
  // 如果转录文件路径为空，直接返回0，避免后续文件操作报错
  if (!transcriptPath) return { messagesIngested: 0 };

  // 获取或创建当前会话：保证会话一定存在，避免后续存储消息时找不到会话ID
  const conversation = conversationStore.getOrCreateConversation(sessionId, projectPath);

  // 获取上次的转录断点游标：如果没有则初始化新的（字节偏移0，最后时间戳0）
  // 游标用于实现断点续传，每次只读取自上次以来的新内容
  const cursor = summaryStore.getCursor(sessionId) ?? {
    sessionId,
    byteOffset: 0,
    lastTimestamp: 0,
  };

  // 核心调用：从转录文件读取新条目，解析为结构化消息，同时计算更新后的游标
  const { messages, updatedCursor } = readNewTranscriptEntries(transcriptPath, cursor);

  // 性能优化：如果没有新消息，直接返回0，不做后续的存储、游标更新等操作
  if (messages.length === 0) {
    return { messagesIngested: 0 };
  }

  // 大文件阈值处理：优先使用传入的参数，未设置则使用默认值25000（与config保持一致）
  const threshold = largeFileThreshold ?? 25000;
  // 获取当前时间戳：如果消息没有自带时间戳，就用这个作为默认值
  const now = Date.now();
  // 遍历每条解析后的消息，逐个处理
  for (const msg of messages) {
    // 外层try/catch：单条消息处理失败（插入失败、大文件处理失败）不影响其他消息的摄入
    try {
      // 估算当前消息的Token数量：用于后续存储到数据库、判断是否为大文件
      const tokenCount = estimateTokens(msg.content);
      // 插入消息到会话存储：传入所有必要参数，包括会话ID、角色、内容、Token、时间戳、元数据
      const inserted = conversationStore.insertMessage({
        conversationId: conversation.id,
        role: msg.role,
        content: msg.content,
        tokenCount,
        timestamp: msg.timestamp || now,
        metadata: msg.metadata,
      });

      // 大文件检测与存储：仅在fileStore存在、消息角色是tool_result、Token超过阈值时触发
      if (fileStore && msg.role === 'tool_result' && tokenCount > threshold) {
        try {
          // 分析消息内容的文件类型：比如json、code、sql、text等
          const fileType = detectFileType(msg.content);
          // 生成文件的结构化摘要：用于后续快速预览文件内容，无需读取完整大文件
          const explorationSummary = generateExplorationSummary(msg.content, fileType);
          // 截取消息内容的前500字符作为预览：用于在UI或摘要中快速展示
          const contentPreview = msg.content.slice(0, 500);
          // 插入大文件元数据到文件存储：关联当前消息ID和会话ID
          fileStore.insertFile({
            messageId: inserted.id,
            conversationId: conversation.id,
            filePath: null,
            fileType,
            rawTokenCount: tokenCount,
            contentPreview,
            explorationSummary,
          });
          logger.debug('Large file detected and stored', { messageId: inserted.id, fileType, tokenCount });
        } catch (fileErr) {
          // 记录警告日志：大文件存储失败，但不影响主流程
          logger.warn('Failed to store large file metadata', { fileErr, messageId: inserted.id });
        }
      }
    } catch (err) {
      // 记录警告日志：单条消息插入失败，跳过继续处理下一条
      logger.warn('Failed to insert message', { err, role: msg.role });
    }
  }

  // 更新摘要存储的转录游标：保存当前文件大小和最新时间戳，下次只读取新内容
  summaryStore.upsertCursor(updatedCursor);
  // 触达会话：更新会话的最后访问时间，可能用于后续的会话排序、清理等功能
  conversationStore.touchConversation(conversation.id);

  // 记录调试日志：记录本次成功摄入的消息数量和会话ID
  logger.debug('Ingested messages', { count: messages.length, sessionId });
  return { messagesIngested: messages.length };
}
