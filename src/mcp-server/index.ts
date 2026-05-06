#!/usr/bin/env node
/**
 * LCM MCP Server.
 *
 * 导入 lcm_grep, lcm_describe, lcm_expand, lcm_expand_query 作为MCP工具.
 */

// 导入MCP SDK的Server类：用于创建MCP服务器实例
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
// 导入MCP SDK的StdioServerTransport类：用于通过标准输入输出(stdin/stdout)与客户端通信
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// 导入MCP SDK的请求Schema：用于类型安全地处理ListTools和CallTool请求
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// 导入数据库连接模块：获取单例SQLite数据库连接
import { getDb } from '../db/connection.js';
// 导入数据库迁移模块：初始化/升级数据库表结构
import { runMigrations } from '../db/migration.js';
// 导入配置加载模块：从环境变量读取LCM的完整配置
import { loadConfig } from '../db/config.js';
// 导入核心存储类：会话存储、摘要存储、文件存储、任务存储
import { ConversationStore } from '../core/conversation-store.js';
import { SummaryStore } from '../core/summary-store.js';
import { FileStore } from '../core/file-store.js';
// 导入检索引擎：封装所有历史检索、摘要展开的核心逻辑
import { RetrievalEngine } from '../core/retrieval-engine.js';
import { TaskStore } from '../core/task-store.js';
// 导入MCP工具定义：包含所有工具的名称、描述、输入Schema、处理函数
import { tools } from './tools.js';
// 导入日志工具：记录调试、信息、错误日志
import { logger } from '../utils/logger.js';

// MCP服务器的主入口异步函数
async function main() {
  // 加载LCM的完整配置
  const config = loadConfig();
  // 获取单例SQLite数据库连接
  const db = getDb(config.databasePath);
  // 初始化表结构或升级到最新版本
  runMigrations(db);

  // 初始化所有核心存储实例：依赖注入同一个数据库连接
  const conversationStore = new ConversationStore(db);
  const summaryStore = new SummaryStore(db);
  const fileStore = new FileStore(db);
  // 初始化检索引擎：依赖注入会话存储和摘要存储
  const engine = new RetrievalEngine(conversationStore, summaryStore);
  // 初始化任务存储实例
  const taskStore = new TaskStore(db);
  // 组装工具上下文：包含所有工具处理函数需要的资源
  const toolCtx = { engine, conversationStore, config, fileStore, taskStore };

  // 创建MCP服务器实例：设置服务器名称、版本、能力（仅支持tools）
  const server = new Server(
    { name: 'lcm', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // 设置ListTools请求的处理器：当客户端请求工具列表时调用
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // 设置CallTool请求的处理器：当客户端调用具体工具时调用
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // 从请求参数中提取工具名和参数
    const { name, arguments: args } = request.params;
    // 根据工具名找到对应的工具定义
    const tool = tools.find((t) => t.name === name);

    // 如果找不到工具，返回错误
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      // 调用工具的处理函数：传入参数和工具上下文
      const result = await tool.handler(args ?? {}, toolCtx);
      // 返回工具执行结果：序列化为格式化的JSON
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      // 工具执行失败：记录错误日志，返回错误信息给客户端
      logger.error('Tool handler error', { tool: name, err: String(err) });
      return {
        content: [{ type: 'text', text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  });

  // 创建标准输入输出传输实例：用于与Claude Code等客户端通信
  const transport = new StdioServerTransport();
  // 连接服务器和传输：启动MCP服务
  await server.connect(transport);
  // 记录信息日志：说明MCP服务器已成功启动
  logger.info('LCM MCP server started');
}

// 启动主入口函数：捕获致命错误，记录日志后退出进程
main().catch((err) => {
  logger.error('MCP server fatal error', err);
  process.exit(1);
});
