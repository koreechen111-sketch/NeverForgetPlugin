/**
 * MCP tool definitions and handlers for LCM retrieval and self-managed compaction.
 * MCP tool.
 * 包含 lcm_grep、lcm_describe、lcm_expand、lcm_expand_query、lcm_llm_map、lcm_files、lcm_task_create、lcm_task_list、lcm_task_update 等工具
 */

// 导入核心类型：检索引擎、会话存储、任务存储、LCM配置、文件存储
import type { RetrievalEngine } from '../core/retrieval-engine.js';
import type { ConversationStore } from '../core/conversation-store.js';
import type { TaskStore } from '../core/task-store.js';
import type { LcmConfig } from '../db/config.js';
import type { FileStore } from '../core/file-store.js';
// 导入LLM批量处理工具
import { llmMap } from '../core/llm-map.js';
// 导入Node原生路径处理模块
import path from 'node:path';

// MCP工具运行时的完整上下文
export interface ToolContext {
  engine: RetrievalEngine;// 检索引擎实例：处理grep、describe、expand等核心检索
  conversationStore: ConversationStore;// 会话存储实例：操作会话、消息
  taskStore: TaskStore;// 任务存储实例：操作任务的创建、查询、更新
  config: LcmConfig;// LCM完整配置对象
  fileStore: FileStore;// 文件存储实例：操作大文件元数据
}

// MCP工具的标准定义结构
export interface ToolDefinition {
  name: string;// 工具名称，如lcm_grep
  description: string;// 工具功能描述，给LLM看的
  inputSchema: object;// 工具输入参数的JSON Schema定义
  handler: (args: Record<string, unknown>, ctx: ToolContext) => unknown | Promise<unknown>;
}

// 所有LCM MCP工具的完整定义数组
export const tools: ToolDefinition[] = [
  {
    // 工具1：lcm_grep - 全文检索LCM保存的完整对话历史
    name: 'lcm_grep',
    description:
      'Search the full conversation history preserved by LCM. Returns matching messages grouped by the summary node that currently covers them. Use an optional summary_id to restrict search to a specific summary\'s scope.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (full-text or keyword)',
        },
        conversation_id: {
          type: 'string',
          description: 'Limit search to a specific conversation ID (optional)',
        },
        summary_id: {
          type: 'string',
          description: 'Restrict search to messages within this summary\'s scope (optional)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (1-200, default 20)',
          minimum: 1,
          maximum: 200,
        },
      },
      required: ['query'],
    },
    // lcm_grep的处理函数
    handler(args, { engine }) {
      // 提取并校验输入参数
      const query = args['query'] as string;
      const conversationId = args['conversation_id'] as string | undefined;
      const summaryId = args['summary_id'] as string | undefined;
      const limit = Math.min(200, Math.max(1, (args['limit'] as number | undefined) ?? 20));

      // 调用检索引擎的grep方法执行搜索
      const results = engine.grep(query, conversationId, limit, summaryId);
      if (results.length === 0) {
        return { found: false, message: `No results found for: ${query}` };
      }

      // 按覆盖摘要分组结果（符合LCM论文规范）
      const groups = new Map<string, typeof results>();
      for (const r of results) {
        const key = r.coveringSummaryId ?? '__uncovered__';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }

      // 组装并返回分组后的结果
      return {
        found: true,
        count: results.length,
        groups: Array.from(groups.entries()).map(([key, matches]) => ({
          summaryId: key === '__uncovered__' ? null : key,
          matches: matches.map((r) => ({
            id: r.messageId,
            role: r.role,
            content: r.content.length > 500 ? r.content.slice(0, 500) + '…' : r.content,
            timestamp: new Date(r.timestamp).toISOString(),
            sequence: r.sequenceNumber,
            conversationId: r.conversationId,
          })),
        })),
      };
    },
  },

  // 工具2：lcm_describe - 根据ID获取特定摘要或消息的元数据和内容
  {
    name: 'lcm_describe',
    description:
      'Get metadata and content for a specific LCM summary or message by its ID. Use after lcm_grep to inspect a specific item.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The ID of the summary (sum_...) or message (msg_...) to describe',
        },
      },
      required: ['id'],
    },
    // lcm_describe的处理函数
    handler(args, { engine }) {
      const id = args['id'] as string;
      const result = engine.describe(id);
      if (!result) {
        return { found: false, message: `No item found with ID: ${id}` };
      }
      return { found: true, ...result };
    },
  },

  // 工具3：lcm_expand - 检索压缩成摘要的原始消息
  {
    name: 'lcm_expand',
    description:
      'Retrieve the original messages that were compacted into a summary. Use when you need full details behind a summary. When delegating sub-tasks, consider using lcm_task_create to track scope reduction before expanding.',
    inputSchema: {
      type: 'object',
      properties: {
        summary_id: {
          type: 'string',
          description: 'The summary ID (sum_...) to expand',
        },
        depth: {
          type: 'number',
          description: 'How many levels of summaries to expand (default 1, max 5)',
          minimum: 1,
          maximum: 5,
        },
        token_cap: {
          type: 'number',
          description: 'Maximum tokens to return (default 8000)',
        },
      },
      required: ['summary_id'],
    },
    // lcm_expand的处理函数
    handler(args, { engine }) {
      const summaryId = args['summary_id'] as string;
      const depth = Math.min(5, Math.max(1, (args['depth'] as number | undefined) ?? 1));
      const tokenCap = (args['token_cap'] as number | undefined) ?? 8000;

      const result = engine.expand(summaryId, depth, tokenCap);
      return {
        summaryId: result.summaryId,
        messageCount: result.messages.length,
        truncated: result.truncated,
        totalTokens: result.totalTokens,
        messages: result.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: new Date(m.timestamp).toISOString(),
          sequence: m.sequenceNumber,
        })),
        childSummaries: result.childSummaries.map((s) => ({
          id: s.id,
          level: s.level,
          content: s.content.length > 200 ? s.content.slice(0, 200) + '…' : s.content,
        })),
      };
    },
  },

  // 工具4：lcm_expand_query - 搜索内容并立即展开相关摘要
  {
    name: 'lcm_expand_query',
    description:
      'Search for content and immediately expand the relevant summaries to retrieve original messages. Combines lcm_grep and lcm_expand in one step.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to find relevant conversation history',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of summary expansions (default 3)',
          minimum: 1,
          maximum: 10,
        },
        token_cap: {
          type: 'number',
          description: 'Total token budget for results (default 8000)',
        },
      },
      required: ['query'],
    },
    // lcm_expand_query的处理函数
    handler(args, { engine }) {
      const query = args['query'] as string;
      const maxResults = Math.min(10, Math.max(1, (args['max_results'] as number | undefined) ?? 3));
      const tokenCap = (args['token_cap'] as number | undefined) ?? 8000;

      const results = engine.expandQuery(query, maxResults, tokenCap);
      if (results.length === 0) {
        return { found: false, message: `No history found for: ${query}` };
      }

      return {
        found: true,
        expansions: results.map((r) => ({
          summaryId: r.summaryId,            // null when direct message match
          isFallback: r.isFallback ?? false,
          messageCount: r.messages.length,
          truncated: r.truncated,
          messages: r.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: new Date(m.timestamp).toISOString(),
          })),
        })),
      };
    },
  },

  // 工具5：lcm_llm_map - 通过LLM提示模板批量处理JSONL文件
  {
    name: 'lcm_llm_map',
    description:
      'Process each line of an input JSONL file through an LLM prompt template and write results to an output JSONL file. Each line is substituted into {{line}} in the prompt template. Supports concurrency control and optional JSON Schema validation of responses. Requires LCM_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY to be configured.',
    inputSchema: {
      type: 'object',
      properties: {
        input_path: {
          type: 'string',
          description: 'Absolute path to the input JSONL file (one record per line)',
        },
        prompt_template: {
          type: 'string',
          description: 'Prompt template with {{line}} placeholder that will be replaced by each input line',
        },
        output_path: {
          type: 'string',
          description: 'Absolute path for the output JSONL file (default: input_path with .out.jsonl suffix)',
        },
        model: {
          type: 'string',
          description: 'Anthropic model to use (default: claude-haiku-4-5-20251001)',
        },
        max_concurrency: {
          type: 'number',
          description: 'Maximum number of concurrent API calls (1-20, default 5)',
          minimum: 1,
          maximum: 20,
        },
        output_schema: {
          type: 'object',
          description: 'Optional JSON Schema to validate each response. If provided, responses are parsed as JSON and validated. On failure, one retry is attempted.',
        },
      },
      required: ['input_path', 'prompt_template'],
    },
    // lcm_llm_map的异步处理函数
    async handler(args, ctx) {
      // 检查API Key是否配置
      const apiKey = ctx.config.anthropicApiKey;
      if (!apiKey) {
        throw new Error(
          'No Anthropic API key configured. Set LCM_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY environment variable.'
        );
      }

      // 提取输入参数
      const inputPath = args['input_path'] as string;
      const promptTemplate = args['prompt_template'] as string;
      // 生成默认输出路径：输入路径同目录，后缀改为.out.jsonl
      const outputPath =
        (args['output_path'] as string | undefined) ??
        path.join(path.dirname(inputPath), path.basename(inputPath, path.extname(inputPath)) + '.out.jsonl');
      const model = args['model'] as string | undefined;
      const maxConcurrency = args['max_concurrency'] as number | undefined;
      const outputSchema = args['output_schema'] as Record<string, unknown> | undefined;

      
      // 调用核心llmMap工具执行批量处理
      return llmMap({
        inputPath,
        outputPath,
        promptTemplate,
        model,
        maxConcurrency,
        outputSchema,
        apiKey,
      });
    },
  },

  // 工具6：lcm_files - 列出和查询对话中检测到的大文件
  {
    name: 'lcm_files',
    description:
      'List and query large files detected during conversation. Returns exploration summaries — structural overviews of files that were too large to keep in context.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'Return details for a specific file by its ID (file_...)',
        },
        conversation_id: {
          type: 'string',
          description: 'List all large files detected in a specific conversation',
        },
        query: {
          type: 'string',
          description: 'Search file paths by simple string match',
        },
      },
    },
    // lcm_files的处理函数
    handler(args, { fileStore }) {
      const fileId = args['file_id'] as string | undefined;
      const conversationId = args['conversation_id'] as string | undefined;
      const query = args['query'] as string | undefined;

      // 按文件ID查询单个文件详情
      if (fileId) {
        const file = fileStore.getFile(fileId);
        if (!file) {
          return { found: false, message: `No file found with ID: ${fileId}` };
        }
        return { found: true, file };
      }

      // 按会话ID列出所有大文件
      if (conversationId) {
        const files = fileStore.getFilesForConversation(conversationId);
        return {
          found: files.length > 0,
          count: files.length,
          files,
        };
      }

      // 仅提供query时提示需要同时提供conversation_id
      if (query) {
        return {
          found: false,
          message: 'To search by query, please also provide a conversation_id',
        };
      }

      // 未提供任何有效参数时返回提示
      return { found: false, message: 'Provide file_id, conversation_id, or query' };
    },
  },

  // 工具7：lcm_task_create - 创建任务以跟踪委托工作
  {
    name: 'lcm_task_create',
    description:
      'Create a task to track delegated work. When delegating to sub-agents, specify delegated_scope (what you hand off) and kept_work (what you retain) to maintain scope reduction.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'The conversation ID this task belongs to',
        },
        title: {
          type: 'string',
          description: 'Short title for the task',
        },
        description: {
          type: 'string',
          description: 'Detailed description of the task (optional)',
        },
        parent_id: {
          type: 'string',
          description: 'Parent task ID for subtasks (optional)',
        },
        delegated_scope: {
          type: 'string',
          description: 'Description of work being handed off to a sub-agent (optional)',
        },
        kept_work: {
          type: 'string',
          description: 'Description of work retained by this agent (optional)',
        },
      },
      required: ['conversation_id', 'title'],
    },
    // lcm_task_create的处理函数
    handler(args, { taskStore }) {
      const task = taskStore.createTask({
        conversationId: args['conversation_id'] as string,
        title: args['title'] as string,
        description: args['description'] as string | undefined,
        parentId: args['parent_id'] as string | undefined,
        delegatedScope: args['delegated_scope'] as string | undefined,
        keptWork: args['kept_work'] as string | undefined,
      });
      return task;
    },
  },

  // 工具8：lcm_task_list - 列出任务，支持按会话、状态、父任务筛选
  {
    name: 'lcm_task_list',
    description: 'List tasks for tracking delegated work. Filter by conversation, status, or parent task.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Filter by conversation ID (optional)',
        },
        status: {
          type: 'string',
          description: 'Filter by status: pending, in_progress, completed, failed, cancelled (optional)',
        },
        parent_id: {
          type: 'string',
          description: 'Filter by parent task ID to list subtasks (optional)',
        },
      },
    },
    // lcm_task_list的处理函数
    handler(args, { taskStore }) {
      const tasks = taskStore.listTasks({
        conversationId: args['conversation_id'] as string | undefined,
        status: args['status'] as string | undefined,
        parentId: args['parent_id'] as string | undefined,
      });
      return { count: tasks.length, tasks };
    },
  },

  // 工具9：lcm_task_update - 更新任务状态或结果
  {
    name: 'lcm_task_update',
    description: 'Update a task status or result. Use to mark tasks completed, failed, or record results.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The task ID to update',
        },
        status: {
          type: 'string',
          description: 'New status: pending, in_progress, completed, failed, cancelled (optional)',
        },
        result: {
          type: 'string',
          description: 'Result or outcome of the task (optional)',
        },
        delegated_scope: {
          type: 'string',
          description: 'Updated delegated scope description (optional)',
        },
        kept_work: {
          type: 'string',
          description: 'Updated kept work description (optional)',
        },
      },
      required: ['task_id'],
    },
    // lcm_task_update的处理函数
    handler(args, { taskStore }) {
      const task = taskStore.updateTask(args['task_id'] as string, {
        status: args['status'] as string | undefined,
        result: args['result'] as string | undefined,
        delegatedScope: args['delegated_scope'] as string | undefined,
        keptWork: args['kept_work'] as string | undefined,
      });
      if (!task) {
        return { found: false, message: `No task found with ID: ${args['task_id']}` };
      }
      return task;
    },
  },

];
