import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

export type Db = DatabaseSync;

// 使用let声明，初始为null，保证整个应用生命周期内只有一个数据库连接
let _db: DatabaseSync | null = null;

// 获取数据库连接的核心函数
// 实现单例模式，自动创建存储目录，配置SQLite性能与并发参数
export function getDb(dbPath: string): DatabaseSync {
  // 单例检查：如果已有连接实例，直接返回，避免重复连接开销
  if (_db) return _db;

  // 确保数据库存储目录存在
  // 仅对文件数据库生效，:memory:是内存数据库，无需目录
  if (dbPath !== ':memory:') {
    // recursive: true 表示递归创建父目录，即使父目录不存在也不会报错
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  // 创建SQLite同步数据库连接实例，并赋值给单例变量
  _db = new DatabaseSync(dbPath);

  // SQLite核心配置（PRAGMA语句），优化性能、并发与数据完整性
  // 1. WAL模式：预写日志模式，支持并发读写（MCP服务器 + 钩子可同时访问）
  _db.exec('PRAGMA journal_mode=WAL');
  // 2. 忙超时：数据库被锁定时等待5000毫秒，避免立即报错
  _db.exec('PRAGMA busy_timeout=5000');
  // 3. 外键约束：开启外键检查，保证关联数据的完整性
  _db.exec('PRAGMA foreign_keys=ON');
  // 4. 同步模式：NORMAL在性能与数据安全间平衡，比FULL快，比OFF安全
  _db.exec('PRAGMA synchronous=NORMAL');

  // 返回配置好的数据库连接实例
  return _db;
}

// 关闭数据库连接的函数
// 用于应用退出或需要重新连接时，清理资源并重置单例
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
