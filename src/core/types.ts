// Core types for LCM

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface LcmTask {
  id: string;
  conversationId: string;
  parentId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  delegatedScope: string | null;
  keptWork: string | null;
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

export type MessageRole = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';

export interface LcmMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  tokenCount: number;
  sequenceNumber: number;
  timestamp: number;
  /** JSON blob: tool name, tool use id, etc. */
  metadata?: Record<string, unknown>;
}

export interface LcmConversation {
  id: string;
  sessionId: string;
  projectPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface LcmSummary {
  id: string;
  conversationId: string;
  parentId: string | null;
  /** 0 = leaf (summarizes raw messages), 1+ = condensed */
  level: number;
  content: string;
  tokenCount: number;
  messageRangeStart: number;
  messageRangeEnd: number;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface LcmContextItem {
  id: string;
  conversationId: string;
  category: 'decision' | 'state' | 'fact' | 'reference';
  content: string;
  /** 0.0-1.0 */
  importance: number;
  createdAt: number;
  expiresAt?: number;
}

export interface TranscriptCursor {
  sessionId: string;
  byteOffset: number;
  lastTimestamp: number;
}

// --- Transcript entry types (Claude Code JSONL format) ---

export interface TranscriptUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
  timestamp?: string;
  uuid?: string;
}

export interface TranscriptAssistantMessage {
  type: 'assistant';
  message: {
    role: 'assistant';
    content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
  timestamp?: string;
  uuid?: string;
}

export interface TranscriptSystemMessage {
  type: 'system';
  subtype?: string;
  content?: string;
  timestamp?: string;
}

export type TranscriptEntry =
  | TranscriptUserMessage
  | TranscriptAssistantMessage
  | TranscriptSystemMessage;

// --- Hook I/O ---

export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  [key: string]: unknown;
}

export interface HookOutput {
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    [key: string]: unknown;
  };
}

// --- Compaction ---

export interface CompactionResult {
  summariesCreated: number;
  messagesCompacted: number;
  tokensSaved: number;
}

// --- Retrieval ---

export interface GrepResult {
  messageId: string;
  conversationId: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  sequenceNumber: number;
  coveringSummaryId: string | null;  // summary that covers this message, or null
}

export interface DescribeResult {
  id: string;
  type: 'summary' | 'message';
  content: string;
  tokenCount: number;
  level?: number;
  parentId?: string | null;
  childCount?: number;
  messageRangeStart?: number;
  messageRangeEnd?: number;
  createdAt: number;
}

export interface ExpandResult {
  summaryId: string | null;  // null = direct message fallback, no covering summary
  isFallback?: boolean;
  messages: LcmMessage[];
  childSummaries: LcmSummary[];
  truncated: boolean;
  totalTokens: number;
}

export type FileType = 'json' | 'code' | 'sql' | 'xml' | 'text';

export interface LcmFile {
  id: string;
  messageId: string;
  conversationId: string;
  filePath: string | null;
  fileType: FileType;
  rawTokenCount: number;
  contentPreview: string;
  explorationSummary: string | null;
  createdAt: number;
}
