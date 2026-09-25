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
    runs: r.many.runs({ from: r.projects.id, to: r.runs.projectId }),
    labels: r.many.labels({
      from: r.projects.id.through(r.projectLabels.projectId),
      to: r.labels.id.through(r.projectLabels.labelId),
    }),
  },

  todos: {
    user: r.one.users({ from: r.todos.userId, to: r.users.id }),
    project: r.one.projects({ from: r.todos.projectId, to: r.projects.id }),
    lane: r.one.lanes({ from: r.todos.laneId, to: r.lanes.id }),
    parent: r.one.todos({ from: r.todos.parentId, to: r.todos.id, alias: 'todoParent' }),
    children: r.many.todos({ from: r.todos.id, to: r.todos.parentId, alias: 'todoParent' }),
    // Not `notes`: that is the todo's own description column.
    thread: r.many.todoNotes({ from: r.todos.id, to: r.todoNotes.todoId }),
    // Named `history` rather than `events`: it reads as what it is on a card.
    history: r.many.todoEvents({ from: r.todos.id, to: r.todoEvents.todoId }),
    runs: r.many.runs({ from: r.todos.id, to: r.runs.todoId }),
    artifacts: r.many.artifacts({ from: r.todos.id, to: r.artifacts.todoId }),
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
    agent: r.one.agents({ from: r.lanes.agentId, to: r.agents.id }),
    onSuccessLane: r.one.lanes({ from: r.lanes.onSuccessLaneId, to: r.lanes.id, alias: 'laneOnSuccess' }),
    onFailureLane: r.one.lanes({ from: r.lanes.onFailureLaneId, to: r.lanes.id, alias: 'laneOnFailure' }),
    runs: r.many.runs({ from: r.lanes.id, to: r.runs.laneId }),
  },

  agents: {
    lanes: r.many.lanes({ from: r.agents.id, to: r.lanes.agentId }),
    runs: r.many.runs({ from: r.agents.id, to: r.runs.agentId }),
  },

  runs: {
    todo: r.one.todos({ from: r.runs.todoId, to: r.todos.id }),
    lane: r.one.lanes({ from: r.runs.laneId, to: r.lanes.id }),
    agent: r.one.agents({ from: r.runs.agentId, to: r.agents.id }),
    project: r.one.projects({ from: r.runs.projectId, to: r.projects.id }),
    artifacts: r.many.artifacts({ from: r.runs.id, to: r.artifacts.runId }),
  },

  drafts: {
    project: r.one.projects({ from: r.drafts.projectId, to: r.projects.id }),
    agent: r.one.agents({ from: r.drafts.agentId, to: r.agents.id }),
    todo: r.one.todos({ from: r.drafts.todoId, to: r.todos.id }),
    messages: r.many.draftMessages({ from: r.drafts.id, to: r.draftMessages.draftId }),
  },

  draftMessages: {
    draft: r.one.drafts({ from: r.draftMessages.draftId, to: r.drafts.id }),
  },

  artifacts: {
    todo: r.one.todos({ from: r.artifacts.todoId, to: r.todos.id }),
    run: r.one.runs({ from: r.artifacts.runId, to: r.runs.id }),
    project: r.one.projects({ from: r.artifacts.projectId, to: r.projects.id }),
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

  todoNotes: {
    todo: r.one.todos({ from: r.todoNotes.todoId, to: r.todos.id }),
  },

  todoEvents: {
    todo: r.one.todos({ from: r.todoEvents.todoId, to: r.todos.id }),
    note: r.one.todoNotes({ from: r.todoEvents.noteId, to: r.todoNotes.id }),
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
