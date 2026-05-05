/**
 * 数据持久化：负责对话、消息的增删改查（CRUD），永久存储会话数据；
 * 实体转换：隔离数据库字段（下划线命名）和业务实体（驼峰命名），解耦数据层与业务层；
 * 工具能力：提供消息序列生成、全文检索、对话幂等创建等核心能力；
 * 兼容兜底：全文检索支持高性能 FTS5 + 基础 LIKE 双模式，保证跨环境可用。
 */
import type { Db } from '../db/connection.js';
import type { LcmConversation, LcmMessage, MessageRole } from './types.js';
import { randomUUID } from 'node:crypto';

// conversations 表
interface ConversationRow {
  id: string;
  session_id: string;
  project_path: string;
  created_at: number;
  updated_at: number;
}

// messages 表
interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  token_count: number;
  sequence_number: number;
  timestamp: number;
  metadata: string | null;
  rowid?: number;
}

// 数据库行 → 业务对话实体
function rowToConversation(row: ConversationRow): LcmConversation {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectPath: row.project_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 数据库行 → 业务消息实体
function rowToMessage(row: MessageRow): LcmMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as MessageRole,
    content: row.content,
    tokenCount: row.token_count,
    sequenceNumber: row.sequence_number,
    timestamp: row.timestamp,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

export class ConversationStore {
  constructor(private db: Db) {}

  getOrCreateConversation(sessionId: string, projectPath: string): LcmConversation {
    // 按 sessionId 查询最新对话
    const existing = this.db.prepare(
      'SELECT * FROM conversations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(sessionId) as unknown as ConversationRow | undefined;

    if (existing) return rowToConversation(existing);
    // 无则创建：UUID 主键 + 时间戳
    const now = Date.now();
    const id = `conv_${randomUUID()}`;
    this.db.prepare(
      'INSERT INTO conversations (id, session_id, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, sessionId, projectPath, now, now);

    return { id, sessionId, projectPath, createdAt: now, updatedAt: now };
  }

  // 按对话 ID 查单条对话
  getConversation(conversationId: string): LcmConversation | null {
    const row = this.db.prepare(
      'SELECT * FROM conversations WHERE id = ?'
    ).get(conversationId) as unknown as ConversationRow | undefined;
    return row ? rowToConversation(row) : null;
  }

  // 按会话 ID 查最新对话
  getConversationBySession(sessionId: string): LcmConversation | null {
    const row = this.db.prepare(
      'SELECT * FROM conversations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(sessionId) as unknown as ConversationRow | undefined;
    return row ? rowToConversation(row) : null;
  }

  // 更新 updated_at 时间戳（标记对话活跃）
  touchConversation(conversationId: string): void {
    this.db.prepare(
      'UPDATE conversations SET updated_at = ? WHERE id = ?'
    ).run(Date.now(), conversationId);
  }

  // Returns the next sequence number for a conversation
  nextSequenceNumber(conversationId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(sequence_number), -1) + 1 AS next FROM messages WHERE conversation_id = ?'
    ).get(conversationId) as unknown as { next: number };
    return row.next;
  }

  // 消息插入
  insertMessage(msg: Omit<LcmMessage, 'id' | 'sequenceNumber'>): LcmMessage {
    const id = `msg_${randomUUID()}`;// 生成唯一消息ID
    const seqNum = this.nextSequenceNumber(msg.conversationId);// 自动分配序号
    // 插入数据库（metadata 自动 JSON 序列化）
    this.db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, token_count, sequence_number, timestamp, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      msg.conversationId,
      msg.role,
      msg.content,
      msg.tokenCount,
      seqNum,
      msg.timestamp,
      msg.metadata ? JSON.stringify(msg.metadata) : null
    );
    return { ...msg, id, sequenceNumber: seqNum };
  }

  insertMessages(msgs: Array<Omit<LcmMessage, 'id' | 'sequenceNumber'>>): LcmMessage[] {
    const results: LcmMessage[] = [];
    for (const msg of msgs) {
      results.push(this.insertMessage(msg));
    }
    return results;
  }

  // 消息查询
  getMessages(conversationId: string, fromSeq?: number, toSeq?: number): LcmMessage[] {
    // 动态拼接 SQL：支持按序列号范围查询
    let sql = 'SELECT * FROM messages WHERE conversation_id = ?';
    // 按 sequence_number 升序排序（保证消息顺序）
    const params: (string | number)[] = [conversationId];
    if (fromSeq !== undefined) { sql += ' AND sequence_number >= ?'; params.push(fromSeq); }
    if (toSeq !== undefined) { sql += ' AND sequence_number <= ?'; params.push(toSeq); }
    sql += ' ORDER BY sequence_number ASC';
    const rows = this.db.prepare(sql).all(...params) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  getMessage(messageId: string): LcmMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as unknown as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  getMessageCount(conversationId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ?'
    ).get(conversationId) as unknown as { cnt: number };
    return row.cnt;
  }

  //Full-text search using FTS5. Falls back to LIKE if FTS fails.
  search(query: string, conversationId?: string, limit = 50): LcmMessage[] {
    try {
      // 优先使用 SQLite FTS5 全文检索
      let sql = `
        SELECT m.* FROM messages m
        INNER JOIN messages_fts f ON f.rowid = m.rowid
        WHERE messages_fts MATCH ?
      `;
      const params: (string | number)[] = [query];
      if (conversationId) { sql += ' AND m.conversation_id = ?'; params.push(conversationId); }
      sql += ' ORDER BY m.timestamp DESC LIMIT ?';
      params.push(limit);
      const rows = this.db.prepare(sql).all(...params) as unknown as MessageRow[];
      return rows.map(rowToMessage);
    } catch {
      // FTS 回退：使用简单 LIKE
      let sql = 'SELECT * FROM messages WHERE content LIKE ?';
      const params: (string | number)[] = [`%${query}%`];
      if (conversationId) { sql += ' AND conversation_id = ?'; params.push(conversationId); }
      sql += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(limit);
      const rows = this.db.prepare(sql).all(...params) as unknown as MessageRow[];
      return rows.map(rowToMessage);
    }
  }
}