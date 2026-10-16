import type { LabelSummary } from '@/components/domain/label/label-badge';
import type { LaneSummary } from '@/components/domain/lane/lane-badge';

/** The shape the project screen reads for each todo. */
export interface TodoSummary {
  id: string;
  title: string;
  notes: string | null;
  acceptance: string | null;
  /** Whether AI leaves it alone. Shown, and settable, only while AI is on. */
  aiIgnored: boolean;
  parentId: string | null;
  dueAt: string | null;
  completedAt: string | null;
  position: number | null;
  /** Set when an agent split it: an umbrella, done when its pieces are. */
  splitAt: string | null;
  /** Its unarchived pieces, when it is an umbrella, and how many are done. */
  pieceCount: number;
  donePieceCount: number;
  isBlocked: boolean;
  blockedBy: readonly { id: string; title: string }[];
  dependencies: readonly { id: string; title: string; completedAt: string | null }[];
  labels: readonly LabelSummary[];
  lane: LaneSummary | null;
}
