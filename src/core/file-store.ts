import type { Db } from '../db/connection.js';
import type { LcmFile, FileType } from './types.js';
import { randomUUID } from 'node:crypto';

/**
 * 数据库文件表行结构
 * 与SQLite files表字段映射（下划线命名）
 */
interface FileRow {
  id: string;                      // 文件唯一ID
  message_id: string;               // 关联的消息ID
  conversation_id: string;          // 关联的对话ID
  file_path: string | null;         // 文件本地路径（可选）
  file_type: string;                // 文件类型（json/code/sql/text等）
  raw_token_count: number;          // 文件原始内容Token数
  content_preview: string;          // 文件内容预览片段
  exploration_summary: string | null; // 结构化摘要（可选）
  created_at: number;               // 创建时间戳
}

/**
 * 数据库行对象 转换为 业务层文件实体
 * 下划线命名 → 驼峰命名，数据层与业务层解耦
 */
function rowToFile(row: FileRow): LcmFile {
  return {
    id: row.id,
    messageId: row.message_id,
    conversationId: row.conversation_id,
    filePath: row.file_path,
    fileType: row.file_type as FileType,
    rawTokenCount: row.raw_token_count,
    contentPreview: row.content_preview,
    explorationSummary: row.exploration_summary,
    createdAt: row.created_at,
  };
}

// 插入文件的参数类型定义
export interface InsertFileParams {
  messageId: string;
  conversationId: string;
  filePath?: string | null;
  fileType: FileType;
  rawTokenCount: number;
  contentPreview: string;
  explorationSummary?: string | null;
}

export class FileStore {
  constructor(private db: Db) {}

  // 文件插入
  insertFile(params: InsertFileParams): LcmFile {
    const id = `file_${randomUUID()}`;
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO files (id, message_id, conversation_id, file_path, file_type, raw_token_count, content_preview, exploration_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.messageId,
      params.conversationId,
      params.filePath ?? null,
      params.fileType,
      params.rawTokenCount,
      params.contentPreview,
      params.explorationSummary ?? null,
      now
    );
    return {
      id,
      messageId: params.messageId,
      conversationId: params.conversationId,
      filePath: params.filePath ?? null,
      fileType: params.fileType,
      rawTokenCount: params.rawTokenCount,
      contentPreview: params.contentPreview,
      explorationSummary: params.explorationSummary ?? null,
      createdAt: now,
    };
  }

  // 文件查询
  getFile(fileId: string): LcmFile | null {
    const row = this.db.prepare(
      'SELECT * FROM files WHERE id = ?'
    ).get(fileId) as unknown as FileRow | undefined;
    return row ? rowToFile(row) : null;
  }

  // 获取对话相关的所有文件，按创建时间升序排列
  getFilesForConversation(conversationId: string): LcmFile[] {
    const rows = this.db.prepare(
      'SELECT * FROM files WHERE conversation_id = ? ORDER BY created_at ASC'
    ).all(conversationId) as unknown as FileRow[];
    return rows.map(rowToFile);
  }

  // 更新文件的探索摘要（exploration_summary 字段）
  updateExplorationSummary(fileId: string, summary: string): void {
    this.db.prepare(
      'UPDATE files SET exploration_summary = ? WHERE id = ?'
    ).run(summary, fileId);
  }
}
