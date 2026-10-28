import type { DB } from '@telos/db';
import { projects, todos } from '@telos/db/schema';
import { Actions, accessibleBy, type GraphQLAbility, type SkeletonAdapter } from '@vantreeseba/graphql-casl';
import { and, eq, inArray, isNotNull, isNull, ne, not, notInArray, or, type SQL, sql } from 'drizzle-orm';
import type { CallerAbility } from './abilities.ts';
import { type Conditions, RELATIONS, type RowSubject } from './rows.ts';

// The ability's row rules as SQL, for drizzle. graphql-casl folds a caller's
// rules for one action and table into a filter (`accessibleBy`), and this is
// the dialect it folds into: each rule's conditions become a predicate on the
// table, or on the alias of it a statement runs against.
//
// A condition through a relation (`'project.aiEnabled': true`) becomes a
// subquery on the foreign key: `project_id IN (SELECT id FROM projects WHERE
// ai_enabled)`. The conditions on one relation share one subquery. graphql-casl
// leaves this to the dialect, since what a path means depends on the schema;
// RELATIONS (auth/rows.ts) says what each one is.
//
// An operator this does not know is refused rather than dropped, since
// dropping one would widen what a caller reaches.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyTable = any;

/** The tables a relation may point into (RELATIONS, auth/rows.ts). */
const RELATED: Partial<Record<RowSubject, AnyTable>> = { projects, todos };

/** Matches no row: what a caller with no rule for a table reaches. */
const NOTHING = sql`false`;
/** Matches every row. */
const EVERYTHING = sql`true`;

/**
 * Whether a condition's value is a set of operators (`{ $in: [...] }`) rather
 * than a value to equal.
 *
 * @param value - The value.
 * @returns true for an operator set.
 */
function isOperators(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Date) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}

/**
 * One comparison on a column.
 *
 * @param column - The column.
 * @param operator - The mongo operator.
 * @param value - Its operand.
 * @param path - The condition's path, for the error.
 * @returns The predicate.
 */
function compare(column: AnyTable, operator: string, value: unknown, path: string): SQL {
  switch (operator) {
    case '$eq':
      return value === null ? isNull(column) : eq(column, value);
    case '$ne':
      return value === null ? isNotNull(column) : ne(column, value);
    case '$in':
      return Array.isArray(value) && value.length > 0 ? inArray(column, value) : NOTHING;
    case '$nin':
      return Array.isArray(value) && value.length > 0 ? notInArray(column, value) : EVERYTHING;
    default:
      throw new Error(`sql-filter: unsupported operator ${operator} on ${path}.`);
  }
}

/**
 * The predicate for conditions on one of a table's columns.
 *
 * @param table - The table or its alias.
 * @param subject - Which table it is.
 * @param path - The column's drizzle key.
 * @param value - What it must be.
 * @returns The predicate.
 */
function onColumn(table: AnyTable, subject: RowSubject, path: string, value: unknown): SQL {
  const column = table[path];
  if (!column) {
    throw new Error(`sql-filter: ${subject} has no column ${path}.`);
  }
  if (!isOperators(value)) {
    return compare(column, '$eq', value, path);
  }
  const parts = Object.entries(value).map(([operator, operand]) => compare(column, operator, operand, path));
  return and(...parts) ?? EVERYTHING;
}

/**
 * The predicate for one rule's conditions on a table.
 *
 * @param db - Builds the relations' subqueries.
 * @param table - The table, or the alias of it the statement runs against.
 * @param subject - Which table it is.
 * @param conditions - The conditions.
 * @returns The predicate.
 */
export function conditionsSql(db: DB, table: AnyTable, subject: RowSubject, conditions: Conditions): SQL {
  const parts: SQL[] = [];
  const throughRelation = new Map<string, Conditions>();
  for (const [path, value] of Object.entries(conditions)) {
    if (path.startsWith('$')) {
      throw new Error(`sql-filter: unsupported condition ${path} on ${subject}.`);
    }
    const dot = path.indexOf('.');
    if (dot === -1) {
      parts.push(onColumn(table, subject, path, value));
      continue;
    }
    const name = path.slice(0, dot);
    const onRelated = throughRelation.get(name) ?? {};
    onRelated[path.slice(dot + 1)] = value;
    throughRelation.set(name, onRelated);
  }
  for (const [name, onRelated] of throughRelation) {
    const relation = RELATIONS[subject]?.[name];
    const target = relation && RELATED[relation.table];
    if (!relation || !target) {
      throw new Error(`sql-filter: ${subject} has no relation ${name}.`);
    }
    const ids = db
      .select({ id: target.id })
      .from(target)
      .where(conditionsSql(db, target, relation.table, onRelated));
    parts.push(inArray(table[relation.key], ids));
  }
  return and(...parts) ?? EVERYTHING;
}

/**
 * The dialect `accessibleBy` folds a table's rules into.
 *
 * @param db - Builds the relations' subqueries.
 * @param table - The table or its alias.
 * @param subject - Which table it is.
 * @returns The adapter.
 */
function sqlAdapter(db: DB, table: AnyTable, subject: RowSubject): SkeletonAdapter<SQL> {
  return {
    rule: (conditions, inverted) => {
      const predicate = conditionsSql(db, table, subject, conditions as Conditions);
      // rc.5 types not() as possibly undefined (for an undefined operand), so
      // fail closed rather than cast.
      return inverted ? (not(predicate) ?? NOTHING) : predicate;
    },
    and: (filters) => and(...filters) ?? EVERYTHING,
    or: (filters) => or(...filters) ?? NOTHING,
    everything: () => EVERYTHING,
    nothing: () => NOTHING,
  };
}

/**
 * The rows of a table a caller's ability reaches, as SQL. No rule for the
 * table is no row.
 *
 * @param ability - The caller's ability.
 * @param db - Builds the relations' subqueries.
 * @param subject - Which table.
 * @param table - The table, or the alias of it the statement runs against.
 * @returns The predicate.
 */
export function rowsReached(ability: CallerAbility, db: DB, subject: RowSubject, table: AnyTable): SQL {
  // accessibleBy is typed for graphql-casl's own builder; the ability is the
  // same CASL MongoAbility underneath, and it is asked only `rulesFor`.
  const casl = ability as unknown as GraphQLAbility<Record<RowSubject, object>>;
  return accessibleBy(casl, Actions.read, subject, sqlAdapter(db, table, subject)) ?? NOTHING;
}
