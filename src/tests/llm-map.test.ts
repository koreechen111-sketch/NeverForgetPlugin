/**
 * Tests for the llm_map operator: Semaphore and llmMap function.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mock Anthropic SDK
// ---------------------------------------------------------------------------

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: mockCreate,
      };
      constructor(_opts: unknown) {}
    },
  };
});

// Import after mocking
import { Semaphore, llmMap } from '../core/llm-map.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
  };
}

function writeTempJsonl(lines: string[]): string {
  const tmpFile = path.join(os.tmpdir(), `llm-map-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(tmpFile, lines.join('\n') + '\n');
  return tmpFile;
}

function readOutputJsonl(outputPath: string): Array<{ input: string; output: string | null; error?: string }> {
  const content = fs.readFileSync(outputPath, 'utf-8');
  return content
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Semaphore tests
// ---------------------------------------------------------------------------

describe('Semaphore', () => {
  it('allows up to max concurrent acquisitions without blocking', async () => {
    const sem = new Semaphore(3);
    // Should acquire 3 times without waiting
    await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    // All 3 acquired immediately — no deadlock
    sem.release();
    sem.release();
    sem.release();
  });

  it('limits concurrency to max — 4th acquire blocks until a release', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();

    let resolved = false;
    const pending = sem.acquire().then(() => {
      resolved = true;
    });

    // Give the pending promise a tick to settle (it should still be blocked)
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Release one slot
    sem.release();
    await pending;
    expect(resolved).toBe(true);

    // Clean up
    sem.release();
  });

  it('release unblocks waiting acquires in FIFO order', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const p1 = sem.acquire().then(() => { order.push(1); sem.release(); });
    const p2 = sem.acquire().then(() => { order.push(2); sem.release(); });

    sem.release(); // triggers p1
    await Promise.all([p1, p2]);

    expect(order).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// llmMap tests
// ---------------------------------------------------------------------------

describe('llmMap', () => {
  let inputPath: string;
  let outputPath: string;

  beforeEach(() => {
    mockCreate.mockReset();
    inputPath = '';
    outputPath = path.join(os.tmpdir(), `llm-map-out-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  });

  afterEach(() => {
    // Clean up temp files
    for (const p of [inputPath, outputPath]) {
      if (p && fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    }
  });

  it('processes all JSONL lines and writes output file with results', async () => {
    inputPath = writeTempJsonl(['{"name":"Alice"}', '{"name":"Bob"}', '{"name":"Carol"}']);

    mockCreate
      .mockResolvedValueOnce(makeResponse('Hello Alice'))
      .mockResolvedValueOnce(makeResponse('Hello Bob'))
      .mockResolvedValueOnce(makeResponse('Hello Carol'));

    const result = await llmMap({
      inputPath,
      outputPath,
      promptTemplate: 'Greet this person: {{line}}',
      apiKey: 'test-key',
    });

    expect(result.processed).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.outputPath).toBe(outputPath);

    const outputRows = readOutputJsonl(outputPath);
    expect(outputRows).toHaveLength(3);
    expect(outputRows[0].output).toBe('Hello Alice');
    expect(outputRows[1].output).toBe('Hello Bob');
    expect(outputRows[2].output).toBe('Hello Carol');
  });

  it('captures per-line errors and the batch still succeeds for other lines', async () => {
    inputPath = writeTempJsonl(['line1', 'line2', 'line3']);

    mockCreate
      .mockResolvedValueOnce(makeResponse('ok line1'))
      .mockRejectedValueOnce(new Error('API error on line 2'))
      .mockResolvedValueOnce(makeResponse('ok line3'));

    const result = await llmMap({
      inputPath,
      outputPath,
      promptTemplate: 'Process: {{line}}',
      apiKey: 'test-key',
      maxConcurrency: 1, // serial to ensure order
    });

    expect(result.processed).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('API error on line 2');

    const outputRows = readOutputJsonl(outputPath);
    expect(outputRows).toHaveLength(3);
    expect(outputRows[0].output).toBe('ok line1');
    expect(outputRows[1].error).toContain('API error on line 2');
    expect(outputRows[1].output).toBeNull();
    expect(outputRows[2].output).toBe('ok line3');
  });

  it('substitutes {{line}} in the prompt template correctly', async () => {
    inputPath = writeTempJsonl(['hello world']);

    mockCreate.mockResolvedValueOnce(makeResponse('response'));

    await llmMap({
      inputPath,
      outputPath,
      promptTemplate: 'Translate "{{line}}" to French',
      apiKey: 'test-key',
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[0].content).toContain('Translate "hello world" to French');
  });

  it('skips empty lines in input file', async () => {
    inputPath = writeTempJsonl(['line1', '', 'line3', '']);

    mockCreate
      .mockResolvedValueOnce(makeResponse('r1'))
      .mockResolvedValueOnce(makeResponse('r3'));

    const result = await llmMap({
      inputPath,
      outputPath,
      promptTemplate: '{{line}}',
      apiKey: 'test-key',
    });

    expect(result.processed).toBe(2);
    expect(result.succeeded).toBe(2);
  });

  it('validates outputSchema and retries once on validation failure', async () => {
    inputPath = writeTempJsonl(['test input']);

    const schema = {
      type: 'object',
      required: ['name', 'value'],
      properties: {
        name: { type: 'string' },
        value: { type: 'number' },
      },
    };

    // First response fails schema (missing 'value'), second succeeds
    mockCreate
      .mockResolvedValueOnce(makeResponse('{"name":"test"}'))           // missing 'value'
      .mockResolvedValueOnce(makeResponse('{"name":"test","value":42}')); // valid

    const result = await llmMap({
      inputPath,
      outputPath,
      promptTemplate: '{{line}}',
      apiKey: 'test-key',
      outputSchema: schema,
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockCreate).toHaveBeenCalledTimes(2); // original + 1 retry
  });

  it('retries once when first response is not valid JSON', async () => {
    inputPath = writeTempJsonl(['input']);

    mockCreate
      .mockResolvedValueOnce(makeResponse('not json at all'))
      .mockResolvedValueOnce(makeResponse('{"result":"ok"}'));

    const result = await llmMap({
      inputPath,
      outputPath,
      promptTemplate: '{{line}}',
      apiKey: 'test-key',
      outputSchema: { type: 'object' },
    });

    expect(result.succeeded).toBe(1);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('records line as failed when retry also returns invalid JSON', async () => {
    inputPath = writeTempJsonl(['input']);

    // Both attempts return invalid JSON
    mockCreate
      .mockResolvedValueOnce(makeResponse('not json'))
      .mockResolvedValueOnce(makeResponse('still not json'));

    const result = await llmMap({
      inputPath,
      outputPath,
      promptTemplate: '{{line}}',
      apiKey: 'test-key',
      outputSchema: { type: 'object' },
    });

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('not valid JSON');

    const outputRows = readOutputJsonl(outputPath);
    expect(outputRows).toHaveLength(1);
    expect(outputRows[0].output).toBeNull();
    expect(outputRows[0].error).toContain('not valid JSON');
  });

  it('records line as failed when retry response fails schema validation', async () => {
    inputPath = writeTempJsonl(['input']);

    const schema = {
      type: 'object',
      required: ['name', 'value'],
      properties: {
        name: { type: 'string' },
        value: { type: 'number' },
      },
    };

    // First response missing 'value', retry also missing 'value'
    mockCreate
      .mockResolvedValueOnce(makeResponse('{"name":"test"}'))
      .mockResolvedValueOnce(makeResponse('{"name":"still-missing-value"}'));

    const result = await llmMap({
      inputPath,
      outputPath,
      promptTemplate: '{{line}}',
      apiKey: 'test-key',
      outputSchema: schema,
    });

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('schema validation');

    const outputRows = readOutputJsonl(outputPath);
    expect(outputRows).toHaveLength(1);
    expect(outputRows[0].output).toBeNull();
    expect(outputRows[0].error).toContain('schema validation');
  });
});
