/**
 * llm_map - 读取 JSONL文件的每一行，通过Anthropic API调用模型
 * 使用提示模板生成结果，最终将所有处理结果写入新的JSONL输出文件 
*/

import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Semaphore：并发控制器，限制最大并行任务数，防止API调用超限
// ---------------------------------------------------------------------------

export class Semaphore {
  private max: number;        // 最大并发数
  private current: number = 0; // 当前正在执行的任务数
  private queue: Array<() => void> = []; // 等待队列

  constructor(max: number) {
    this.max = max;
  }

  // 获取Semaphore：并发未满则直接执行，否则加入等待队列
  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    // 达到最大并发，返回Promise等待释放
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  // 释放Semaphore：执行队列下一个任务，或减少当前并发计数
  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.current--;
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmMapOptions {
  inputPath: string;          // 输入JSONL文件路径
  outputPath: string;         // 输出JSONL文件路径
  promptTemplate: string;     // 提示词模板，包含{{line}}占位符
  model?: string;             // 模型名称，默认inherit
  maxConcurrency?: number;    // 最大并发数，默认5，最大20
  outputSchema?: Record<string, unknown>; // 可选：输出JSON Schema校验规则
  apiKey: string;             // Anthropic API密钥
}

export interface LlmMapResult {
  processed: number;          // 总行数
  succeeded: number;          // 成功处理数
  failed: number;             // 失败处理数
  errors: Array<{ line: number; error: string }>; // 错误详情（行号+原因）
  outputPath: string;         // 输出文件路径
}

// ---------------------------------------------------------------------------
// Schema 校验器 (basic type/required check)
// ---------------------------------------------------------------------------

function validateSchema(data: unknown, schema: Record<string, unknown>): string | null {
  // 基础校验：必须是对象
  if (typeof data !== 'object' || data === null) {
    return 'Response is not a JSON object';
  }

  const obj = data as Record<string, unknown>;

  // 校验1：检查必填字段是否存在
  const required = schema['required'];
  if (Array.isArray(required)) {
    for (const field of required) {
      if (!(field in obj)) {
        return `Missing required field: ${field}`;
      }
    }
  }

  // 校验2：检查字段类型是否匹配
  const properties = schema['properties'];
  if (properties && typeof properties === 'object') {
    const props = properties as Record<string, Record<string, unknown>>;
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in obj && propSchema['type']) {
        const expectedType = propSchema['type'] as string;
        const actualType = Array.isArray(obj[key]) ? 'array' : typeof obj[key];
        if (actualType !== expectedType) {
          return `Field "${key}" should be ${expectedType}, got ${actualType}`;
        }
      }
    }
  }

  // 校验通过
  return null;
}

// ---------------------------------------------------------------------------
// Core function：批量执行LLM处理
// ---------------------------------------------------------------------------

export async function llmMap(options: LlmMapOptions): Promise<LlmMapResult> {
  // 配置解构与默认值设置
  const {
    inputPath,
    outputPath,
    promptTemplate,
    model = 'inherit',
    maxConcurrency = 5,
    outputSchema,
    apiKey,
  } = options;

  // 并发数安全限制：1~20之间
  const concurrency = Math.min(20, Math.max(1, maxConcurrency));

  // 读取输入文件，过滤空行
  const inputContent = fs.readFileSync(inputPath, 'utf-8');
  const lines = inputContent.split('\n').filter((l) => l.trim() !== '');

  // 初始化Anthropic客户端 + 并发信号量
  const client = new Anthropic({ apiKey });
  const semaphore = new Semaphore(concurrency);

  // 存储所有行的处理结果
  const results: Array<{ lineIndex: number; output: string | null; error: string | null }> = new Array(lines.length);
  // 存储错误详情
  const errors: Array<{ line: number; error: string }> = [];

  // 处理单行数据：核心执行单元
  async function processLine(lineContent: string, lineIndex: number): Promise<void> {
    // 获取并发许可
    await semaphore.acquire();
    try {
      // 替换提示模板中的{{line}}占位符
      const prompt = promptTemplate.replace(/\{\{line\}\}/g, lineContent);
      let responseText: string;

      // 分支1：配置了Schema校验 → 强制JSON输出 + 重试机制
      if (outputSchema) {
        // 追加指令：仅返回合法JSON，无解释、无Markdown
        const schemaPrompt = `${prompt}\n\nRespond with valid JSON only. No markdown, no explanation.`;

        // 首次调用API
        const firstResponse = await client.messages.create({
          model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: schemaPrompt }],
        });

        const firstText = extractText(firstResponse);
        const firstParsed = tryParseJson(firstText);

        // 首次调用校验通过
        if (firstParsed !== null) {
          const validationError = validateSchema(firstParsed, outputSchema);
          if (validationError === null) {
            responseText = firstText;
          } else {
            // 校验失败：携带错误信息重试1次
            const retryResponse = await client.messages.create({
              model,
              max_tokens: 1024,
              messages: [
                { role: 'user', content: schemaPrompt },
                { role: 'assistant', content: firstText },
                {
                  role: 'user',
                  content: `The previous response had a validation error: ${validationError}. Please fix and respond with valid JSON only.`,
                },
              ],
            });
            const retryText = extractText(retryResponse);
            const retryParsed = tryParseJson(retryText);
            
            // 重试后二次校验
            if (retryParsed === null) throw new Error(`Retry response was not valid JSON`);
            const retryValidationError = validateSchema(retryParsed, outputSchema);
            if (retryValidationError !== null) throw new Error(`Retry failed schema validation: ${retryValidationError}`);
            
            responseText = retryText;
          }
        } else {
          // 首次返回非JSON：重试1次
          const retryResponse = await client.messages.create({
            model,
            max_tokens: 1024,
            messages: [
              { role: 'user', content: schemaPrompt },
              { role: 'assistant', content: firstText },
              { role: 'user', content: `Previous response was invalid JSON. Return valid JSON only.`, },
            ],
          });
          const retryText = extractText(retryResponse);
          const retryParsed = tryParseJson(retryText);
          
          if (retryParsed === null) throw new Error(`Retry response was not valid JSON`);
          const retryValidationError = validateSchema(retryParsed, outputSchema);
          if (retryValidationError !== null) throw new Error(`Retry failed schema validation: ${retryValidationError}`);
          
          responseText = retryText;
        }
      } else {
        // 分支2：无Schema → 普通文本调用
        const response = await client.messages.create({
          model,
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        });
        responseText = extractText(response);
      }

      // 记录成功结果
      results[lineIndex] = { lineIndex, output: responseText, error: null };
    } catch (err) {
      // 记录失败结果
      const errorMsg = err instanceof Error ? err.message : String(err);
      results[lineIndex] = { lineIndex, output: null, error: errorMsg };
      errors.push({ line: lineIndex + 1, error: errorMsg });
    } finally {
      // 无论成功失败，释放信号量
      semaphore.release();
    }
  }

  // 2. 并发执行所有行处理（信号量控制实际并发数）
  await Promise.all(lines.map((line, i) => processLine(line, i)));

  // 3. 组装输出JSONL内容
  const outputLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const r = results[i];
    if (r.error !== null) {
      // 失败行：记录输入+错误
      outputLines.push(JSON.stringify({ input: lines[i], output: null, error: r.error }));
    } else {
      // 成功行：记录输入+输出
      outputLines.push(JSON.stringify({ input: lines[i], output: r.output }));
    }
  }

  // 写入输出文件
  fs.writeFileSync(outputPath, outputLines.join('\n') + (outputLines.length > 0 ? '\n' : ''));

  // 统计结果
  const succeeded = results.filter((r) => r?.error === null).length;
  const failed = results.filter((r) => r?.error !== null).length;

  // 返回最终统计
  return {
    processed: lines.length,
    succeeded,
    failed,
    errors,
    outputPath,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// 从Anthropic API响应中提取文本内容
function extractText(response: Anthropic.Message): string {
  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock && textBlock.type === 'text' ? textBlock.text : '';
}

// 安全解析JSON：失败返回null，不抛异常
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}