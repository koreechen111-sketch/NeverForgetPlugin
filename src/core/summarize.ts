/**
 * Granular summarization via Haiku.
 *  配置 ANTHROPIC_API_KEY 后由 Stop 钩子使用
 *  每约20K Token 生成一级细粒度摘要，与 lossless-claw 方案一致
 * 
 * 三级降级策略：
 * 1级 - 保留细节（目标T个Token）
 * 2级 - 项目符号要点（目标T/2个Token）
 * 3级 - 确定性截断（兜底保证收敛） convergence)
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LcmMessage } from './types.js';
import { estimateTokens } from './transcript-reader.js';

// 摘要提示词模板
const PROMPTS = {
  // 保留细节：提取关键事实、决策、代码变更、文件路径，保留核心上下文
  preserve_details:
    'Summarize the key facts, decisions, code changes, file paths, and context from this conversation segment. Be concise but preserve important specifics that would be needed to continue this work:',
  // 要点模式：精简为项目符号，仅保留核心决策、文件路径、关键状态
  bullet_points:
    'Summarize as concise bullet points. Include only: key decisions, file paths changed, and critical state. One bullet per fact:',
} as const;

// 摘要模式类型定义
export type SummarizeMode = 'preserve_details' | 'bullet_points';

/**
 * 确定性截断函数
 * 在极端情况下，当输入消息过多且无法生成有效摘要时，使用确定性截断作为最后的降级策略，保证一定能生成一个长度受限的摘要，避免无限膨胀。
 * 通过简单地拼接消息内容并截断到指定的Token等效字符数，确保输出不会超过目标Token限制。 这种方法虽然不智能，但在没有其他选项时可以提供一个基本的摘要，保证系统的鲁棒性。
 */
export function deterministicTruncate(messages: LcmMessage[], maxTokens: number): string {
  // 拼接所有消息为标准格式
  const full = messages
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n\n---\n\n');

  // 按Token估算规则转换字符限制：1 Token ≈ 4 字符
  const charLimit = maxTokens * 4;
  // 截断并返回
  return full.slice(0, charLimit);
}

// 调用 Anthropic API 生成消息摘要
export async function summarizeMessages(
  messages: LcmMessage[],
  apiKey: string,
  options?: { mode?: SummarizeMode; targetTokens?: number },
): Promise<string> {
  // 设置默认参数：保留细节模式，目标512Token
  const mode = options?.mode ?? 'preserve_details';
  const targetTokens = options?.targetTokens ?? 512;
  // 初始化 Anthropic 客户端
  const client = new Anthropic({ apiKey });

  // 格式化消息内容，单条消息限制2000字符避免过长
  const content = messages
    .map((m) => `[${m.role}]: ${m.content.slice(0, 2000)}`)
    .join('\n\n---\n\n');

  // 调用 API 生成摘要
  const response = await client.messages.create({
    model: 'inherit',
    max_tokens: targetTokens,
    messages: [{ role: 'user', content: `${PROMPTS[mode]}\n\n${content}` }],
  });

  // 提取并返回文本结果
  const block = response.content[0];
  return block.type === 'text' ? block.text : '';
}

/**
 * 三级降级摘要策略：保证一定能生成有效的短摘要（强制收敛）
 * 在极端情况下，当输入消息过多且无法生成有效摘要时，使用确定性截断作为最后的降级策略，保证一定能生成一个长度受限的摘要，避免无限膨胀。
 * 通过简单地拼接消息内容并截断到指定的Token等效字符数，确保输出不会超过目标Token限制。 这种方法虽然不智能，但在没有其他选项时可以提供一个基本的摘要，保证系统的鲁棒性。
 */
export async function summarizeWithEscalation(
  messages: LcmMessage[],
  apiKey: string,
  targetTokens: number = 512,
): Promise<{ text: string; level: number }> {
  // 计算输入消息的总Token数
  const inputTokens = messages.reduce((sum, m) => sum + m.tokenCount, 0);

  // 1级：保留细节模式摘要
  const l1 = await summarizeMessages(messages, apiKey, { mode: 'preserve_details', targetTokens });
  if (estimateTokens(l1) < inputTokens) {
    return { text: l1, level: 1 };
  }

  // 2级：要点模式摘要，Token限额减半
  const l2 = await summarizeMessages(messages, apiKey, {
    mode: 'bullet_points',
    targetTokens: Math.floor(targetTokens / 2),
  });
  if (estimateTokens(l2) < inputTokens) {
    return { text: l2, level: 2 };
  }

  // 3级：兜底强制截断，绝对保证收敛
  const l3 = deterministicTruncate(messages, 512);
  return { text: l3, level: 3 };
}
