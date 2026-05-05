import type { FileType } from './types.js';

/**
 * 文件类型检测：从文本内容中自动判断文件类型（JSON/SQL/XML/ 代码 / 纯文本）；
 * 确定性结构化摘要：针对不同文件类型，生成精简、可读的结构摘要（不生成语义摘要）；
 * 无大模型调用。
 */
export function detectFileType(content: string): FileType {
  // 判断JSON：首尾{}[] + 强制JSON.parse验证
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // 不是有效的 JSON
    }
  }

  // 判断SQL：匹配CREATE/ABLE/VIEW/INDEX关键字
  const upperContent = content.toUpperCase();
  if (/CREATE\s+TABLE\b|CREATE\s+VIEW\b|CREATE\s+INDEX\b/.test(upperContent)) {
    return 'sql';
  }

  // 判断XML/HTML：匹配标签语法 <xxx> 或 DOCTYPE
  if (/<[a-zA-Z][a-zA-Z0-9]*[\s/>]/.test(content) || /<!DOCTYPE\s/i.test(content)) {
    return 'xml';
  }

  // 判断代码：匹配function/class/import/def/export等编程关键字
  if (/\bfunction\s+\w+\s*\(|\bclass\s+\w+|\bimport\s+[\w{*]|\bdef\s+\w+\s*\(|\bexport\s+(function|class|const|default)\b/.test(content)) {
    return 'code';
  }

  // 默认纯文本
  return 'text';
}

/**
 * 摘要分发器：根据文件类型文件类型路由到对应的摘要函数，生成结构化的摘要。
 * 无大模型调用。
 */
export function generateExplorationSummary(content: string, fileType: FileType): string {
  switch (fileType) {
    case 'json':
      return summarizeJson(content);
    case 'code':
      return summarizeCode(content);
    case 'sql':
      return summarizeSql(content);
    default:
      return summarizeFallback(content);
  }
}

function summarizeJson(content: string): string {
  try {
    // 解析与初始化
    const parsed = JSON.parse(content.trim());
    const lines: string[] = ['[JSON]'];

    // 分支 1 → 处理 JSON 数组
    if (Array.isArray(parsed)) {
      // 输出数组长度
      lines.push(`Array of ${parsed.length} items`);
      // 数组非空 + 首个元素是对象 → 提取对象的键
      if (parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
        const keys = Object.keys(parsed[0] as Record<string, unknown>);
        // 最多展示10个键，超出则省略
        lines.push(`Item keys: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ` (+${keys.length - 10} more)` : ''}`);
      }
    } else if (typeof parsed === 'object' && parsed !== null) {
      // 分支 2 → 处理 JSON 对象
      const obj = parsed as Record<string, unknown>;
      const keys = Object.keys(obj);
      // 输出顶级键的总数
      lines.push(`Object with ${keys.length} top-level keys:`);
      // 列出前20个键及其类型，超出则省略
      for (const key of keys.slice(0, 20)) {
        const val = obj[key];
        if (Array.isArray(val)) {
          lines.push(`  ${key}: Array(${val.length})`);// 数组显示长度
        } else if (val === null) {
          lines.push(`  ${key}: null`);// null值标记
        } else {
          lines.push(`  ${key}: ${typeof val}`);// 其他类型显示其类型string/number/boolean
        }
      }
      // 超过20个键时提示省略
      if (keys.length > 20) {
        lines.push(`  ... and ${keys.length - 20} more keys`);
      }
    } else {
      // 分支 3 → 处理其他 JSON 类型（字符串/数字/布尔值等）
      lines.push(`Primitive: ${typeof parsed}`);
    }

    return lines.join('\n');
  } catch {
    return summarizeFallback(content);
  }
}

function summarizeCode(content: string): string {
  const lines: string[] = ['[CODE]'];

  // 提取 function/class 的签名
  const signatures: string[] = [];

  // 匹配: function X(...), async function X(...)
  const funcMatches = content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)/g);
  for (const m of funcMatches) {
    signatures.push(`function ${m[1]}()`);
  }

  // 匹配: export function X(...)
  const exportFuncMatches = content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g);
  for (const m of exportFuncMatches) {
    const sig = `export function ${m[1]}()`;
    if (!signatures.includes(sig)) signatures.push(sig);
  }

  // 匹配: class X
  const classMatches = content.matchAll(/(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?/g);
  for (const m of classMatches) {
    signatures.push(`class ${m[1]}`);
  }

  // 匹配: def X(...) (Python)
  const defMatches = content.matchAll(/def\s+(\w+)\s*\([^)]*\)/g);
  for (const m of defMatches) {
    signatures.push(`def ${m[1]}()`);
  }

  // 匹配: const/let X = (...) => (赋值给变量的箭头函数)
  const arrowMatches = content.matchAll(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g);
  for (const m of arrowMatches) {
    signatures.push(`${m[1]} = () =>`);
  }

  // 保持原有顺序，对列表去重
  const seen = new Set<string>();
  const unique = signatures.filter(s => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });

  if (unique.length > 0) {
    lines.push(`Signatures (${unique.length}):`);
    // 最多展示30个签名，超出则省略
    for (const sig of unique.slice(0, 30)) {
      lines.push(`  ${sig}`);
    }
    if (unique.length > 30) {
      lines.push(`  ... and ${unique.length - 30} more`);
    }
  } else {
    // 未检测到任何函数/类签名时，截取代码片段兜底
    lines.push('No function/class signatures detected');
    lines.push(content.slice(0, 300) + (content.length > 300 ? '...' : ''));
  }

  return lines.join('\n');
}

/**
 * 生成SQL内容的结构化摘要
 * 仅提取CREATE TABLE/VIEW/INDEX核心DDL语句，无语义解析，纯规则匹配
 */
function summarizeSql(content: string): string {
  // 初始化摘要行数组，固定标记[SQL]标识类型
  const lines: string[] = ['[SQL]'];
  // 存储提取到的SQL DDL语句
  const statements: string[] = [];

  // 匹配 CREATE TABLE 语句（兼容 IF NOT EXISTS 语法，不区分大小写）
  const tableMatches = content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/gi);
  for (const m of tableMatches) {
    statements.push(`CREATE TABLE ${m[1]}`);
  }

  // 匹配 CREATE VIEW 语句（兼容 IF NOT EXISTS 语法，不区分大小写）
  const viewMatches = content.matchAll(/CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/gi);
  for (const m of viewMatches) {
    statements.push(`CREATE VIEW ${m[1]}`);
  }

  // 匹配 CREATE INDEX 语句（兼容 UNIQUE/IF NOT EXISTS 语法，不区分大小写）
  const indexMatches = content.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/gi);
  for (const m of indexMatches) {
    statements.push(`CREATE INDEX ${m[1]}`);
  }

  // 有提取到SQL语句：格式化输出语句列表
  if (statements.length > 0) {
    lines.push(`Statements (${statements.length}):`);
    for (const stmt of statements) {
      lines.push(`  ${stmt}`);
    }
  } else {
    // 无匹配语句：兜底提示 + 截取前300字符SQL内容
    lines.push('No CREATE TABLE/VIEW/INDEX statements found');
    lines.push(content.slice(0, 300) + (content.length > 300 ? '...' : ''));
  }

  // 拼接所有行并返回最终摘要
  return lines.join('\n');
}

function summarizeFallback(content: string): string {
  // 行业通用规则：按 字符数/4 向上取整，估算文本的Token数量
  const tokenEstimate = Math.ceil(content.length / 4);
  // 截取文本开头 500 个字符作为核心展示内容
  const head = content.slice(0, 500);
  // 若文本总长度超过700字符，额外截取末尾200字符；否则不截取尾部
  const tail = content.length > 700 ? content.slice(-200) : '';
  // 组装摘要片段数组
  const parts = [head];
  // 存在尾部内容时，添加省略号+尾部内容，标识中间文本被截断
  if (tail) {
    parts.push('...');
    parts.push(tail);
  }
  // 末尾追加Token估算值，方便LLM和系统感知内容大小
  parts.push(`[~${tokenEstimate} tokens]`);
  // 用换行符拼接所有片段，返回最终兜底摘要
  return parts.join('\n');
}