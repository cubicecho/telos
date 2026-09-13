import type { LabelSummary } from '@/components/domain/label/label-badge';
import type { LaneSummary } from '@/components/domain/lane/lane-badge';

/** The shape the project screen reads for each todo. */
export interface TodoSummary {
  id: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  completedAt: string | null;
  position: number | null;
  isBlocked: boolean;
  blockedBy: readonly { id: string; title: string }[];
  dependencies: readonly { id: string; title: string; completedAt: string | null }[];
  labels: readonly LabelSummary[];
  lane: LaneSummary | null;
}
