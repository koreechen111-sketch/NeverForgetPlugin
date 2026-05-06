import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 日志文件路径：优先从LCM_LOG_FILE环境变量获取，否则默认在用户主目录/.lcm/lcm.log
const logFile = process.env['LCM_LOG_FILE'] ?? path.join(os.homedir(), '.lcm', 'lcm.log');

let _logFd: number | null = null;

// 获取日志文件描述符的函数：单例实现，确保目录存在后打开文件
function getLogFd(): number {
  // 如果已有文件描述符，直接返回
  if (_logFd !== null) return _logFd;
  // 确保日志文件所在目录存在，recursive: true表示递归创建父目录
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // 以追加模式打开日志文件，返回文件描述符
  _logFd = fs.openSync(logFile, 'a');
  return _logFd;
}

// 核心日志写入函数：将日志信息格式化为JSON行并写入文件，捕获所有错误不抛出
function write(level: string, msg: string, data?: unknown): void {
  try {
    // 组装日志对象：包含时间戳、级别、消息、可选数据
    const line = JSON.stringify({
      t: new Date().toISOString(),// ISO格式时间戳
      level,// 日志级别：INFO/WARN/ERROR/DEBUG
      msg,// 日志消息
      ...(data !== undefined ? { data } : {}),
    });
    // 写入日志文件，追加换行符
    fs.writeSync(getLogFd(), line + '\n');
  } catch {
    // 日志写入失败不抛出错误，不影响主程序运行
  }
}

// 导出的日志工具对象：提供四个级别的日志方法
export const logger = {
  info: (msg: string, data?: unknown) => write('INFO', msg, data),
  warn: (msg: string, data?: unknown) => write('WARN', msg, data),
  error: (msg: string, data?: unknown) => write('ERROR', msg, data),
  debug: (msg: string, data?: unknown) => {
    if (process.env['LCM_DEBUG']) write('DEBUG', msg, data);
  },
};
