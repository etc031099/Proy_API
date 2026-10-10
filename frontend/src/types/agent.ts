export type AgentId = 'coordinator' | 'operations' | 'analyst';
export interface AgentUsage {
  agentId: AgentId;
  model: string | null;
  llmCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  thoughtTokens: number | null;
  cachedInputTokens: number | null;
  toolUseTokens: number | null;
  totalTokens: number | null;
  latencyMs: number;
  usageAvailable: boolean;
}
export interface Participant extends AgentUsage { skillCalls: number; providerLatencyMs: number }
export interface RequestUsage {
  providerGenerations?: ProviderGeneration[];
  totalLlmCalls: number;
  totalSkillCalls: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalThoughtTokens: number | null;
  totalCachedInputTokens: number | null;
  totalToolUseTokens: number | null;
  totalTokens: number | null;
  metricsComplete: boolean;
  totalProviderLatencyMs: number;
  totalLatencyMs: number;
  toolSelectionCycles: number;
  agents: AgentUsage[];
}
export type ProviderTokenUsage = Pick<AgentUsage, 'inputTokens' | 'outputTokens' | 'thoughtTokens' | 'cachedInputTokens' | 'toolUseTokens' | 'totalTokens'>;
export interface ProviderGeneration {
  agentId: AgentId;
  requestedModel: string;
  finalModel: string;
  fallbackUsed: boolean;
  fallbackIndex: number;
  providerAttempts: number;
  deadlineMs: number;
  logicalGenerationUsage: ProviderTokenUsage & { usageAvailable: boolean };
  providerAttemptUsage: { providerAttempt: number; model: string; status: 'SUCCEEDED' | 'FAILED'; durationMs: number;
    usage: ProviderTokenUsage & { usageAvailable: boolean } }[];
  totalKnownUsage: ProviderTokenUsage;
  attemptMetricsComplete: boolean;
}
export interface AgentAction { skillId: string; agentId: AgentId; status: 'SUCCEEDED' | 'FAILED'; durationMs: number }
export interface AgentEvidence {
  evidenceId: string;
  sourceType: 'skill';
  skillId: string;
  label: string;
  asOf?: string;
  period?: { startDate: string; endDate: string };
  recordCount?: number;
}
export interface AgentResponse {
  suggestions?: { label: string; message: string; detail?: string }[];
  suggestionsEntityType?: 'product' | 'supplier' | 'customer';
  contextProvenance?: { sourceType: 'candidate_snapshot'; entityType: 'supplier'; query: string; page: number; pageSize: number; totalMatches: number };
  suggestionsExpiresAt?: number;
  suggestionsPagination?: { query: string; offset: number; limit: 5; totalMatches: number; hasMore: boolean; hasPrevious: boolean };
  pendingAction?: PendingActionPreview;
  requestId: string;
  conversationId: string;
  answer: string;
  intent: string;
  agent: AgentId;
  participants: Participant[];
  actions: AgentAction[];
  evidence: AgentEvidence[];
  usage: RequestUsage;
  requiresClarification: boolean;
  clarificationQuestion: string | null;
  latencyMs: number;
}
export interface PendingActionPreview {
  pendingActionId: string; action: string; summary: string; expiresAt: string;
  requiresConfirmation: boolean; status: 'PENDING' | 'CONFIRMED' | 'EXECUTED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
  fields: Record<string, string | number>;
  items?: { sku: string; name: string; quantity: number; stock: number; resultingStock: number; price: number; total: number }[];
  result?: { id: string; type?: 'sale' | 'purchase'; currency?: string; total?: number; sku?: string; name?: string; stock?: number; needsSupplierSetup?: boolean;
    items?: { sku: string; name: string; quantity: number; stock: number }[] };
}
export interface AgentMessageRequest { message: string; conversationId?: string }
export interface HistoryPagination { page: number; limit: number; total: number; totalPages: number }
export interface AgentConversation {
  conversationId: string; title: string; lastMessageAt: string; messageCount: number;
  status: 'active' | 'archived'; createdAt: string; updatedAt: string;
}
export interface AgentHistoryMessage {
  id: string; role: 'user' | 'assistant'; text: string; createdAt: string;
  status: 'pending' | 'completed' | 'failed'; response?: AgentResponse;
}
export interface AgentConversationList { items: AgentConversation[]; pagination: HistoryPagination }
export interface AgentConversationDetail { conversation: AgentConversation; messages: AgentHistoryMessage[]; pagination: HistoryPagination }
