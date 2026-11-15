import { ensure } from './errors.js';
import type { Execution, Settings } from './types.js';

export const MAX_CONVERSATION_CHARS = 2_000_000;
export const MAX_CONVERSATION_PARTS = 256;

/**
 * Approximate the serialized input budget at three UTF-16 characters per token.
 * This is deliberately a budgeting heuristic, not a model-specific tokenizer.
 * max_tokens limits generated output, so it must be reserved before input.
 */
export function contextCharLimit(settings: Settings, execution?: Execution): number {
  const total = settings.limits.max_context_tokens;
  ensure(Number.isSafeInteger(total) && total > 0, 'validation_error', 'Invalid context limit');
  const output = execution?.max_tokens ?? Math.min(4096, Math.max(128, Math.floor(total * 0.15)));
  ensure(
    Number.isSafeInteger(output) && output > 0,
    'validation_error',
    'Invalid output token limit',
  );
  const overhead = Math.max(128, Math.ceil(total * 0.05));
  return Math.max(0, total - output - overhead) * 3;
}

/** Test the complete serialized request, including its prompt and metadata. */
export function fitsContext(value: unknown, settings: Settings, execution?: Execution): boolean {
  const limit = contextCharLimit(settings, execution);
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && serialized.length <= limit;
  } catch {
    return false;
  }
}

export interface ConversationPart {
  content: string;
  /** UTF-16 offsets into the exact supplied, already redacted source. */
  start: number;
  end: number;
}

function references(value: unknown): { calls: Set<string>; results: Set<string> } {
  const calls = new Set<string>();
  const results = new Set<string>();
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) {
      for (const child of item) pending.push(child);
      continue;
    }
    const object = item as Record<string, unknown>;
    const type = typeof object.type === 'string' ? object.type.toLowerCase() : '';
    const result =
      object.role === 'tool' ||
      /(?:tool|function)[_-]?result/.test(type) ||
      typeof object.tool_call_id === 'string' ||
      typeof object.tool_use_id === 'string';
    const call = /^(?:tool|tool_call|tool_use|function|function_call)$/.test(type);
    const id =
      object.tool_call_id ??
      object.tool_use_id ??
      object.callID ??
      object.call_id ??
      object.toolCallId ??
      object.id;
    if (typeof id === 'string') {
      if (result) results.add(id);
      else if (call) calls.add(id);
    }
    for (const child of Object.values(object))
      if (child && typeof child === 'object') pending.push(child);
  }
  return { calls, results };
}

/** Locate top-level SDK message boundaries without reserializing their source. */
function messageBoundaries(content: string, maxChars: number): number[] {
  let messages: unknown;
  try {
    messages = JSON.parse(content);
  } catch {
    return [];
  }
  if (!Array.isArray(messages) || !messages.length) return [];
  const edges: number[] = [];
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '[' || character === '{') depth++;
    else if (character === ']' || character === '}') depth--;
    else if (character === ',' && depth === 1) edges.push(index + 1);
  }
  edges.push(content.length);
  const refs = messages.map(references);
  const preferred: number[] = [];
  let groupStart = 0;
  for (let index = 0; index < edges.length; index++) {
    const left = refs[index];
    const right = refs[index + 1];
    const related =
      left &&
      right &&
      ([...left.calls].some((id) => right.results.has(id)) ||
        [...left.results].some((id) => right.calls.has(id)));
    // Keep adjacent call/result messages together if the entire group fits.
    if (related && edges[index + 1]! - groupStart <= maxChars) continue;
    preferred.push(edges[index]!);
    groupStart = edges[index]!;
  }
  return preferred;
}

function scalarBoundary(content: string, offset: number): number {
  if (
    offset > 0 &&
    offset < content.length &&
    /[\uD800-\uDBFF]/.test(content[offset - 1]!) &&
    /[\uDC00-\uDFFF]/.test(content[offset]!)
  )
    return offset - 1;
  return offset;
}

/**
 * Split an already redacted source without discarding or rewriting any text.
 * Parts are exact source slices; JSON fragments need not be standalone JSON.
 * Overlap is bounded to a quarter of each part and may shrink to retain a
 * complete message/tool pair. Oversized messages fall back to line boundaries
 * and then Unicode scalar boundaries. Caps reject explicitly, never truncate.
 */
export function splitConversation(
  content: string,
  maxChars: number,
  overlap = 128,
): ConversationPart[] {
  ensure(typeof content === 'string', 'validation_error', 'Invalid conversation source');
  ensure(
    Number.isSafeInteger(maxChars) && maxChars > 0,
    'validation_error',
    'Invalid conversation part limit',
  );
  ensure(
    Number.isSafeInteger(overlap) && overlap >= 0,
    'validation_error',
    'Invalid conversation overlap',
  );
  ensure(
    content.length <= MAX_CONVERSATION_CHARS,
    'budget_exceeded',
    `Conversation exceeds ${MAX_CONVERSATION_CHARS} source characters; no text was truncated`,
  );
  if (!content.length) return [];
  const boundaries = messageBoundaries(content, maxChars);
  const parts: ConversationPart[] = [];
  let start = 0;
  let previousEnd = 0;
  let boundaryIndex = 0;
  while (previousEnd < content.length) {
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex]! <= previousEnd)
      boundaryIndex++;
    const nextBoundary = boundaries[boundaryIndex];
    if (
      nextBoundary !== undefined &&
      nextBoundary - previousEnd <= maxChars &&
      nextBoundary - start > maxChars
    )
      start = previousEnd;
    const hardEnd = scalarBoundary(content, Math.min(content.length, start + maxChars));
    let end = hardEnd;
    if (hardEnd < content.length) {
      let index = boundaryIndex;
      let messageEnd: number | undefined;
      while (index < boundaries.length && boundaries[index]! <= hardEnd) {
        messageEnd = boundaries[index]!;
        index++;
      }
      if (messageEnd !== undefined) end = messageEnd;
      else {
        // Avoid tiny fragments from incidental newlines near the chunk start.
        const minimum = Math.max(previousEnd + 1, start + Math.floor(maxChars / 2));
        const paragraph = content.lastIndexOf('\n\n', hardEnd - 2);
        const line = content.lastIndexOf('\n', hardEnd - 1);
        if (paragraph >= 0 && paragraph + 2 >= minimum) end = paragraph + 2;
        else if (line + 1 >= minimum) end = line + 1;
      }
    }
    ensure(
      end > previousEnd && end > start,
      'budget_exceeded',
      'Conversation part limit cannot hold the next Unicode character',
    );
    ensure(
      parts.length < MAX_CONVERSATION_PARTS,
      'budget_exceeded',
      `Conversation requires more than ${MAX_CONVERSATION_PARTS} parts; no text was truncated`,
    );
    parts.push({ content: content.slice(start, end), start, end });
    previousEnd = end;
    const shared = Math.min(overlap, Math.floor((end - start) / 4));
    const sharedStart = end - shared;
    // Shorten overlap rather than adding a split surrogate's extra code unit.
    start = scalarBoundary(content, sharedStart) < sharedStart ? sharedStart + 1 : sharedStart;
  }
  return parts;
}
