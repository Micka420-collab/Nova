// L2 (C7/A15) renderer surface, ready to mount (J2-B lane map: integrator wiring).
export { ContextGauge, type ContextGaugeProps } from "./ContextGauge";
export { ConversationContextPanel, useCompactAction, visibleConversationSummary, type ConversationContextPanelProps } from "./ConversationContextPanel";
export { HandoffCard } from "./HandoffCard";
export { MissionContextPanel, mergeSummaries } from "./MissionContextPanel";
export { ModelSwitcher, switchCandidates, type ModelSwitcherProps } from "./ModelSwitcher";
export { SummaryCard, authorOf, type SummaryCardProps } from "./SummaryCard";
export { parseCompactCommand, type CompactCommand } from "./compact-command";
export { contextStoreFor, useContextSlice, useContextStore } from "./use-context-store";
