import path from 'node:path';
import os from 'node:os';

export interface LcmConfig {
  // SQLite数据库文件的完整存储路径
  databasePath: string;
  /** Number of recent messages protected from compaction */
  freshTailCount: number;
  // PostCompact钩子中注入到LLM上下文的最大Token数
  postCompactInjectionTokens: number;
  // LCM功能是否启用
  enabled: boolean;
  // 用于细粒度压缩的Anthropic API密钥（可选）
  anthropicApiKey: string | null;
  // 触发细粒度摘要的Token阈值
  granularCompactThreshold: number;
  // 触发DAG层级压缩的未压缩level-0摘要数量阈值
  condensationThreshold: number;
  // 工具结果消息被视为大文件的Token阈值
  largeFileThreshold: number;
}

function defaultDbPath(): string {
  return path.join(os.homedir(), '.lcm', 'lcm.db');
}

export function loadConfig(): LcmConfig {
  return {
    // 数据库路径：优先环境变量，否则调用defaultDbPath生成
    databasePath: process.env['LCM_DB_PATH'] ?? defaultDbPath(),
    // 新鲜尾部数量：环境变量转数字，默认32
    freshTailCount: parseInt(process.env['LCM_FRESH_TAIL_COUNT'] ?? '32', 10),
    // 压缩后注入Token数：环境变量转数字，默认3000
    postCompactInjectionTokens: parseInt(process.env['LCM_POST_COMPACT_TOKENS'] ?? '3000', 10),
    // 启用状态：环境变量不是'false'就启用，默认true
    enabled: (process.env['LCM_ENABLED'] ?? 'true') !== 'false',
    // API密钥：优先LCM专用的，其次通用的，否则null
    anthropicApiKey: process.env['LCM_ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_API_KEY'] ?? null,
    // 细粒度压缩阈值：环境变量转数字，默认20000
    granularCompactThreshold: parseInt(process.env['LCM_GRANULAR_THRESHOLD'] ?? '20000', 10),
    // CLI摘要器启用状态：环境变量不是'false'就启用，默认true
    useCliSummarizer: (process.env['LCM_USE_CLI'] ?? 'true') !== 'false',
    // DAG压缩阈值：环境变量转数字，默认5
    condensationThreshold: parseInt(process.env['LCM_CONDENSATION_THRESHOLD'] ?? '5', 10),
    // 大文件阈值：环境变量转数字，默认25000
    largeFileThreshold: parseInt(process.env['LCM_LARGE_FILE_THRESHOLD'] ?? '25000', 10),
  };
}
