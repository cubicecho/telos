import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import { attachResolvers } from '../attach-resolvers.ts';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, readChanges, TOMBSTONE_RETENTION_DAYS } from '../changes.ts';
import { ChangeEntityEnum, withEnums } from '../enums.ts';

// `changes(since:)`: the change feed (changes.ts) as a query. A read, so it is
// open to whoever can read the rows it names — a person, an API key on /graphql
// or /mcp (the `changes` tool), a run — each seeing what their scope lets them.
// Applied with AI off too: syncing a copy of your todos is not an AI feature.

const CHANGES_SDL = parse(`
  """
  Something the feed no longer has for you: deleted, or for an API key or a run,
  out of its view. Drop your copy. A dependency's says which edge it was.
  """
  type Tombstone {
    entity: ChangeEntity!
    id: ID!
    projectId: ID
    todoId: ID
    dependsOnTodoId: ID
    removedAt: DateTime!
  }

  """
  One page of the change feed. The rows are as they stand now, not as they were
  when they changed, so an entity may come round again on a later page: apply
  each by id. An archived todo is an upsert with \`archivedAt\` set.
  """
  type ChangeFeed {
    projects: [Project!]!
    todos: [Todo!]!
    dependencies: [TodoDependency!]!
    tombstones: [Tombstone!]!
    "Pass it as \`since\` next time, whether or not \`hasMore\`. Good for ${TOMBSTONE_RETENTION_DAYS - 1} days."
    cursor: String!
    "Whether there is more to read now: ask again with \`cursor\` straight away."
    hasMore: Boolean!
  }

  extend type Query {
    """
    What changed in your projects, todos and dependencies since \`since\` (a
    cursor from an earlier page; leave it out to read everything there is).
    At most \`limit\` entries, up to ${MAX_PAGE_SIZE}. An expired cursor fails with
    CURSOR_EXPIRED: start again without one.
    """
    changes(since: String, limit: Int = ${DEFAULT_PAGE_SIZE}): ChangeFeed!
  }
`);

export function applyChangesExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(withEnums(schema, [ChangeEntityEnum]), CHANGES_SDL);
  return attachResolvers(extendedSchema, {
    Query: { changes: (_parent, args, context) => readChanges(context, args) },
  });
}
