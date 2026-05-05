/**
// Claude Code钩子的主编排器
// 所有钩子处理器的入口点都调用这个函数
// 核心流程：1. 从标准输入(stdin)读取Claude Code钩子输入的JSON 2. 分发给对应的钩子处理函数 3. 将处理结果的JSON写入标准输出(stdout)
 */

import { getDb } from '../db/connection.js';
import { runMigrations } from '../db/migration.js';
import { loadConfig } from '../db/config.js';
import { ConversationStore } from '../core/conversation-store.js';
import { SummaryStore } from '../core/summary-store.js';
import { FileStore } from '../core/file-store.js';
import { logger } from '../utils/logger.js';
import type { HookInput, HookOutput } from '../core/types.js';
import fs from 'node:fs';

// hook运行时的完整上下文接口
export interface HookContext {
  // Claude Code传入的原始输入
  input: HookInput;
  // 会话存储实例：操作对话、消息
  conversationStore: ConversationStore;
  // 摘要存储实例：操作层级摘要、转录游标、上下文项
  summaryStore: SummaryStore;
  // 文件存储实例：操作大文件元数据
  fileStore: FileStore;
  // LCM的完整配置对象
  config: ReturnType<typeof loadConfig>;
}

export type HookHandler = (ctx: HookContext) => Promise<HookOutput>;
// main hook 编排函数
export async function runHook(handler: HookHandler): Promise<void> {
  let input: HookInput;
  try {
    const stdin = fs.readFileSync('/dev/stdin', 'utf8');
    input = JSON.parse(stdin);
  } catch {
    // 最小化输入的字段从环境变量或默认值获取，保证后续流程不会因为缺少输入而崩溃
    input = {
      // 优先从CLAUDE_SESSION_ID环境变量获取会话ID，否则用'unknown'
      session_id: process.env['CLAUDE_SESSION_ID'] ?? 'unknown',
      // 转录文件路径为空，后续消息摄入会直接跳过
      transcript_path: '',
      // 当前工作目录从process.cwd()获取
      cwd: process.cwd(),
      // 权限模式用'default'
      permission_mode: 'default',
      // hook 事件名称用'unknown'
      hook_event_name: 'unknown',
    };
  }

  // 加载LCM的完整配置
  const config = loadConfig();
  // 检查LCM是否启用：如果未启用（LCM_ENABLED=false），直接正常退出，不做任何处理
  if (!config.enabled) {
    process.exit(0);
  }

  // 获取单例SQLite数据库连接：保证整个应用生命周期内只有一个连接
  const db = getDb(config.databasePath);
  try {
    // 运行数据库迁移：初始化表结构或升级到最新版本
    runMigrations(db);
  } catch (err) {
    // 数据库迁移失败，记录错误日志，但不阻塞Claude Code的正常运行
    logger.error('Migration failed', err);
    process.exit(0); // Don't block Claude on DB errors
  }

  // 初始化三个核心存储实例：依赖注入同一个数据库连接，保证事务一致性
  const conversationStore = new ConversationStore(db);
  const summaryStore = new SummaryStore(db);
  const fileStore = new FileStore(db);

  // 组装完整的钩子上下文对象：包含所有钩子处理函数需要的资源
  const ctx: HookContext = { input, conversationStore, summaryStore, fileStore, config };

  // 声明钩子输出变量，初始化为空对象
  let output: HookOutput = {};
  try {
    // 调用传入的具体钩子处理函数：执行实际的钩子逻辑
    output = await handler(ctx);
  } catch (err) {
    // 钩子处理函数执行失败，记录错误日志，但不阻塞Claude Code的正常运行
    logger.error('Hook handler error', err);
  }

  // 检查钩子输出是否为空：只有非空输出才写入标准输出
  if (Object.keys(output).length > 0) {
    // 将输出对象序列化为JSON，追加换行符，写入标准输出
    process.stdout.write(JSON.stringify(output) + '\n');
  }
  process.exit(0);
}

