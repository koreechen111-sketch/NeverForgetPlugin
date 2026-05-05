/**
 * 增量读取 Claude Code 的 JSONL 转录文件
 *
 * Claude Code 会将转录条目以换行分隔的 JSON 格式写入 `transcript_path`（钩子输入中提供）指定的文件。
 * 每个条目都是一个代表对话事件的 JSON 对象。
 *
 * 按会话跟踪字节偏移量，这样每次钩子调用只会处理自上次读取以来的新行。
 */

import fs from 'node:fs';
import type { TranscriptEntry, TranscriptCursor } from './types.js';

// 估算Token数量：约4个字符对应1个Token
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// 从消息内容字段中提取纯文本内容
function extractContent(
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>
): string {
  // 如果内容本身就是字符串，直接返回
  if (typeof content === 'string') return content;
  // 如果是数组，遍历每个内容块并提取文本
  return content
    .map((block) => {
      // 文本块：直接提取text字段
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      // 工具调用块：格式化展示工具名称和输入参数
      if (block.type === 'tool_use') {
        const name = block['name'] as string | undefined;
        const input = block['input'];
        return `[tool_use: ${name ?? 'unknown'} ${JSON.stringify(input ?? {})}]`;
      }
      // 工具结果块：格式化展示工具返回结果
      if (block.type === 'tool_result') {
        const toolContent = block['content'];
        // 结果是字符串的情况
        if (typeof toolContent === 'string') return `[tool_result: ${toolContent}]`;
        // 结果是数组的情况，提取其中的文本
        if (Array.isArray(toolContent)) {
          return `[tool_result: ${(toolContent as Array<{ text?: string }>)
            .map((b) => b.text ?? '')
            .join(' ')}]`;
        }
      }
      // 其他类型块：返回空字符串，后续会被过滤
      return '';
    })
    // 过滤掉空字符串
    .filter(Boolean)
    // 用换行符拼接所有有效内容
    .join('\n');
}

// 解析后的消息结构定义
export interface ParsedMessage {
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * 从 `transcriptPath` 读取自 `cursor.byteOffset` 开始的新行
 * 返回解析后的消息和更新后的游标
 * 核心功能：断点续传、增量读取、JSONL解析、消息结构化
 */
export function readNewTranscriptEntries(
  transcriptPath: string,
  cursor: TranscriptCursor
): { messages: ParsedMessage[]; updatedCursor: TranscriptCursor } {
  let fileContent: string;
  let fileSize: number;

  try {
    // 获取文件状态，主要是为了获取文件大小
    const stat = fs.statSync(transcriptPath);
    fileSize = stat.size;

    // 如果文件大小没有变化（小于等于上次读取的偏移量），说明没有新内容
    if (fileSize <= cursor.byteOffset) {
      return { messages: [], updatedCursor: cursor };
    }

    // 打开文件，只读模式
    const fd = fs.openSync(transcriptPath, 'r');
    // 创建缓冲区，大小为新增内容的长度
    const buffer = Buffer.alloc(fileSize - cursor.byteOffset);
    // 从上次的偏移量开始读取新增内容
    fs.readSync(fd, buffer, 0, buffer.length, cursor.byteOffset);
    // 关闭文件
    fs.closeSync(fd);
    // 将缓冲区转换为UTF-8字符串
    fileContent = buffer.toString('utf8');
  } catch {
    // 任何文件操作失败都返回空结果，不影响主流程
    return { messages: [], updatedCursor: cursor };
  }

  // 按换行符分割内容，过滤掉空行
  const lines = fileContent.split('\n').filter((l) => l.trim());
  const messages: ParsedMessage[] = [];
  // 初始化最后时间戳为游标记录的时间
  let lastTimestamp = cursor.lastTimestamp;

  // 遍历每一行JSONL内容
  for (const line of lines) {
    let entry: TranscriptEntry;
    try {
      // 尝试解析JSON
      entry = JSON.parse(line);
    } catch {
      // JSON解析失败，跳过这一行
      continue;
    }

    // 提取时间戳：优先使用条目的timestamp，否则使用当前时间
    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
    if (ts > lastTimestamp) lastTimestamp = ts;

    // 处理用户或助手消息
    if (entry.type === 'user' || entry.type === 'assistant') {
      const raw = entry.message.content;
      const content = extractContent(raw);
      if (!content.trim()) continue;

      // 检查内容是否为数组格式（可能包含工具调用/结果块）
      if (Array.isArray(entry.message.content)) {
        // 遍历每个内容块
        for (const block of entry.message.content) {
          // 工具调用块：单独作为一条tool_use消息
          if (block.type === 'tool_use') {
            const toolContent = `[tool_use: ${block['name'] ?? 'unknown'} ${JSON.stringify(block['input'] ?? {})}]`;
            messages.push({
              role: 'tool_use',
              content: toolContent,
              timestamp: ts,
              metadata: { tool_name: block['name'], tool_use_id: block['id'] },
            });
          } 
          // 工具结果块：单独作为一条tool_result消息
          else if (block.type === 'tool_result') {
            const resultContent =
              typeof block['content'] === 'string'
                ? block['content']
                : JSON.stringify(block['content'] ?? '');
            messages.push({
              role: 'tool_result',
              content: resultContent,
              timestamp: ts,
              metadata: { tool_use_id: block['tool_use_id'] },
            });
          }
          
          // 纯文本块：作为普通用户/助手消息
          else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            messages.push({ role: entry.type, content: block.text, timestamp: ts });
          }
        }
      } else {
        // 内容是字符串格式：直接作为普通用户/助手消息
        messages.push({ role: entry.type, content, timestamp: ts });
      }
    }
    
    // 处理系统消息
    else if (entry.type === 'system') {
      const content = (entry as { content?: string }).content;
      // 内容非空则添加
      if (content?.trim()) {
        messages.push({ role: 'system', content, timestamp: ts });
      }
    }
  }

  // 返回解析结果和更新后的游标
  return {
    messages,
    updatedCursor: {
      sessionId: cursor.sessionId,
      // 字节偏移量更新为当前文件大小
      byteOffset: fileSize,
      // 时间戳更新为最新消息的时间
      lastTimestamp,
    },
  };
}
