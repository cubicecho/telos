import { defineRelations } from 'drizzle-orm';
import * as schema from './schema.ts';

// This config — not the table list — is what drizzle-graphql reads, so a table
// with no entry here gets no relation fields in the API.
export const relations = defineRelations(schema, (r) => ({
  users: {
    projects: r.many.projects({ from: r.users.id, to: r.projects.userId }),
    todos: r.many.todos({ from: r.users.id, to: r.todos.userId }),
    labels: r.many.labels({ from: r.users.id, to: r.labels.userId }),
    lanes: r.many.lanes({ from: r.users.id, to: r.lanes.userId }),
  },

  projects: {
    user: r.one.users({ from: r.projects.userId, to: r.users.id }),
    todos: r.many.todos({ from: r.projects.id, to: r.todos.projectId }),
    lanes: r.many.lanes({ from: r.projects.id, to: r.lanes.projectId }),
    labels: r.many.labels({
      from: r.projects.id.through(r.projectLabels.projectId),
      to: r.labels.id.through(r.projectLabels.labelId),
    }),
  },

  todos: {
    user: r.one.users({ from: r.todos.userId, to: r.users.id }),
    project: r.one.projects({ from: r.todos.projectId, to: r.projects.id }),
    lane: r.one.lanes({ from: r.todos.laneId, to: r.lanes.id }),
    labels: r.many.labels({
      from: r.todos.id.through(r.todoLabels.todoId),
      to: r.labels.id.through(r.todoLabels.labelId),
    }),
    // The todos this one waits on. It is blocked while any of them is open.
    dependencies: r.many.todos({
      from: r.todos.id.through(r.todoDependencies.todoId),
      to: r.todos.id.through(r.todoDependencies.dependsOnTodoId),
      alias: 'todoDependencyEdge',
    }),
    // The todos waiting on this one.
    dependents: r.many.todos({
      from: r.todos.id.through(r.todoDependencies.dependsOnTodoId),
      to: r.todos.id.through(r.todoDependencies.todoId),
      alias: 'todoDependentEdge',
    }),
  },

  lanes: {
    user: r.one.users({ from: r.lanes.userId, to: r.users.id }),
    project: r.one.projects({ from: r.lanes.projectId, to: r.projects.id }),
    todos: r.many.todos({ from: r.lanes.id, to: r.todos.laneId }),
  },

  labels: {
    user: r.one.users({ from: r.labels.userId, to: r.users.id }),
    projects: r.many.projects({
      from: r.labels.id.through(r.projectLabels.labelId),
      to: r.projects.id.through(r.projectLabels.projectId),
    }),
    todos: r.many.todos({
      from: r.labels.id.through(r.todoLabels.labelId),
      to: r.todos.id.through(r.todoLabels.todoId),
    }),
  },

  projectLabels: {
    project: r.one.projects({ from: r.projectLabels.projectId, to: r.projects.id }),
    label: r.one.labels({ from: r.projectLabels.labelId, to: r.labels.id }),
  },

  todoLabels: {
    todo: r.one.todos({ from: r.todoLabels.todoId, to: r.todos.id }),
    label: r.one.labels({ from: r.todoLabels.labelId, to: r.labels.id }),
  },

  todoDependencies: {
    todo: r.one.todos({ from: r.todoDependencies.todoId, to: r.todos.id, alias: 'dependencyEdgeTodo' }),
    dependsOnTodo: r.one.todos({
      from: r.todoDependencies.dependsOnTodoId,
      to: r.todos.id,
      alias: 'dependencyEdgeBlocker',
    }),
  },
}));
