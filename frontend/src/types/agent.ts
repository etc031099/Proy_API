export type AgentId = 'coordinator' | 'operations' | 'analyst' | 'sales' | 'inventory' | 'forecast' | 'customers' | 'procurement' | 'associations';
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
  provider?: string;
  model?: string | null;
  estimatedCostUsd?: number | null;
  estimatedCostRangeUsd?: { min: number; max: number } | null;
  cacheMissInputTokens?: number | null;
  reasoningTokens?: number | null;
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
  requestedIntent?: 'forecast' | 'model_status' | 'method';
  routingMode?: 'deterministic' | 'semantic_fallback';
  languageDecision?: { detectedIntent: string; entitySource: 'explicit' | 'active_context' | 'resolver' | 'none';
    contextEntityType?: 'product'; contextEntityId?: string; semanticFallbackUsed: boolean };
  semanticClassification?: ProviderStageUsage;
  groundedAnswer?: ProviderStageUsage;
  grounded?: { route: string; generation?: {
    required: boolean; providerConfigured: boolean; groundedGenerationEnabled: boolean; attempted: boolean;
    status: 'NOT_ATTEMPTED' | 'SUCCEEDED' | 'FAILED' | 'REJECTED'; reason: string | null;
  }; responseDiagnostic?: {
    validationResult: 'ACCEPTED' | 'REJECTED'; validationReason: string; validationField?: string;
    validationLayer?: 'SCHEMA' | 'GROUNDING'; schemaReason?: string; schemaField?: string;
    limitationReason?: string; limitationCode?: string;
    unsupportedNumbers?: number[];
    unsupportedNumberDetails?: { value: number; pattern: string }[];
    finishReason: string | null; contentPresent: boolean | null;
  } };
  suggestions?: { label: string; message: string; detail?: string }[];
  suggestionsEntityType?: 'product' | 'supplier' | 'customer' | 'category';
  contextProvenance?:
    | { sourceType: 'candidate_snapshot'; entityType: 'supplier'; query: string; page: number; pageSize: number; totalMatches: number }
    | { sourceType: 'conversation_context' | 'deterministic_system'; entityType: 'product'; label: string };
  suggestionsExpiresAt?: number;
  suggestionsPagination?: { query: string; offset: number; limit: 5; totalMatches: number; hasMore: boolean; hasPrevious: boolean };
  v3Views?: V3DisplayView[];
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
export interface ProviderStageUsage {
  provider: string; model: string; calls: number;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  latencyMs: number; finishReason: string | null; accepted: boolean; fallbackReason: string | null;
  estimatedCostUsd: number | null; estimatedCostRangeUsd?: { min: number; max: number };
}
export type V3DisplayKind = 'business' | 'inventory' | 'forecast' | 'cross_sell' | 'customer' | 'supplier' | 'health';
export type V3EntityKind = 'product' | 'customer' | 'supplier' | 'category';
// Partial analytics and persisted history preserve unknown values, never zero-fill them.
export interface V3DisplayMetric { label: string; value: string | number | null }
export interface V3DisplayItem {
  type: V3EntityKind;
  key: string;
  label: string;
  secondaryLabel?: string;
  metrics: V3DisplayMetric[];
  selectMessage?: string;
}
/** Explicit, compact presentation projection. It contains no raw domain documents or private contact fields. */
export interface V3DisplayView {
  kind: V3DisplayKind;
  title: string;
  subtitle?: string;
  metrics: V3DisplayMetric[];
  items: V3DisplayItem[];
  note?: string;
}
export interface PendingActionPreview {
  pendingActionId: string; action: string; summary: string; expiresAt: string;
  requiresConfirmation: boolean; status: 'PENDING' | 'CONFIRMED' | 'EXECUTED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
  fields: Record<string, string | number>;
  items?: { sku: string; name: string; quantity: number; stock: number; resultingStock: number; price: number; total: number }[];
  result?: { id: string; type?: 'sale' | 'purchase'; currency?: string; total?: number; sku?: string; name?: string; stock?: number; needsSupplierSetup?: boolean;
    ruleConfigured?: boolean; operator?: '<' | '<='; threshold?: number; alreadyExists?: boolean;
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
