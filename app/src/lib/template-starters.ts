// Boards worth starting from, offered as templates a person adds to their own
// and then applies from "New project". A starter names no agents, since agents
// are the account's: once applied, a person gives each working lane one (the
// agent starters in agent-starters.ts fit them).

/** One lane of a starter, as a template stores it: routes are lane positions. */
export interface StarterLane {
  name: string;
  isDone: boolean;
  onSuccess: number | null;
  onFailure: number | null;
  wipLimit: number;
  maxAttempts: number;
}

export interface TemplateStarter {
  /** Its key. */
  id: 'plan-approve';
  name: string;
  lanes: readonly StarterLane[];
}

const lane = (name: string, over: Partial<StarterLane> = {}): StarterLane => ({
  name,
  isDone: false,
  onSuccess: null,
  onFailure: null,
  wipLimit: 1,
  maxAttempts: 3,
  ...over,
});

export const TEMPLATE_STARTERS: readonly TemplateStarter[] = [
  {
    // A planner writes the plan, which waits in Approve until a person moves
    // it on to Doing. Plan approval needs no feature of its own: a lane with no
    // agent and no route is a resting place, and the person's move is the
    // approval. Give Plan a planner and Doing a worker.
    id: 'plan-approve',
    name: 'Plan, then approve',
    lanes: [
      lane('Plan', { onSuccess: 1 }),
      lane('Approve'),
      lane('Doing', { onSuccess: 3 }),
      lane('Done', { isDone: true }),
    ],
  },
];
