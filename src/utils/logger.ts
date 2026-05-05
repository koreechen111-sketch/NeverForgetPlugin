import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const logFile = process.env['LCM_LOG_FILE'] ?? path.join(os.homedir(), '.lcm', 'lcm.log');

let _logFd: number | null = null;

function getLogFd(): number {
  if (_logFd !== null) return _logFd;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  _logFd = fs.openSync(logFile, 'a');
  return _logFd;
}

function write(level: string, msg: string, data?: unknown): void {
  try {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      msg,
      ...(data !== undefined ? { data } : {}),
    });
    fs.writeSync(getLogFd(), line + '\n');
  } catch {
    // Never throw from logger
  }
}

export const logger = {
  info: (msg: string, data?: unknown) => write('INFO', msg, data),
  warn: (msg: string, data?: unknown) => write('WARN', msg, data),
  error: (msg: string, data?: unknown) => write('ERROR', msg, data),
  debug: (msg: string, data?: unknown) => {
    if (process.env['LCM_DEBUG']) write('DEBUG', msg, data);
  },
};
