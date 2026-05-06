# Never Forget Plugin 软件设计文档

**版本**: 1.0.1
**更新日期**: 2026-05-05

---

## 1. 概述

NeverForget 是一个 Claude Code 插件，通过 SQLite + WAL 模式持久化存储每条对话消息并建立 FTS5 全文索引，在上下文压缩时采用层次 DAG 结构捕获摘要（支持多级压缩与展开），同时提供 MCP 工具让 AI 能够按需检索和恢复被压缩的原始上下文，实现真正的无损上下文管理。

### 1.1 核心目标

- **无损持久化**: 将每个会话中的每条消息存储到 SQLite 数据库
- **跨会话记忆**: 压缩后的摘要可在新会话中恢复
- **上下文恢复**: 在 Claude 内置压缩后重新注入丢失的上下文
- **可检索历史**: 通过 MCP 工具搜索和展开历史消息

### 1.2 技术栈

- **语言**: TypeScript (ES Modules)
- **数据库**: SQLite (使用 `node:sqlite`)
- **LLM API**: Anthropic SDK (`@anthropic-ai/sdk`)
- **MCP 协议**: `@modelcontextprotocol/sdk`

---

## 2. 架构

### 2.1 目录结构

```
src/
├── core/                    # 核心业务逻辑
│   ├── conversation-store.ts    # 对话存储
│   ├── summary-store.ts         # 摘要存储
│   ├── file-store.ts            # 大文件存储
│   ├── task-store.ts            # 任务存储
│   ├── transcript-reader.ts     # 转录读取（增量）
│   ├── retrieval-engine.ts      # 检索引擎
│   ├── summarize.ts             # 摘要生成
│   ├── condense.ts              # 摘要压缩（DAG）
│   ├── context-assembler.ts     # 上下文组装
│   ├── file-analyzer.ts         # 文件分析
│   ├── llm-map.ts               # 批量 LLM 处理
│   └── types.ts                 # 核心类型定义
├── hook-handlers/            # Claude Code Hook 处理程序
│   ├── orchestrator.ts          # Hook 编排器
│   ├── session-start.ts         # 会话启动
│   ├── user-prompt-submit.ts    # 用户提交
│   ├── pre-compact.ts           # 压缩前
│   ├── post-compact.ts          # 压缩后
│   ├── stop.ts                  # 会话停止
│   └── ingest.ts                # 消息摄入
├── mcp-server/               # MCP 服务器
│   ├── index.ts                 # 服务器入口
│   └── tools.ts                 # 工具定义
├── db/                       # 数据库层
│   ├── connection.ts            # 数据库连接
│   ├── migration.ts             # 迁移脚本
│   └── config.ts                # 配置管理
└── utils/
    └── logger.ts               # 日志工具
```

### 2.2 数据流

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Claude Code 生命周期                           │
└──────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              [SessionStart]  [UserPrompt]   [PreCompact]
                    │               │               │
                    ▼               ▼               ▼
              ┌─────────────────────────────────────────────┐
              │            转录文件 (JSONL)                  │
              │         transcript_path                     │
              └─────────────────────────────────────────────┘
                    │               │               │
                    ▼               ▼               ▼
              ┌─────────────────────────────────────────────┐
              │         增量读取 (transcript-reader.ts)     │
              │         只读取新增行，跟踪字节偏移            │
              └─────────────────────────────────────────────┘
                    │               │               │
                    ▼               ▼               ▼
              ┌─────────────────────────────────────────────┐
              │            ConversationStore                 │
              │         消息存储到 SQLite                    │
              └─────────────────────────────────────────────┘
                    │               │               │
                    ▼               ▼               ▼
              ┌─────────────────────────────────────────────┐
              │            PostCompact Hook                  │
              │  1. 捕获 Claude 生成的压缩摘要                │
              │  2. 组装上下文并重新注入                      │
              └─────────────────────────────────────────────┘
```

---

## 3. 数据库设计

### 3.1 核心表结构

| 表名 | 用途 | 关键字段 |
|------|------|----------|
| `conversations` | 每个会话+项目一条记录 | session_id, project_path |
| `messages` | 所有消息（完整存储） | conversation_id, role, content, token_count |
| `summaries` | 分层摘要树 | conversation_id, parent_id, level, message_range_start/end |
| `summary_messages` | 摘要-消息关联表 | summary_id, message_id |
| `context_items` | 重要决策/事实 | category, importance |
| `transcript_cursors` | 增量读取位置 | session_id, byte_offset, last_timestamp |
| `files` | 大文件元数据 | message_id, file_type, content_preview |
| `tasks` | 子任务跟踪 | parent_id, status, delegated_scope |

### 3.2 索引策略

```sql
-- 转录增量读取优化
CREATE INDEX idx_transcript_cursors ON transcript_cursors(session_id);

-- 消息查询优化
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_sequence ON messages(conversation_id, sequence_number);

-- 摘要查询优化
CREATE INDEX idx_summaries_conversation ON summaries(conversation_id);
CREATE INDEX idx_summaries_level ON summaries(conversation_id, level);

-- FTS 全文搜索
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content=messages, content_rowid=rowid);
```

### 3.3 FTS5 触发器

```sql
-- 插入时同步
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
BEGIN INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content); END;

-- 更新时同步
CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

---

## 4. 核心组件

### 4.1 TranscriptReader（增量读取）

**职责**: 读取 Claude Code 的 JSONL 转录文件，只处理新消息。

```typescript
interface TranscriptCursor {
  sessionId: string;
  byteOffset: number;      // 上次读取位置
  lastTimestamp: number;   // 最后消息时间戳
}

function readNewTranscriptEntries(
  transcriptPath: string,
  cursor: TranscriptCursor
): { messages: ParsedMessage[]; updatedCursor: TranscriptCursor }
```

**特性**:
- 按字节偏移量增量读取，避免重复处理
- 解析多种消息类型：`user`, `assistant`, `system`, `tool_use`, `tool_result`
- Token 估算：`length / 4`（每 4 字符约 1 token）

### 4.2 ConversationStore（对话存储）

**职责**: 管理对话和消息的 CRUD 操作。

```typescript
class ConversationStore {
  getOrCreateConversation(sessionId: string, projectPath: string): LcmConversation;
  insertMessage(msg: Omit<LcmMessage, 'id' | 'sequenceNumber'>): LcmMessage;
  getMessages(conversationId: string, fromSeq?: number, toSeq?: number): LcmMessage[];
  search(query: string, conversationId?: string, limit?: number): LcmMessage[];
}
```

**FTS 降级**: 如果 FTS5 失败，回退到 LIKE 搜索。

### 4.3 SummaryStore（摘要存储）

**职责**: 管理分层摘要树和摘要-消息关联。

```typescript
class SummaryStore {
  insertSummary(summary: Omit<LcmSummary, 'id' | 'createdAt'>): LcmSummary;
  linkSummaryToMessages(summaryId: string, messageIds: string[]): void;
  getSummariesForConversation(conversationId: string, level?: number): LcmSummary[];
  getChildSummaries(parentId: string): LcmSummary[];
  getUncondensedSummaries(conversationId: string, level: number): LcmSummary[];
}
```

### 4.4 RetrievalEngine（检索引擎）

**职责**: 搜索、描述和展开历史消息。

```typescript
class RetrievalEngine {
  grep(query: string, conversationId?: string, limit?: number, summaryId?: string): GrepResult[];
  describe(id: string): DescribeResult | null;
  expand(summaryId: string, depth?: number, tokenCap?: number): ExpandResult;
  expandQuery(query: string, maxResults?: number, tokenCap?: number): ExpandResult[];
}
```

**展开策略**:
- **深度 > 1**: 递归展开子摘要直到获取底层消息
- **Token 预算**: 遵守 tokenCap，防止返回过多内容
- **截断标记**: 当内容超出预算时设置 `truncated: true`

### 4.5 Summarizer（摘要生成）

**职责**: 使用 LLM 生成层次化摘要。

```typescript
async function summarizeWithEscalation(
  messages: LcmMessage[],
  apiKey: string,
  targetTokens: number = 512
): Promise<{ text: string; level: number }>
```

**三级升级策略**:
1. **Level 1**: `preserve_details` 模式（目标 token 数）
2. **Level 2**: `bullet_points` 模式（目标 token / 2）
3. **Level 3**: 确定性截断（保证收敛）

---

## 5. Hook 处理程序

### 5.1 Hook 编排器 (orchestrator.ts)

所有 hook 处理程序的统一入口：

```typescript
export async function runHook(handler: HookHandler): Promise<void> {
  // 1. 从 stdin 读取 hook 输入
  // 2. 加载配置
  // 3. 运行数据库迁移
  // 4. 创建存储实例
  // 5. 执行 handler
  // 6. 输出 JSON 到 stdout
}
```

### 5.2 SessionStart Hook

**触发时机**: 会话启动时

**功能**:
1. 摄入转录中已有的消息（恢复的会话）
2. 查找并注入之前的摘要上下文

**输出**: `hookSpecificOutput` 包含 `additionalContext`

### 5.3 PreCompact Hook

**触发时机**: Claude 内置压缩之前（同步）

**功能**: 最终消息快照，确保所有消息持久化到 SQLite

### 5.4 PostCompact Hook

**触发时机**: Claude 内置压缩之后（同步）

**功能**:
1. 捕获 Claude 生成的压缩摘要（免费，使用订阅）
2. 将累积的摘要重新注入为 `systemMessage`

### 5.5 Stop Hook

**触发时机**: 会话结束时

**功能**: 创建细粒度摘要（使用 Haiku），便于跨会话恢复

---

## 6. MCP 工具

### 6.1 工具列表

| 工具名 | 描述 | 主要参数 |
|--------|------|----------|
| `lcm_grep` | 全文搜索对话历史 | query, conversation_id, summary_id, limit |
| `lcm_describe` | 获取摘要/消息元数据 | id |
| `lcm_expand` | 展开摘要获取原始消息 | summary_id, depth, token_cap |
| `lcm_expand_query` | 搜索+展开组合 | query, max_results, token_cap |
| `lcm_llm_map` | 批量处理 JSONL | input_path, prompt_template |
| `lcm_files` | 查询大文件信息 | file_id, conversation_id |
| `lcm_task_*` | 子任务管理 | create, list, update |

### 6.2 搜索结果分组

`lcm_grep` 返回按覆盖摘要分组的结果：

```json
{
  "groups": [
    {
      "summaryId": "sum_xxx",
      "matches": [
        { "id": "msg_yyy", "role": "user", "content": "..." }
      ]
    }
  ]
}
```

---

## 7. 配置

### 7.1 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `LCM_DB_PATH` | `~/.lcm/lcm.db` | 数据库文件路径 |
| `LCM_ENABLED` | `true` | 是否启用 LCM |
| `LCM_FRESH_TAIL_COUNT` | `32` | 压缩保护的新消息数 |
| `LCM_POST_COMPACT_TOKENS` | `3000` | PostCompact 注入的 token 上限 |
| `LCM_ANTHROPIC_API_KEY` | - | 细粒度摘要 API 密钥 |
| `LCM_GRANULAR_THRESHOLD` | `20000` | 触发细粒度摘要的阈值 |
| `LCM_USE_CLI` | `true` | 是否使用 CLI 摘要器 |
| `LCM_CONDENSATION_THRESHOLD` | `5` | 触发摘要压缩的 level-0 数量 |
| `LCM_LARGE_FILE_THRESHOLD` | `25000` | 大文件检测阈值（token） |

### 7.2 数据库配置

```typescript
db.exec('PRAGMA journal_mode=WAL');      // WAL 模式支持并发
db.exec('PRAGMA busy_timeout=5000');     // 5秒锁等待
db.exec('PRAGMA foreign_keys=ON');       // 外键约束
db.exec('PRAGMA synchronous=NORMAL');    // 平衡持久性和性能
```

---

## 8. 错误处理

### 8.1 原则

- **不阻塞 Claude**: 数据库错误不应阻止 Claude Code 运行
- **静默失败**: hook 处理中的非致命错误只记录日志
- **降级策略**: FTS 失败回退到 LIKE 搜索

### 8.2 日志级别

- `error`: 迁移失败、hook 处理异常
- `warn`: 消息插入失败、大文件存储失败
- `info`: 压缩事件、摘要创建
- `debug`: 消息摄入、Cursor 更新

---

## 9. 类型定义

### 9.1 核心类型

```typescript
type MessageRole = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';

interface LcmMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  tokenCount: number;
  sequenceNumber: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface LcmSummary {
  id: string;
  conversationId: string;
  parentId: string | null;
  level: number;          // 0 = 叶节点，1+ = 压缩的
  content: string;
  tokenCount: number;
  messageRangeStart: number;
  messageRangeEnd: number;
  createdAt: number;
}
```

### 9.2 Hook I/O

```typescript
interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  // ... 其他 hook 特定字段
}

interface HookOutput {
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
  };
}
```

---

## 10. 构建和测试

### 10.1 构建

```bash
npm run build       # 使用 esbuild 编译 TypeScript
npm run build:watch # 监听模式
```

### 10.2 测试

```bash
npm test            # 运行 vitest 测试
```

### 10.3 输出

- 构建输出到 `dist/` 目录
- MCP 服务器入口: `dist/mcp-server/index.js`
