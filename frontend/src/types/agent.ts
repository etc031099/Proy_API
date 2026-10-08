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
export interface AgentMessageRequest { message: string; conversationId?: string }
