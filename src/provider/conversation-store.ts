const CONVERSATION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CONVERSATIONS = 10_000;
const MAX_SCOPED_SESSION_ID_LENGTH = 320;
const TOOL_CONTINUATION_TTL_MS = 15 * 60 * 1000;
const MAX_TOOL_CONTINUATIONS = 10_000;

interface ConversationEntry {
  id: string;
  updatedAt: number;
}

interface ToolContinuationEntry extends ConversationEntry {
  toolCallGroupId?: string;
}

const conversations = new Map<string, ConversationEntry>();
const toolContinuations = new Map<string, ToolContinuationEntry>();

export function conversationKey(accountId: number | string, sessionId?: string): string | null {
  const normalized = sessionId?.trim();
  if (!normalized || normalized.length > MAX_SCOPED_SESSION_ID_LENGTH) return null;
  return `${accountId}:${normalized}`;
}

export function getConversationId(accountId: number | string, sessionId?: string): string | null {
  const key = conversationKey(accountId, sessionId);
  if (!key) return null;

  const entry = conversations.get(key);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > CONVERSATION_TTL_MS) {
    conversations.delete(key);
    return null;
  }

  entry.updatedAt = Date.now();
  return entry.id;
}

export function setConversationId(
  accountId: number | string,
  sessionId: string | undefined,
  conversationId: string,
): void {
  const key = conversationKey(accountId, sessionId);
  if (!key || !conversationId) return;

  if (conversations.size >= MAX_CONVERSATIONS && !conversations.has(key)) {
    const oldestKey = conversations.keys().next().value;
    if (oldestKey) conversations.delete(oldestKey);
  }
  conversations.delete(key);
  conversations.set(key, { id: conversationId, updatedAt: Date.now() });
}

export function deleteConversationId(
  accountId: number | string,
  sessionId?: string,
): void {
  const key = conversationKey(accountId, sessionId);
  if (key) conversations.delete(key);
}

export function clearAccountConversations(accountId: number | string): void {
  const prefix = `${accountId}:`;
  for (const key of conversations.keys()) {
    if (key.startsWith(prefix)) conversations.delete(key);
  }
  for (const key of toolContinuations.keys()) {
    if (key.startsWith(prefix)) toolContinuations.delete(key);
  }
}

export function clearConversations(): void {
  conversations.clear();
  toolContinuations.clear();
}

function toolContinuationKey(accountId: number | string, toolCallId?: string): string | null {
  const normalized = toolCallId?.trim();
  if (!normalized || normalized.length > 256) return null;
  return String(accountId) + ":" + normalized;
}

export function getConversationIdForToolCall(accountId: number | string, toolCallId?: string): string | null {
  return getToolContinuationEntry(accountId, toolCallId)?.id || null;
}

export function getToolCallGroupId(accountId: number | string, toolCallId?: string): string | null {
  return getToolContinuationEntry(accountId, toolCallId)?.toolCallGroupId || null;
}

export function setConversationIdForToolCall(
  accountId: number | string,
  toolCallId: string | undefined,
  conversationId: string,
  toolCallGroupId?: string,
): void {
  const key = toolContinuationKey(accountId, toolCallId);
  if (!key || !conversationId) return;
  if (toolContinuations.size >= MAX_TOOL_CONTINUATIONS && !toolContinuations.has(key)) {
    const oldestKey = toolContinuations.keys().next().value;
    if (oldestKey) toolContinuations.delete(oldestKey);
  }
  const existing = toolContinuations.get(key);
  const normalizedGroupId = toolCallGroupId?.trim();
  toolContinuations.delete(key);
  toolContinuations.set(key, {
    id: conversationId,
    ...(normalizedGroupId || existing?.toolCallGroupId
      ? { toolCallGroupId: normalizedGroupId || existing?.toolCallGroupId }
      : {}),
    updatedAt: Date.now(),
  });
}

function getToolContinuationEntry(
  accountId: number | string,
  toolCallId?: string,
): ToolContinuationEntry | null {
  const key = toolContinuationKey(accountId, toolCallId);
  if (!key) return null;
  const entry = toolContinuations.get(key);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > TOOL_CONTINUATION_TTL_MS) {
    toolContinuations.delete(key);
    return null;
  }
  entry.updatedAt = Date.now();
  return entry;
}
