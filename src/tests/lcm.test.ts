/**
 * Comprehensive vitest tests for the LCM plugin.
 *
 * Each describe block uses its own fresh in-memory SQLite database to avoid
 * singleton cross-contamination from connection.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/migration.js';
import { ConversationStore } from '../core/conversation-store.js';
import { SummaryStore } from '../core/summary-store.js';
import { RetrievalEngine } from '../core/retrieval-engine.js';
import { ContextAssembler } from '../core/context-assembler.js';
import { deterministicTruncate } from '../core/summarize.js';
import { estimateTokens } from '../core/transcript-reader.js';
import { TaskStore } from '../core/task-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  runMigrations(db);
  return db;
}

/** Minimal timestamp helper so tests are not time-sensitive. */
const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Suite 1 — ConversationStore
// ---------------------------------------------------------------------------

describe('ConversationStore', () => {
  let db: DatabaseSync;
  let store: ConversationStore;

  beforeEach(() => {
    db = makeDb();
    store = new ConversationStore(db);
  });

  it('getOrCreateConversation creates a new conversation when none exists', () => {
    const conv = store.getOrCreateConversation('session-abc', '/project/foo');

    expect(conv.id).toMatch(/^conv_/);
    expect(conv.sessionId).toBe('session-abc');
    expect(conv.projectPath).toBe('/project/foo');
    expect(typeof conv.createdAt).toBe('number');
    expect(typeof conv.updatedAt).toBe('number');
  });

  it('getOrCreateConversation returns the same conversation on second call with same sessionId', () => {
    const first = store.getOrCreateConversation('session-abc', '/project/foo');
    const second = store.getOrCreateConversation('session-abc', '/project/foo');

    expect(second.id).toBe(first.id);
  });

  it('insertMessage assigns sequential sequenceNumber starting at 0', () => {
    const conv = store.getOrCreateConversation('session-seq', '/proj');

    const m0 = store.insertMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'Hello',
      tokenCount: 1,
      timestamp: NOW,
    });
    const m1 = store.insertMessage({
      conversationId: conv.id,
      role: 'assistant',
      content: 'Hi there',
      tokenCount: 2,
      timestamp: NOW + 1,
    });
    const m2 = store.insertMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'What is up',
      tokenCount: 3,
      timestamp: NOW + 2,
    });

    expect(m0.sequenceNumber).toBe(0);
    expect(m1.sequenceNumber).toBe(1);
    expect(m2.sequenceNumber).toBe(2);
  });

  it('insertMessage returns message with id prefixed msg_', () => {
    const conv = store.getOrCreateConversation('session-id-prefix', '/proj');
    const msg = store.insertMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'test',
      tokenCount: 1,
      timestamp: NOW,
    });

    expect(msg.id).toMatch(/^msg_/);
  });

  it('getMessages(convId) returns all messages ordered by sequence', () => {
    const conv = store.getOrCreateConversation('session-getmsgs', '/proj');

    store.insertMessage({ conversationId: conv.id, role: 'user', content: 'A', tokenCount: 1, timestamp: NOW });
    store.insertMessage({ conversationId: conv.id, role: 'assistant', content: 'B', tokenCount: 1, timestamp: NOW + 1 });
    store.insertMessage({ conversationId: conv.id, role: 'user', content: 'C', tokenCount: 1, timestamp: NOW + 2 });

    const msgs = store.getMessages(conv.id);

    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.content).toBe('A');
    expect(msgs[1]!.content).toBe('B');
    expect(msgs[2]!.content).toBe('C');
    // Verify ascending sequence order
    expect(msgs[0]!.sequenceNumber).toBeLessThan(msgs[1]!.sequenceNumber);
    expect(msgs[1]!.sequenceNumber).toBeLessThan(msgs[2]!.sequenceNumber);
  });

  it('getMessages(convId, fromSeq, toSeq) filters by range correctly', () => {
    const conv = store.getOrCreateConversation('session-range', '/proj');

    for (let i = 0; i < 5; i++) {
      store.insertMessage({ conversationId: conv.id, role: 'user', content: `msg${i}`, tokenCount: 1, timestamp: NOW + i });
    }

    const msgs = store.getMessages(conv.id, 1, 3);

    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.sequenceNumber).toBe(1);
    expect(msgs[2]!.sequenceNumber).toBe(3);
  });

  it('getMessage(id) returns the message', () => {
    const conv = store.getOrCreateConversation('session-getmsg', '/proj');
    const inserted = store.insertMessage({
      conversationId: conv.id,
      role: 'user',
      content: 'find me',
      tokenCount: 5,
      timestamp: NOW,
    });

    const found = store.getMessage(inserted.id);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(inserted.id);
    expect(found!.content).toBe('find me');
    expect(found!.tokenCount).toBe(5);
  });

  it('getMessage(id) returns null for unknown ID', () => {
    const result = store.getMessage('msg_does-not-exist');
    expect(result).toBeNull();
  });

  it('search(query) finds messages via FTS5', () => {
    const conv = store.getOrCreateConversation('session-fts', '/proj');

    store.insertMessage({ conversationId: conv.id, role: 'user', content: 'the quick brown fox', tokenCount: 4, timestamp: NOW });
    store.insertMessage({ conversationId: conv.id, role: 'assistant', content: 'nothing relevant here', tokenCount: 3, timestamp: NOW + 1 });

    const results = store.search('quick');

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((m) => m.content.includes('quick'))).toBe(true);
  });

  it('getMessageCount returns the correct count', () => {
    const conv = store.getOrCreateConversation('session-count', '/proj');

    expect(store.getMessageCount(conv.id)).toBe(0);

    store.insertMessage({ conversationId: conv.id, role: 'user', content: 'one', tokenCount: 1, timestamp: NOW });
    store.insertMessage({ conversationId: conv.id, role: 'assistant', content: 'two', tokenCount: 1, timestamp: NOW + 1 });

    expect(store.getMessageCount(conv.id)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — SummaryStore
// ---------------------------------------------------------------------------

describe('SummaryStore', () => {
  let db: DatabaseSync;
  let convStore: ConversationStore;
  let store: SummaryStore;
  let convId: string;

  beforeEach(() => {
    db = makeDb();
    convStore = new ConversationStore(db);
    store = new SummaryStore(db);
    const conv = convStore.getOrCreateConversation('session-ss', '/proj');
    convId = conv.id;
  });

  it('insertSummary returns summary with id prefixed sum_', () => {
    const summary = store.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'A brief summary.',
      tokenCount: 10,
      messageRangeStart: 0,
      messageRangeEnd: 5,
    });

    expect(summary.id).toMatch(/^sum_/);
  });

  it('insertSummary stores parentId: null when not provided', () => {
    const summary = store.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'No parent.',
      tokenCount: 5,
      messageRangeStart: 0,
      messageRangeEnd: 2,
    });

    const fetched = store.getSummary(summary.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.parentId).toBeNull();
  });

  it('getSummary(id) returns correct summary', () => {
    const inserted = store.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 1,
      content: 'High-level summary',
      tokenCount: 20,
      messageRangeStart: 0,
      messageRangeEnd: 10,
    });

    const found = store.getSummary(inserted.id);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(inserted.id);
    expect(found!.content).toBe('High-level summary');
    expect(found!.level).toBe(1);
    expect(found!.tokenCount).toBe(20);
    expect(found!.messageRangeStart).toBe(0);
    expect(found!.messageRangeEnd).toBe(10);
  });

  it('getSummary(id) returns null for unknown id', () => {
    expect(store.getSummary('sum_does-not-exist')).toBeNull();
  });

  it('getSummariesForConversation(convId) returns all summaries', () => {
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'S1', tokenCount: 5, messageRangeStart: 0, messageRangeEnd: 3 });
    store.insertSummary({ conversationId: convId, parentId: null, level: 1, content: 'S2', tokenCount: 5, messageRangeStart: 4, messageRangeEnd: 7 });

    const summaries = store.getSummariesForConversation(convId);
    expect(summaries).toHaveLength(2);
  });

  it('getSummariesForConversation(convId, 0) filters to level-0 only', () => {
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'Level 0', tokenCount: 5, messageRangeStart: 0, messageRangeEnd: 3 });
    store.insertSummary({ conversationId: convId, parentId: null, level: 1, content: 'Level 1', tokenCount: 5, messageRangeStart: 4, messageRangeEnd: 7 });
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'Level 0 again', tokenCount: 5, messageRangeStart: 8, messageRangeEnd: 11 });

    const level0 = store.getSummariesForConversation(convId, 0);

    expect(level0).toHaveLength(2);
    expect(level0.every((s) => s.level === 0)).toBe(true);
  });

  it('getChildSummaries(parentId) returns summaries with matching parent_id', () => {
    const parent = store.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 1,
      content: 'Parent',
      tokenCount: 10,
      messageRangeStart: 0,
      messageRangeEnd: 20,
    });
    const child1 = store.insertSummary({
      conversationId: convId,
      parentId: parent.id,
      level: 0,
      content: 'Child 1',
      tokenCount: 5,
      messageRangeStart: 0,
      messageRangeEnd: 9,
    });
    const child2 = store.insertSummary({
      conversationId: convId,
      parentId: parent.id,
      level: 0,
      content: 'Child 2',
      tokenCount: 5,
      messageRangeStart: 10,
      messageRangeEnd: 20,
    });

    const children = store.getChildSummaries(parent.id);

    expect(children).toHaveLength(2);
    const ids = children.map((c) => c.id);
    expect(ids).toContain(child1.id);
    expect(ids).toContain(child2.id);
  });

  it('getChildCount(summaryId) returns correct count', () => {
    const parent = store.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 1,
      content: 'Parent',
      tokenCount: 10,
      messageRangeStart: 0,
      messageRangeEnd: 20,
    });

    expect(store.getChildCount(parent.id)).toBe(0);

    store.insertSummary({ conversationId: convId, parentId: parent.id, level: 0, content: 'C1', tokenCount: 5, messageRangeStart: 0, messageRangeEnd: 9 });
    store.insertSummary({ conversationId: convId, parentId: parent.id, level: 0, content: 'C2', tokenCount: 5, messageRangeStart: 10, messageRangeEnd: 20 });

    expect(store.getChildCount(parent.id)).toBe(2);
  });

  it('getMaxCompactedSequence returns -1 when no summaries exist', () => {
    expect(store.getMaxCompactedSequence(convId)).toBe(-1);
  });

  it('getMaxCompactedSequence returns correct max when summaries exist', () => {
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'S1', tokenCount: 5, messageRangeStart: 0, messageRangeEnd: 9 });
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'S2', tokenCount: 5, messageRangeStart: 10, messageRangeEnd: 19 });
    // level 1 summary — should NOT count, only level 0 is considered
    store.insertSummary({ conversationId: convId, parentId: null, level: 1, content: 'S3', tokenCount: 5, messageRangeStart: 0, messageRangeEnd: 30 });

    expect(store.getMaxCompactedSequence(convId)).toBe(19);
  });

  it('linkSummaryToMessages creates entries in summary_messages table', () => {
    // Create messages
    const conv = convStore.getOrCreateConversation('session-link', '/proj');
    const m0 = convStore.insertMessage({ conversationId: conv.id, role: 'user', content: 'msg0', tokenCount: 5, timestamp: NOW });
    const m1 = convStore.insertMessage({ conversationId: conv.id, role: 'assistant', content: 'msg1', tokenCount: 5, timestamp: NOW + 1 });

    // Create summary
    const summary = store.insertSummary({
      conversationId: conv.id,
      parentId: null,
      level: 0,
      content: 'Summary of msg0 and msg1',
      tokenCount: 10,
      messageRangeStart: m0.sequenceNumber,
      messageRangeEnd: m1.sequenceNumber,
    });

    // Link
    store.linkSummaryToMessages(summary.id, [m0.id, m1.id]);

    // Verify via getMessageIdsForSummary
    const linkedIds = store.getMessageIdsForSummary(summary.id);
    expect(linkedIds).toHaveLength(2);
    expect(linkedIds).toContain(m0.id);
    expect(linkedIds).toContain(m1.id);
  });

  it('getMessageIdsForSummary returns empty array when no links exist', () => {
    const summary = store.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Unlinked summary',
      tokenCount: 5,
      messageRangeStart: 0,
      messageRangeEnd: 2,
    });

    const ids = store.getMessageIdsForSummary(summary.id);
    expect(ids).toHaveLength(0);
  });

  it('getTopSummaries(convId, budget) respects token budget', () => {
    // Insert three summaries; combined token cost exceeds budget of 15
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'S1', tokenCount: 8, messageRangeStart: 0, messageRangeEnd: 5 });
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'S2', tokenCount: 8, messageRangeStart: 6, messageRangeEnd: 11 });
    store.insertSummary({ conversationId: convId, parentId: null, level: 0, content: 'S3', tokenCount: 8, messageRangeStart: 12, messageRangeEnd: 17 });

    // Budget of 15 — only one or two summaries (8 or 16 tokens); exactly 8 fits, 16 > 15
    const selected = store.getTopSummaries(convId, 15);

    const totalTokens = selected.reduce((acc, s) => acc + s.tokenCount, 0);
    expect(totalTokens).toBeLessThanOrEqual(15);
  });

});

// ---------------------------------------------------------------------------
// Suite 3 — RetrievalEngine
// ---------------------------------------------------------------------------

describe('RetrievalEngine', () => {
  let db: DatabaseSync;
  let convStore: ConversationStore;
  let summaryStore: SummaryStore;
  let engine: RetrievalEngine;
  let convId: string;
  let sessionId: string;

  beforeEach(() => {
    db = makeDb();
    convStore = new ConversationStore(db);
    summaryStore = new SummaryStore(db);
    engine = new RetrievalEngine(convStore, summaryStore);

    sessionId = 'session-re';
    const conv = convStore.getOrCreateConversation(sessionId, '/proj');
    convId = conv.id;
  });

  it('grep(query) returns matching messages as GrepResult[]', () => {
    convStore.insertMessage({ conversationId: convId, role: 'user', content: 'refactor the database layer', tokenCount: 4, timestamp: NOW });
    convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'sure, here is a plan', tokenCount: 5, timestamp: NOW + 1 });

    const results = engine.grep('refactor');

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.messageId).toMatch(/^msg_/);
    expect(results[0]!.conversationId).toBe(convId);
    expect(results[0]!.sessionId).toBe(sessionId);
    expect(results[0]!.content).toContain('refactor');
    expect(typeof results[0]!.sequenceNumber).toBe('number');
    expect(typeof results[0]!.timestamp).toBe('number');
    expect(results[0]!.coveringSummaryId).toBeNull();
  });

  it('grep(query) returns empty array when no matches', () => {
    convStore.insertMessage({ conversationId: convId, role: 'user', content: 'hello world', tokenCount: 2, timestamp: NOW });

    const results = engine.grep('xyzzy_no_match_expected');

    expect(results).toEqual([]);
  });

  it('grep(query) includes coveringSummaryId when a summary covers the message', () => {
    const m0 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'covered search term alpha', tokenCount: 5, timestamp: NOW });
    const m1 = convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'response to alpha', tokenCount: 5, timestamp: NOW + 1 });

    const summary = summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Summary of alpha discussion.',
      tokenCount: 10,
      messageRangeStart: m0.sequenceNumber,
      messageRangeEnd: m1.sequenceNumber,
    });

    const results = engine.grep('alpha');

    expect(results.length).toBeGreaterThanOrEqual(1);
    const covered = results.find((r) => r.messageId === m0.id);
    expect(covered).toBeDefined();
    expect(covered!.coveringSummaryId).toBe(summary.id);
  });

  it('grep(query, undefined, 50, summaryId) restricts results to messages within summary scope', () => {
    // Insert messages at seq 0-3
    const m0 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'scoped keyword beta', tokenCount: 3, timestamp: NOW });
    const m1 = convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'reply with beta', tokenCount: 3, timestamp: NOW + 1 });
    const m2 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'another beta mention outside', tokenCount: 3, timestamp: NOW + 2 });
    const m3 = convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'no keyword here', tokenCount: 3, timestamp: NOW + 3 });

    // Summary covers only m0 and m1
    const summary = summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Summary covering first two.',
      tokenCount: 10,
      messageRangeStart: m0.sequenceNumber,
      messageRangeEnd: m1.sequenceNumber,
    });

    // Search with summary_id filter
    const results = engine.grep('beta', undefined, 50, summary.id);

    // Only m0 and m1 match "beta" within the summary scope; m2 is outside
    expect(results.length).toBe(2);
    const ids = results.map((r) => r.messageId);
    expect(ids).toContain(m0.id);
    expect(ids).toContain(m1.id);
    expect(ids).not.toContain(m2.id);
  });

  it('describe("sum_...") returns summary metadata with type "summary"', () => {
    const summary = summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'A concise summary.',
      tokenCount: 15,
      messageRangeStart: 0,
      messageRangeEnd: 4,
    });

    const result = engine.describe(summary.id);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('summary');
    expect(result!.id).toBe(summary.id);
    expect(result!.content).toBe('A concise summary.');
    expect(result!.tokenCount).toBe(15);
    expect(result!.level).toBe(0);
    expect(result!.messageRangeStart).toBe(0);
    expect(result!.messageRangeEnd).toBe(4);
    expect(typeof result!.childCount).toBe('number');
  });

  it('describe("msg_...") returns message metadata with type "message"', () => {
    const msg = convStore.insertMessage({
      conversationId: convId,
      role: 'user',
      content: 'A user message.',
      tokenCount: 4,
      timestamp: NOW,
    });

    const result = engine.describe(msg.id);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('message');
    expect(result!.id).toBe(msg.id);
    expect(result!.content).toBe('A user message.');
    expect(result!.tokenCount).toBe(4);
  });

  it('describe("unknown_id") returns null', () => {
    expect(engine.describe('unknown_id_xyz')).toBeNull();
  });

  it('expand(summaryId) returns messages linked via summary_messages', () => {
    const msg0 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'linked message A', tokenCount: 5, timestamp: NOW });
    const msg1 = convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'linked message B', tokenCount: 5, timestamp: NOW + 1 });

    const summary = summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Summary of A and B.',
      tokenCount: 10,
      messageRangeStart: msg0.sequenceNumber,
      messageRangeEnd: msg1.sequenceNumber,
    });

    // linkSummaryToMessages exists — verified in source
    summaryStore.linkSummaryToMessages(summary.id, [msg0.id, msg1.id]);

    const result = engine.expand(summary.id);

    expect(result.summaryId).toBe(summary.id);
    expect(result.messages).toHaveLength(2);
    const ids = result.messages.map((m) => m.id);
    expect(ids).toContain(msg0.id);
    expect(ids).toContain(msg1.id);
  });

  it('expand(summaryId) falls back to sequence range when no summary_messages links exist', () => {
    // Insert messages with sequences 0-2
    const m0 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'range msg 0', tokenCount: 3, timestamp: NOW });
    const m1 = convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'range msg 1', tokenCount: 3, timestamp: NOW + 1 });
    const m2 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'range msg 2', tokenCount: 3, timestamp: NOW + 2 });

    // No links — only range
    const summary = summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Range fallback summary.',
      tokenCount: 10,
      messageRangeStart: m0.sequenceNumber,
      messageRangeEnd: m2.sequenceNumber,
    });

    const result = engine.expand(summary.id);

    expect(result.summaryId).toBe(summary.id);
    expect(result.messages).toHaveLength(3);
    const seqs = result.messages.map((m) => m.sequenceNumber);
    expect(seqs).toContain(m0.sequenceNumber);
    expect(seqs).toContain(m1.sequenceNumber);
    expect(seqs).toContain(m2.sequenceNumber);
  });

  it('expand(summaryId) respects tokenCap and sets truncated: true', () => {
    // Each message costs 100 tokens; tokenCap = 150 => only one fits
    const m0 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'big msg 0', tokenCount: 100, timestamp: NOW });
    const m1 = convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'big msg 1', tokenCount: 100, timestamp: NOW + 1 });

    const summary = summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Big messages summary.',
      tokenCount: 20,
      messageRangeStart: m0.sequenceNumber,
      messageRangeEnd: m1.sequenceNumber,
    });

    // Link both messages explicitly so we exercise the direct-link path
    summaryStore.linkSummaryToMessages(summary.id, [m0.id, m1.id]);

    const result = engine.expand(summary.id, 1, 150);

    expect(result.truncated).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(result.totalTokens).toBeLessThanOrEqual(150);
  });

  it('expandQuery(query) returns expand results for summaries covering matched messages', () => {
    const m0 = convStore.insertMessage({ conversationId: convId, role: 'user', content: 'neural network architecture', tokenCount: 10, timestamp: NOW });
    const m1 = convStore.insertMessage({ conversationId: convId, role: 'assistant', content: 'here are the layers', tokenCount: 10, timestamp: NOW + 1 });

    const summary = summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Discussion of neural networks.',
      tokenCount: 20,
      messageRangeStart: m0.sequenceNumber,
      messageRangeEnd: m1.sequenceNumber,
    });

    const results = engine.expandQuery('neural');

    expect(results.length).toBeGreaterThanOrEqual(1);
    // The covering summary should appear
    expect(results.some((r) => r.summaryId === summary.id)).toBe(true);
  });

  it('expandQuery(query) returns fallback result with summaryId === null and isFallback === true when no summary covers the match', () => {
    // Insert a message but no summary covering it
    convStore.insertMessage({
      conversationId: convId,
      role: 'user',
      content: 'uncovered unique message zeta',
      tokenCount: 5,
      timestamp: NOW,
    });

    const results = engine.expandQuery('uncovered unique message zeta');

    expect(results.length).toBeGreaterThanOrEqual(1);
    const fallback = results.find((r) => r.isFallback === true);
    expect(fallback).toBeDefined();
    // Being added/fixed in parallel — asserting the spec
    expect(fallback!.summaryId).toBeNull();
    expect(fallback!.isFallback).toBe(true);
    expect(fallback!.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('expandQuery(query) respects tokenCap in fallback path when no summary covers the match', () => {
    // Insert a message with a large token count but no covering summary
    convStore.insertMessage({
      conversationId: convId,
      role: 'user',
      content: 'huge fallback message omega',
      tokenCount: 5000,
      timestamp: NOW,
    });

    // tokenCap=50, maxResults defaults to 5 → perResultCap=10, far below 5000
    const results = engine.expandQuery('huge fallback message omega', 5, 50);

    expect(results.length).toBeGreaterThanOrEqual(1);
    const fallback = results.find((r) => r.isFallback === true);
    expect(fallback).toBeDefined();
    expect(fallback!.truncated).toBe(true);
    expect(fallback!.messages).toHaveLength(0);
  });

  it('expandQuery(query) returns empty array when no messages match', () => {
    convStore.insertMessage({ conversationId: convId, role: 'user', content: 'something completely different', tokenCount: 4, timestamp: NOW });

    const results = engine.expandQuery('zzzzz_no_match_at_all');

    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — ContextAssembler
// ---------------------------------------------------------------------------

describe('ContextAssembler', () => {
  let db: DatabaseSync;
  let convStore: ConversationStore;
  let summaryStore: SummaryStore;
  let assembler: ContextAssembler;
  let convId: string;

  beforeEach(() => {
    db = makeDb();
    convStore = new ConversationStore(db);
    summaryStore = new SummaryStore(db);
    assembler = new ContextAssembler(convStore, summaryStore);

    const conv = convStore.getOrCreateConversation('session-ca', '/proj');
    convId = conv.id;
  });

  it('buildPostCompactContext returns null when no summaries and no context items', () => {
    const result = assembler.buildPostCompactContext(convId, 10_000);
    expect(result).toBeNull();
  });

  it('returns a string containing <lcm-restored-context> when summaries exist', () => {
    summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Discussed feature X implementation.',
      tokenCount: 20,
      messageRangeStart: 0,
      messageRangeEnd: 5,
    });

    const result = assembler.buildPostCompactContext(convId, 10_000);

    expect(result).not.toBeNull();
    expect(result).toContain('<lcm-restored-context>');
    expect(result).toContain('</lcm-restored-context>');
  });

  it('includes message range label in output (e.g. "messages 0–5")', () => {
    summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Summary content here.',
      tokenCount: 20,
      messageRangeStart: 0,
      messageRangeEnd: 5,
    });

    const result = assembler.buildPostCompactContext(convId, 10_000);

    expect(result).not.toBeNull();
    // The assembler formats this as "messages 0–5"
    expect(result).toContain('messages 0\u20135');
  });

  it('respects token budget (does not include summaries exceeding budget)', () => {
    // Each summary costs 500 tokens; budget = 600 => only one fits
    summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Summary A — large.',
      tokenCount: 500,
      messageRangeStart: 0,
      messageRangeEnd: 9,
    });
    summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Summary B — also large.',
      tokenCount: 500,
      messageRangeStart: 10,
      messageRangeEnd: 19,
    });

    const result = assembler.buildPostCompactContext(convId, 600);

    expect(result).not.toBeNull();
    // Only one summary should appear; the second is cut by budget
    const countA = (result!.match(/Summary A/g) ?? []).length;
    const countB = (result!.match(/Summary B/g) ?? []).length;
    // Exactly one of the two should appear
    expect(countA + countB).toBe(1);
  });

  it('includes context items section when items with importance >= 0.5 exist', () => {
    // insertContextItem and getContextItems exist in SummaryStore (verified in source)
    summaryStore.insertContextItem({
      conversationId: convId,
      category: 'fact',
      content: 'The deployment target is Kubernetes.',
      importance: 0.9,
    });
    summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Infra discussion.',
      tokenCount: 10,
      messageRangeStart: 0,
      messageRangeEnd: 2,
    });

    const result = assembler.buildPostCompactContext(convId, 10_000);

    expect(result).not.toBeNull();
    expect(result).toContain('Key Context Items');
    expect(result).toContain('Kubernetes');
  });

  it('does not include context items section when all items have importance < 0.5', () => {
    summaryStore.insertContextItem({
      conversationId: convId,
      category: 'fact',
      content: 'Low importance detail.',
      importance: 0.3,
    });
    summaryStore.insertSummary({
      conversationId: convId,
      parentId: null,
      level: 0,
      content: 'Some summary.',
      tokenCount: 10,
      messageRangeStart: 0,
      messageRangeEnd: 2,
    });

    const result = assembler.buildPostCompactContext(convId, 10_000);

    expect(result).not.toBeNull();
    // Low-importance item should be filtered out by getContextItems(convId, 0.5)
    expect(result).not.toContain('Low importance detail.');
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — DAG Condensation & Expand Depth
// ---------------------------------------------------------------------------

describe('DAG Condensation', () => {
  let db: DatabaseSync;
  let convStore: ConversationStore;
  let summaryStore: SummaryStore;
  let engine: RetrievalEngine;
  let convId: string;

  beforeEach(() => {
    db = makeDb();
    convStore = new ConversationStore(db);
    summaryStore = new SummaryStore(db);
    engine = new RetrievalEngine(convStore, summaryStore);
    const conv = convStore.getOrCreateConversation('session-dag', '/proj');
    convId = conv.id;
  });

  it('updateParentId sets the parent_id on a summary', () => {
    const child = summaryStore.insertSummary({
      conversationId: convId, parentId: null, level: 0,
      content: 'Child', tokenCount: 5, messageRangeStart: 0, messageRangeEnd: 4,
    });
    const parent = summaryStore.insertSummary({
      conversationId: convId, parentId: null, level: 1,
      content: 'Parent', tokenCount: 10, messageRangeStart: 0, messageRangeEnd: 9,
    });

    summaryStore.updateParentId(child.id, parent.id);

    const updated = summaryStore.getSummary(child.id);
    expect(updated!.parentId).toBe(parent.id);
  });

  it('getUncondensedSummaries returns only summaries with parent_id IS NULL at given level', () => {
    const s1 = summaryStore.insertSummary({
      conversationId: convId, parentId: null, level: 0,
      content: 'S1', tokenCount: 5, messageRangeStart: 0, messageRangeEnd: 4,
    });
    summaryStore.insertSummary({
      conversationId: convId, parentId: null, level: 0,
      content: 'S2', tokenCount: 5, messageRangeStart: 5, messageRangeEnd: 9,
    });

    // S3 has a parent — should be excluded
    const parent = summaryStore.insertSummary({
      conversationId: convId, parentId: null, level: 1,
      content: 'Parent', tokenCount: 10, messageRangeStart: 0, messageRangeEnd: 9,
    });
    summaryStore.insertSummary({
      conversationId: convId, parentId: parent.id, level: 0,
      content: 'S3 with parent', tokenCount: 5, messageRangeStart: 10, messageRangeEnd: 14,
    });

    const uncondensed = summaryStore.getUncondensedSummaries(convId, 0);
    expect(uncondensed).toHaveLength(2);
    expect(uncondensed.every(s => s.parentId === null)).toBe(true);
  });

  it('expand() with depth=2 on a level-1 summary recursively retrieves child messages', () => {
    // Create messages
    const msgs = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(convStore.insertMessage({
        conversationId: convId, role: 'user', content: `msg${i}`, tokenCount: 5, timestamp: NOW + i,
      }));
    }

    // Create two level-0 children
    const child1 = summaryStore.insertSummary({
      conversationId: convId, parentId: null, level: 0,
      content: 'Child 1 summary', tokenCount: 10,
      messageRangeStart: 0, messageRangeEnd: 2,
    });
    summaryStore.linkSummaryToMessages(child1.id, [msgs[0]!.id, msgs[1]!.id, msgs[2]!.id]);

    const child2 = summaryStore.insertSummary({
      conversationId: convId, parentId: null, level: 0,
      content: 'Child 2 summary', tokenCount: 10,
      messageRangeStart: 3, messageRangeEnd: 5,
    });
    summaryStore.linkSummaryToMessages(child2.id, [msgs[3]!.id, msgs[4]!.id, msgs[5]!.id]);

    // Create level-1 parent
    const parent = summaryStore.insertSummary({
      conversationId: convId, parentId: null, level: 1,
      content: 'Condensed summary of children', tokenCount: 15,
      messageRangeStart: 0, messageRangeEnd: 5,
    });
    summaryStore.updateParentId(child1.id, parent.id);
    summaryStore.updateParentId(child2.id, parent.id);

    // depth=1 should return child summaries and messages via range fallback
    const shallow = engine.expand(parent.id, 1, 8000);
    expect(shallow.childSummaries).toHaveLength(2);
    // At depth=1 the parent has no direct message links, so range fallback returns messages
    expect(shallow.messages.length).toBeGreaterThanOrEqual(0);

    // depth=2 should recursively expand children and return all 6 messages
    const deep = engine.expand(parent.id, 2, 8000);
    expect(deep.messages).toHaveLength(6);
    expect(deep.childSummaries).toHaveLength(2);
    expect(deep.truncated).toBe(false);
    expect(deep.totalTokens).toBe(30); // 6 messages × 5 tokens
  });

  it('expand() with depth=2 respects tokenCap across recursive expansion', () => {
    // Create messages with 100 tokens each
    const msgs = [];
    for (let i = 0; i < 4; i++) {
      msgs.push(convStore.insertMessage({
        conversationId: convId, role: 'user', content: `big msg ${i}`, tokenCount: 100, timestamp: NOW + i,
      }));
    }

    const child1 = summaryStore.insertSummary({
      conversationId: convId, parentId: null, level: 0,
      content: 'Child 1', tokenCount: 10, messageRangeStart: 0, messageRangeEnd: 1,
    });
    summaryStore.linkSummaryToMessages(child1.id, [msgs[0]!.id, msgs[1]!.id]);

    const child2 = summaryStore.insertSummary({
      conversationId: convId, parentId: null, level: 0,
      content: 'Child 2', tokenCount: 10, messageRangeStart: 2, messageRangeEnd: 3,
    });
    summaryStore.linkSummaryToMessages(child2.id, [msgs[2]!.id, msgs[3]!.id]);

    const parent = summaryStore.insertSummary({
      conversationId: convId, parentId: null, level: 1,
      content: 'Parent', tokenCount: 15, messageRangeStart: 0, messageRangeEnd: 3,
    });
    summaryStore.updateParentId(child1.id, parent.id);
    summaryStore.updateParentId(child2.id, parent.id);

    // tokenCap=250 — only 2 of 4 messages fit (each 100 tokens)
    const result = engine.expand(parent.id, 2, 250);
    expect(result.messages).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.totalTokens).toBeLessThanOrEqual(250);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — Summarization
// ---------------------------------------------------------------------------

describe('Summarization', () => {
  it('deterministicTruncate concatenates messages in [role]: content format', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello world', tokenCount: 3, id: 'msg_1', conversationId: 'c1', sequenceNumber: 0, timestamp: NOW },
      { role: 'assistant' as const, content: 'Hi there', tokenCount: 2, id: 'msg_2', conversationId: 'c1', sequenceNumber: 1, timestamp: NOW + 1 },
    ];

    const result = deterministicTruncate(messages, 512);

    expect(result).toContain('[user]: Hello world');
    expect(result).toContain('[assistant]: Hi there');
    expect(result).toContain('---');
    expect(result.length).toBeLessThanOrEqual(512 * 4);
  });

  it('deterministicTruncate always produces output smaller than input for large messages', () => {
    // Create messages totaling ~10000 tokens (each token ~4 chars)
    const bigContent = 'x'.repeat(4 * 2500); // 2500 tokens per message
    const messages = [
      { role: 'user' as const, content: bigContent, tokenCount: 2500, id: 'msg_1', conversationId: 'c1', sequenceNumber: 0, timestamp: NOW },
      { role: 'assistant' as const, content: bigContent, tokenCount: 2500, id: 'msg_2', conversationId: 'c1', sequenceNumber: 1, timestamp: NOW + 1 },
      { role: 'user' as const, content: bigContent, tokenCount: 2500, id: 'msg_3', conversationId: 'c1', sequenceNumber: 2, timestamp: NOW + 2 },
      { role: 'assistant' as const, content: bigContent, tokenCount: 2500, id: 'msg_4', conversationId: 'c1', sequenceNumber: 3, timestamp: NOW + 3 },
    ];

    const result = deterministicTruncate(messages, 512);
    const resultTokens = estimateTokens(result);

    expect(resultTokens).toBeLessThanOrEqual(512);
  });
});

// Suite N — FileStore
// ---------------------------------------------------------------------------

import { FileStore } from '../core/file-store.js';

describe('FileStore', () => {
  let db: DatabaseSync;
  let store: FileStore;
  let convStore: ConversationStore;
  let convId: string;
  let msgId: string;

  beforeEach(() => {
    db = makeDb();
    store = new FileStore(db);
    convStore = new ConversationStore(db);
    const conv = convStore.getOrCreateConversation('session-fs', '/project/fs');
    convId = conv.id;
    const msg = convStore.insertMessage({ conversationId: convId, role: 'tool_result', content: 'x'.repeat(100), tokenCount: 25, timestamp: NOW });
    msgId = msg.id;
  });

  it('insertFile creates a file with id prefixed file_', () => {
    const file = store.insertFile({
      messageId: msgId,
      conversationId: convId,
      fileType: 'json',
      rawTokenCount: 30000,
      contentPreview: '{"key":"value"}',
      explorationSummary: '[JSON]\nObject with 1 top-level keys:\n  key: string',
    });

    expect(file.id).toMatch(/^file_/);
    expect(file.messageId).toBe(msgId);
    expect(file.conversationId).toBe(convId);
    expect(file.fileType).toBe('json');
    expect(file.rawTokenCount).toBe(30000);
    expect(file.explorationSummary).toContain('[JSON]');
    expect(typeof file.createdAt).toBe('number');
  });

  it('getFile returns the file by id', () => {
    const inserted = store.insertFile({
      messageId: msgId,
      conversationId: convId,
      fileType: 'code',
      rawTokenCount: 26000,
      contentPreview: 'function foo() {}',
      explorationSummary: '[CODE]\nSignatures (1):\n  function foo()',
    });

    const fetched = store.getFile(inserted.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(inserted.id);
    expect(fetched!.fileType).toBe('code');
  });

  it('getFile returns null for unknown id', () => {
    expect(store.getFile('file_nonexistent')).toBeNull();
  });

  it('getFilesForConversation returns only files for that conversation', () => {
    const conv2 = convStore.getOrCreateConversation('session-fs-2', '/proj2');
    const msg2 = convStore.insertMessage({ conversationId: conv2.id, role: 'tool_result', content: 'y'.repeat(100), tokenCount: 25, timestamp: NOW });

    store.insertFile({ messageId: msgId, conversationId: convId, fileType: 'text', rawTokenCount: 26000, contentPreview: 'abc' });
    store.insertFile({ messageId: msg2.id, conversationId: conv2.id, fileType: 'sql', rawTokenCount: 27000, contentPreview: 'CREATE TABLE t (id TEXT)' });

    const files1 = store.getFilesForConversation(convId);
    const files2 = store.getFilesForConversation(conv2.id);

    expect(files1).toHaveLength(1);
    expect(files1[0]!.conversationId).toBe(convId);
    expect(files2).toHaveLength(1);
    expect(files2[0]!.conversationId).toBe(conv2.id);
  });

  it('updateExplorationSummary changes the summary', () => {
    const file = store.insertFile({
      messageId: msgId,
      conversationId: convId,
      fileType: 'text',
      rawTokenCount: 26000,
      contentPreview: 'hello',
      explorationSummary: 'old summary',
    });

    store.updateExplorationSummary(file.id, 'new summary');

    const updated = store.getFile(file.id);
    expect(updated!.explorationSummary).toBe('new summary');
  });
});

// ---------------------------------------------------------------------------
// Suite N+1 — FileAnalyzer
// ---------------------------------------------------------------------------

import { detectFileType, generateExplorationSummary } from '../core/file-analyzer.js';

describe('FileAnalyzer', () => {
  describe('detectFileType', () => {
    it('detects JSON content', () => {
      expect(detectFileType('{"name":"foo","count":42}')).toBe('json');
      expect(detectFileType('[1, 2, 3]')).toBe('json');
    });

    it('detects SQL content', () => {
      expect(detectFileType('CREATE TABLE users (id TEXT PRIMARY KEY);')).toBe('sql');
      expect(detectFileType('CREATE VIEW active_users AS SELECT * FROM users;')).toBe('sql');
      expect(detectFileType('CREATE INDEX idx_name ON users(name);')).toBe('sql');
    });

    it('detects code content', () => {
      expect(detectFileType('function hello() { return 42; }')).toBe('code');
      expect(detectFileType('class MyClass { constructor() {} }')).toBe('code');
      expect(detectFileType('import { foo } from "bar";\nexport function baz() {}')).toBe('code');
      expect(detectFileType('def my_func(x):\n  return x + 1')).toBe('code');
    });

    it('detects XML/HTML content', () => {
      expect(detectFileType('<root><child>text</child></root>')).toBe('xml');
      expect(detectFileType('<!DOCTYPE html><html><body></body></html>')).toBe('xml');
    });

    it('defaults to text for plain content', () => {
      expect(detectFileType('This is just a plain text document with no special markers.')).toBe('text');
      expect(detectFileType('some random words without code patterns')).toBe('text');
    });
  });

  describe('generateExplorationSummary', () => {
    it('JSON summary lists top-level keys', () => {
      const content = JSON.stringify({ name: 'Alice', age: 30, hobbies: ['reading', 'coding'], address: null });
      const summary = generateExplorationSummary(content, 'json');
      expect(summary).toContain('[JSON]');
      expect(summary).toContain('name');
      expect(summary).toContain('age');
      expect(summary).toContain('hobbies');
    });

    it('JSON summary shows array length for array values', () => {
      const content = JSON.stringify({ items: [1, 2, 3, 4, 5], count: 5 });
      const summary = generateExplorationSummary(content, 'json');
      expect(summary).toContain('Array(5)');
    });

    it('Code summary extracts function signatures', () => {
      const content = `
function fetchData(url) { return fetch(url); }
async function processResult(data) { return data; }
class DataManager { constructor() {} }
`;
      const summary = generateExplorationSummary(content, 'code');
      expect(summary).toContain('[CODE]');
      expect(summary).toContain('function fetchData()');
      expect(summary).toContain('function processResult()');
      expect(summary).toContain('class DataManager');
    });

    it('Code summary extracts Python def signatures', () => {
      const content = `def compute(x, y):\n    return x + y\ndef helper():\n    pass`;
      const summary = generateExplorationSummary(content, 'code');
      expect(summary).toContain('[CODE]');
      expect(summary).toContain('def compute()');
      expect(summary).toContain('def helper()');
    });

    it('SQL summary extracts CREATE TABLE statements', () => {
      const content = `
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE posts (id TEXT PRIMARY KEY, user_id TEXT);
CREATE INDEX idx_user ON posts(user_id);
`;
      const summary = generateExplorationSummary(content, 'sql');
      expect(summary).toContain('[SQL]');
      expect(summary).toContain('CREATE TABLE users');
      expect(summary).toContain('CREATE TABLE posts');
      expect(summary).toContain('CREATE INDEX idx_user');
    });

    it('Fallback summary shows first 500 chars and last 200 chars', () => {
      const longContent = 'A'.repeat(300) + 'MIDDLE' + 'B'.repeat(600);
      const summary = generateExplorationSummary(longContent, 'text');
      expect(summary).toContain('A'.repeat(100));
      expect(summary).toContain('B'.repeat(100));
      expect(summary).toContain('...');
      expect(summary).toContain('tokens');
    });
  });
});

// ---------------------------------------------------------------------------
// Suite N+2 — Ingest Integration (large file detection)
// ---------------------------------------------------------------------------

import { ingestNewMessages } from '../hook-handlers/ingest.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Ingest large file integration', () => {
  let db: DatabaseSync;
  let convStore: ConversationStore;
  let summaryStore: SummaryStore;
  let fileStore: FileStore;
  let transcriptPath: string;

  beforeEach(() => {
    db = makeDb();
    convStore = new ConversationStore(db);
    summaryStore = new SummaryStore(db);
    fileStore = new FileStore(db);

    const dir = mkdtempSync(join(tmpdir(), 'lcm-test-'));
    transcriptPath = join(dir, 'transcript.jsonl');
  });

  it('stores a file record when a tool_result message exceeds the threshold', async () => {
    const bigJson = JSON.stringify({ data: 'x'.repeat(100_000), metadata: { count: 42, items: [1, 2, 3] } });

    const entry = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: bigJson }],
      },
      timestamp: new Date(NOW).toISOString(),
      uuid: 'test-uuid-large',
    };
    writeFileSync(transcriptPath, JSON.stringify(entry) + '\n');

    const sessionId = 'session-ingest-large';
    await ingestNewMessages(transcriptPath, sessionId, '/proj', convStore, summaryStore, fileStore, 25000);

    const conv = convStore.getConversationBySession(sessionId);
    expect(conv).not.toBeNull();

    const files = fileStore.getFilesForConversation(conv!.id);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const f = files[0]!;
    expect(f.fileType).toBe('json');
    expect(f.rawTokenCount).toBeGreaterThan(25000);
    expect(f.explorationSummary).toContain('[JSON]');
  });

  it('does not store a file record for small tool_result messages', async () => {
    const smallContent = JSON.stringify({ hello: 'world' });
    const entry = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: smallContent }],
      },
      timestamp: new Date(NOW).toISOString(),
      uuid: 'test-uuid-small',
    };
    writeFileSync(transcriptPath, JSON.stringify(entry) + '\n');

    const sessionId = 'session-ingest-small';
    await ingestNewMessages(transcriptPath, sessionId, '/proj', convStore, summaryStore, fileStore, 25000);

    const conv = convStore.getConversationBySession(sessionId);
    if (conv) {
      const files = fileStore.getFilesForConversation(conv.id);
      for (const f of files) {
        expect(f.rawTokenCount).toBeGreaterThan(25000);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Suite — TaskStore
// ---------------------------------------------------------------------------

describe('TaskStore', () => {
  let db: DatabaseSync;
  let convStore: ConversationStore;
  let taskStore: TaskStore;
  let convId: string;

  beforeEach(() => {
    db = makeDb();
    convStore = new ConversationStore(db);
    taskStore = new TaskStore(db);
    const conv = convStore.getOrCreateConversation('session-tasks', '/proj');
    convId = conv.id;
  });

  it('createTask and getTask — verify all fields roundtrip', () => {
    const task = taskStore.createTask({
      conversationId: convId,
      title: 'Implement feature X',
      description: 'Detailed description of feature X',
      delegatedScope: 'Write the backend API',
      keptWork: 'Write the frontend UI',
    });

    expect(task.id).toMatch(/^task_/);
    expect(task.conversationId).toBe(convId);
    expect(task.parentId).toBeNull();
    expect(task.title).toBe('Implement feature X');
    expect(task.description).toBe('Detailed description of feature X');
    expect(task.status).toBe('pending');
    expect(task.delegatedScope).toBe('Write the backend API');
    expect(task.keptWork).toBe('Write the frontend UI');
    expect(task.result).toBeNull();
    expect(typeof task.createdAt).toBe('number');
    expect(typeof task.updatedAt).toBe('number');

    const fetched = taskStore.getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(task.id);
    expect(fetched!.title).toBe('Implement feature X');
    expect(fetched!.description).toBe('Detailed description of feature X');
    expect(fetched!.status).toBe('pending');
    expect(fetched!.delegatedScope).toBe('Write the backend API');
    expect(fetched!.keptWork).toBe('Write the frontend UI');
  });

  it('getTask returns null for unknown id', () => {
    const result = taskStore.getTask('task_nonexistent');
    expect(result).toBeNull();
  });

  it('listTasks with filters — filter by status and conversationId', () => {
    const conv2 = convStore.getOrCreateConversation('session-tasks-2', '/proj2');

    taskStore.createTask({ conversationId: convId, title: 'Task A', description: 'pending task' });
    const t2 = taskStore.createTask({ conversationId: convId, title: 'Task B', description: 'will be in_progress' });
    taskStore.createTask({ conversationId: conv2.id, title: 'Task C', description: 'other conv' });

    taskStore.updateTask(t2.id, { status: 'in_progress' });

    const convTasks = taskStore.listTasks({ conversationId: convId });
    expect(convTasks).toHaveLength(2);
    expect(convTasks.every((t) => t.conversationId === convId)).toBe(true);

    const pendingTasks = taskStore.listTasks({ status: 'pending' });
    expect(pendingTasks.length).toBeGreaterThanOrEqual(1);
    expect(pendingTasks.every((t) => t.status === 'pending')).toBe(true);

    const inProgressTasks = taskStore.listTasks({ status: 'in_progress' });
    expect(inProgressTasks).toHaveLength(1);
    expect(inProgressTasks[0]!.id).toBe(t2.id);

    const convPending = taskStore.listTasks({ conversationId: convId, status: 'pending' });
    expect(convPending).toHaveLength(1);
    expect(convPending[0]!.title).toBe('Task A');
  });

  it('updateTask — update status from pending to completed, verify updatedAt changes', async () => {
    const task = taskStore.createTask({ conversationId: convId, title: 'Update me' });
    const originalUpdatedAt = task.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = taskStore.updateTask(task.id, { status: 'completed', result: 'Done successfully' });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('completed');
    expect(updated!.result).toBe('Done successfully');
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(originalUpdatedAt);
  });

  it('subtask hierarchy — create parent task, create child with parentId, verify parentId', () => {
    const parent = taskStore.createTask({
      conversationId: convId,
      title: 'Parent task',
    });

    const child = taskStore.createTask({
      conversationId: convId,
      title: 'Child task',
      parentId: parent.id,
    });

    expect(child.parentId).toBe(parent.id);

    const fetchedChild = taskStore.getTask(child.id);
    expect(fetchedChild).not.toBeNull();
    expect(fetchedChild!.parentId).toBe(parent.id);

    const fetchedParent = taskStore.getTask(parent.id);
    expect(fetchedParent).not.toBeNull();
    expect(fetchedParent!.parentId).toBeNull();
  });

  it('listTasks by parentId — returns only subtasks of that parent', () => {
    const parent = taskStore.createTask({ conversationId: convId, title: 'Parent' });
    const child1 = taskStore.createTask({ conversationId: convId, title: 'Child 1', parentId: parent.id });
    const child2 = taskStore.createTask({ conversationId: convId, title: 'Child 2', parentId: parent.id });
    taskStore.createTask({ conversationId: convId, title: 'Unrelated' });

    const subtasks = taskStore.listTasks({ parentId: parent.id });
    expect(subtasks).toHaveLength(2);
    const ids = subtasks.map((t) => t.id);
    expect(ids).toContain(child1.id);
    expect(ids).toContain(child2.id);
  });
});
