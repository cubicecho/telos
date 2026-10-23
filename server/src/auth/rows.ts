// The rows a caller may reach, stated as CASL conditions: what
// auth/abilities.ts builds each request's row rules from, and what
// auth/sql-filter.ts turns into SQL for tenancy's scope and the hand-written
// lookups.
//
// A condition names a row's own columns (`aiIgnored: false`) and, through a
// relation, the row it points at (`'project.aiEnabled': true`). RELATIONS says
// what each relation is: the foreign key on the row, and the table it points
// into. A relation's own conditions may name its relations in turn
// (`'todo.project.aiEnabled'`), which is how a run is hidden with its todo's
// project.

/**
 * Every table but `users` carries its own `user_id`, junctions included.
 * Carrying the column directly costs one uuid per join row and lets every
 * table share the same owner condition.
 */
export const USER_OWNED_TABLES = [
  'projects',
  'lanes',
  'todos',
  'todoDependencies',
  'labels',
  'projectLabels',
  'todoLabels',
  'todoNotes',
  'todoEvents',
  'agents',
  'mcpServers',
  'runs',
  'artifacts',
  'boardTemplates',
] as const;

/** A table whose rows belong to a user. */
export type OwnedTable = (typeof USER_OWNED_TABLES)[number];

/** Every table drizzle-graphql will generate fields for. */
export const ALL_TABLES = ['users', ...USER_OWNED_TABLES] as const;

/** A table the ability has row rules for, by its drizzle-graphql key. */
export type RowSubject = (typeof ALL_TABLES)[number];

/** One relation a condition may name: the row's foreign key, and the table it points into. */
export interface Relation {
  /** The foreign key column on the row, by its drizzle key. */
  key: string;
  /** The table the key points into. Its `id` is what the key holds. */
  table: RowSubject;
}

/** The relations conditions name, per table. */
export const RELATIONS: Partial<Record<RowSubject, Record<string, Relation>>> = {
  lanes: { project: { key: 'projectId', table: 'projects' } },
  projectLabels: { project: { key: 'projectId', table: 'projects' } },
  todos: { project: { key: 'projectId', table: 'projects' } },
  runs: { todo: { key: 'todoId', table: 'todos' } },
  artifacts: { todo: { key: 'todoId', table: 'todos' } },
  todoNotes: { todo: { key: 'todoId', table: 'todos' } },
  todoEvents: { todo: { key: 'todoId', table: 'todos' } },
  todoLabels: { todo: { key: 'todoId', table: 'todos' } },
  todoDependencies: {
    todo: { key: 'todoId', table: 'todos' },
    dependsOnTodo: { key: 'dependsOnTodoId', table: 'todos' },
  },
};

/** A condition on a row: column or relation path to a value, or to `{ $in: [...] }` and the like. */
export type Conditions = Record<string, unknown>;

/**
 * The same conditions on the row a relation points at.
 *
 * @param relation - The relation's name.
 * @param conditions - Conditions on the related row.
 * @returns Them, as paths through the relation.
 */
export function through(relation: string, conditions: Conditions): Conditions {
  return Object.fromEntries(Object.entries(conditions).map(([path, value]) => [`${relation}.${path}`, value]));
}

// What AI may see, past being its user's: only projects with AI switched on,
// and in them only the todos nobody told AI to ignore. Everything hanging off
// a hidden project or todo (lanes, notes, history, labels on it, dependency
// edges touching it) is hidden with it. These are rules of the feature as well
// as permissions: a draft needs a project with AI on whoever asks, so the
// hand-written lookups use them for a person too (core/owned.ts).

/**
 * A project AI may see.
 *
 * @param userId - Whose.
 * @returns The conditions.
 */
export function aiProject(userId: string): Conditions {
  return { userId, aiEnabled: true };
}

/**
 * A todo AI may work on: not archived, not ignored, in a project AI may see.
 *
 * @param userId - Whose.
 * @returns The conditions.
 */
export function aiTodo(userId: string): Conditions {
  return { userId, aiIgnored: false, archivedAt: null, ...through('project', aiProject(userId)) };
}

/**
 * A lane on a board AI may see.
 *
 * @param userId - Whose.
 * @returns The conditions.
 */
export function aiLane(userId: string): Conditions {
  return { userId, ...through('project', aiProject(userId)) };
}

/**
 * The rows of each table an AI caller reaches. A table named nowhere here is
 * reached as its user reaches it; `null` is not reached at all.
 *
 * An agent's row holds its key and its MCP servers' secrets, so AI reads the
 * roster instead (`agentRoster`, ai/reads.ts), which carries neither. A todo
 * AI reaches may be archived, so `restoreTodo` can find it; what hangs off a
 * todo is hidden once the todo is archived.
 *
 * @param userId - Whose rows.
 * @returns The conditions per table.
 */
export function aiReach(userId: string): Partial<Record<RowSubject, Conditions | null>> {
  const onTodo = through('todo', aiTodo(userId));
  return {
    agents: null,
    mcpServers: null,
    projects: aiProject(userId),
    lanes: aiLane(userId),
    projectLabels: aiLane(userId),
    todos: { userId, aiIgnored: false, ...through('project', aiProject(userId)) },
    runs: { userId, ...onTodo },
    // By todo as well, so one whose todo was deleted is a person's to see.
    artifacts: { userId, ...onTodo },
    todoNotes: { userId, ...onTodo },
    todoEvents: { userId, ...onTodo },
    todoLabels: { userId, ...onTodo },
    todoDependencies: { userId, ...onTodo, ...through('dependsOnTodo', aiTodo(userId)) },
  };
}

/**
 * The rows of a table a person reaches: their own. A user row is only ever
 * visible to its owner; there is no directory here.
 *
 * @param table - The table.
 * @param userId - Whose rows.
 * @returns The conditions.
 */
export function ownRows(table: RowSubject, userId: string): Conditions {
  return table === 'users' ? { id: userId } : { userId };
}
