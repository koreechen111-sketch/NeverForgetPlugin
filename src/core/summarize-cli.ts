/**
 * 基于 claude -p 子进程实现细粒度摘要生成
 * 复用已有的 Claude Code 订阅，无需单独的 API 密钥
 * 通过设置 LCM_USE_CLI=true 启用
 * 
 * 递归防护：子进程环境设置 LCM_SUBPROCESS=1，避免子会话触发新一轮摘要
 * 三级降级策略与 SDK 路径的 summarize.ts 保持一致
 */

import { spawn } from 'node:child_process';
import type { LcmMessage } from './types.js';
import type { SummarizeMode } from './summarize.js';
import { deterministicTruncate } from './summarize.js';
import { estimateTokens } from './transcript-reader.js';

const CLAUDE_CLI = process.env['LCM_CLAUDE_CMD'] ?? 'claude';
const CLAUDE_MODEL = process.env['LCM_CLI_MODEL'] ?? 'inherit';
const TIMEOUT_MS = 8000;

// 摘要提示词模板，对应两种摘要模式
const PROMPTS: Record<SummarizeMode, string> = {
  preserve_details:
    'Summarize the key facts, decisions, code changes, file paths, and context from this conversation segment. Be concise but preserve important specifics:',
  bullet_points:
    'Summarize as concise bullet points. Include only: key decisions, file paths changed, and critical state. One bullet per fact:',
};

// 调用 Claude CLI 生成摘要的核心方法
export async function summarizeWithCLI(
  messages: LcmMessage[],
  options?: { mode?: SummarizeMode },
): Promise<string> {
  // 获取摘要模式，默认保留细节
  const mode = options?.mode ?? 'preserve_details';
  // 拼接对话消息，单条消息限制2000字符，避免过长
  const content = messages
    .map((m) => `[${m.role}]: ${m.content.slice(0, 2000)}`)
    .join('\n\n---\n\n');
  // 组装最终提示词
  const prompt = `${PROMPTS[mode]}\n\n${content}`;

  // 启动子进程调用 Claude CLI，返回 Promise
  return new Promise((resolve, reject) => {
    //  spawn 创建子进程，设置环境变量做递归防护
    const child = spawn(CLAUDE_CLI, ['-p', '--model', CLAUDE_MODEL], {
      env: { ...process.env, LCM_SUBPROCESS: '1' },
    });

    let output = '';
    let error = '';
    // 设置超时定时器，防止子进程卡死
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude -p timed out after 8s'));
    }, TIMEOUT_MS);

    // 向 CLI 写入提示词并结束输入流
    child.stdin.write(prompt);
    child.stdin.end();
    // 接收标准输出（摘要结果）
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    // 接收标准错误
    child.stderr.on('data', (d: Buffer) => { error += d.toString(); });
    // 子进程关闭后处理结果
    child.on('close', (code) => {
      clearTimeout(timer);
      // 退出码为0且有输出，返回摘要
      if (code === 0 && output.trim()) {
        resolve(output.trim());
      } else {
        // 调用失败，抛出错误
        reject(new Error(`claude -p failed (exit ${code}): ${error.slice(0, 200)}`));
      }
    });
  });
}

/**
 * 三级降级摘要策略：保证一定能生成有效的短摘要（强制收敛）
 * 在极端情况下，当输入消息过多且无法生成有效摘要时，使用确定性截断作为最后的降级策略，保证一定能生成一个长度受限的摘要，避免无限膨胀。
 * 通过简单地拼接消息内容并截断到指定的Token等效字符数，确保输出不会超过目标Token限制。 这种方法虽然不智能，但在没有其他选项时可以提供一个基本的摘要，保证系统的鲁棒性。
 */
export async function summarizeWithCLIEscalation(
  messages: LcmMessage[],
  targetTokens: number = 512,
): Promise<{ text: string; level: number }> {
  // 计算输入消息的总 Token 数
  const inputTokens = messages.reduce((sum, m) => sum + m.tokenCount, 0);

  // 第一级：保留细节的 AI 摘要
  const l1 = await summarizeWithCLI(messages, { mode: 'preserve_details' });
  if (estimateTokens(l1) < inputTokens) {
    return { text: l1, level: 1 };
  }

  // 第二级：精简要点的 AI 摘要
  const l2 = await summarizeWithCLI(messages, { mode: 'bullet_points' });
  if (estimateTokens(l2) < inputTokens) {
    return { text: l2, level: 2 };
  }

  /// 第三级：兜底强制截断（保证一定收敛，不会无限膨胀）
  const l3 = deterministicTruncate(messages, 512);
  return { text: l3, level: 3 };
}
