import { graphql } from '@/__generated__';

// Every document the app sends, in one place. The generated CRUD is wide — most
// of it is filters and pagination this app has no use for — so these are the
// deliberate slice of it Telos actually reads and writes.
//
// The fragments below are load-bearing rather than tidy: a mutation writes its
// result straight into the query's cache entry, so the two selections have to
// agree exactly — down to a field's arguments, which are part of the key Apollo
// stores it under. Sharing one fragment is what makes that true by construction:
// a field added to a list is a field the mutation starts returning, instead of a
// half-written entity the next read has to go and fetch.
//
// It is also why the writes that change a todo through a junction table —
// attaching a label, adding a dependency — return the whole todo rather than the
// row they inserted. The entity is normalized, so one full selection settles
// every list and screen holding it, and no refetch is needed to learn what the
// write did.

export const ProjectListFieldsFragment = graphql(`
  fragment ProjectListFields on Project {
    id
    name
    todoCount
    openTodoCount
  }
`);

export const TodoFieldsFragment = graphql(`
  fragment TodoFields on Todo {
    id
    title
    notes
    acceptance
    aiIgnored
    parentId
    dueAt
    completedAt
    position
    isBlocked
    blockedBy {
      id
      title
    }
    dependencies {
      id
      title
      completedAt
    }
    labels(orderBy: { name: { direction: asc, priority: 1 } }) {
      ...LabelFields
    }
    lane {
      ...LaneFields
    }
  }
`);

export const ProjectLabelFieldsFragment = graphql(`
  fragment ProjectLabelFields on Project {
    id
    labels(orderBy: { name: { direction: asc, priority: 1 } }) {
      ...LabelFields
    }
  }
`);

export const LaneFieldsFragment = graphql(`
  fragment LaneFields on Lane {
    id
    name
    position
    isDone
  }
`);

export const LabelFieldsFragment = graphql(`
  fragment LabelFields on Label {
    id
    name
    color
  }
`);

export const ProjectsDocument = graphql(`
  query Projects {
    projects(where: { archivedAt: { isNull: true } }, orderBy: { name: { direction: asc, priority: 1 } }) {
      ...ProjectListFields
    }
  }
`);

export const ProjectDocument = graphql(`
  query Project($id: UUID!) {
    project(where: { id: { eq: $id } }) {
      id
      name
      description
      createdAt
      todoCount
      openTodoCount
      aiEnabled
      ...ProjectLabelFields
    }
  }
`);

export const ProjectTodosDocument = graphql(`
  query ProjectTodos($projectId: UUID!) {
    todos(
      where: { projectId: { eq: $projectId } }
      orderBy: { position: { direction: asc, priority: 1 }, createdAt: { direction: asc, priority: 2 } }
    ) {
      ...TodoFields
    }
  }
`);

export const ProjectLanesDocument = graphql(`
  query ProjectLanes($projectId: UUID!) {
    lanes(
      where: { projectId: { eq: $projectId } }
      orderBy: { position: { direction: asc, priority: 1 }, createdAt: { direction: asc, priority: 2 } }
    ) {
      ...LaneFields
    }
  }
`);

export const LabelsDocument = graphql(`
  query Labels {
    labels(orderBy: { name: { direction: asc, priority: 1 } }) {
      ...LabelFields
    }
  }
`);

export const MeDocument = graphql(`
  query Me {
    users {
      id
      email
      name
    }
  }
`);

// AI. The instance's switch (`authConfig.ai`) decides whether any of the
// documents below exist in the server's schema at all: they are generated into
// the app's types regardless, so every screen that sends one checks `useAi`
// first. Off, not one of them is sent.

export const AiStateDocument = graphql(`
  query AiState {
    authConfig {
      ai
    }
    users {
      id
      aiEnabled
    }
  }
`);

export const SetAiEnabledDocument = graphql(`
  mutation SetAiEnabled($enabled: Boolean!) {
    setAiEnabled(enabled: $enabled) {
      id
      aiEnabled
    }
  }
`);

export const SetProjectAiEnabledDocument = graphql(`
  mutation SetProjectAiEnabled($projectId: ID!, $enabled: Boolean!) {
    setProjectAiEnabled(projectId: $projectId, enabled: $enabled) {
      id
      aiEnabled
    }
  }
`);

export const ApiKeyFieldsFragment = graphql(`
  fragment ApiKeyFields on ApiKey {
    id
    name
    start
    createdAt
    lastRequest
    expiresAt
  }
`);

export const ApiKeysDocument = graphql(`
  query ApiKeys {
    apiKeys {
      ...ApiKeyFields
    }
  }
`);

export const CreateApiKeyDocument = graphql(`
  mutation CreateApiKey($name: String!, $expiresInDays: Int) {
    createApiKey(name: $name, expiresInDays: $expiresInDays) {
      key
      apiKey {
        ...ApiKeyFields
      }
    }
  }
`);

export const DeleteApiKeyDocument = graphql(`
  mutation DeleteApiKey($id: ID!) {
    deleteApiKey(id: $id)
  }
`);

// A todo's record: its notes thread and the history the database trigger
// writes. Read only by the todo dialog, so neither is in `TodoFields`.

export const TodoNoteFieldsFragment = graphql(`
  fragment TodoNoteFields on TodoNote {
    id
    kind
    body
    actorKind
    createdAt
  }
`);

export const TodoRecordDocument = graphql(`
  query TodoRecord($id: UUID!) {
    todo(where: { id: { eq: $id } }) {
      id
      thread(orderBy: { createdAt: { direction: asc, priority: 1 } }) {
        ...TodoNoteFields
      }
      history(orderBy: { at: { direction: asc, priority: 1 } }) {
        id
        kind
        fromLaneId
        toLaneId
        fields
        actorKind
        reason
        at
      }
      project {
        id
        lanes {
          id
          name
        }
      }
    }
  }
`);

export const CreateTodoNoteDocument = graphql(`
  mutation CreateTodoNote($todoId: UUID!, $body: String!) {
    createTodoNote(values: { todoId: $todoId, body: $body }) {
      ...TodoNoteFields
    }
  }
`);

export const DeleteTodoNoteDocument = graphql(`
  mutation DeleteTodoNote($id: UUID!) {
    deleteTodoNote(where: { id: { eq: $id } }) {
      id
    }
  }
`);

export const CreateProjectDocument = graphql(`
  mutation CreateProject($values: CreateProjectInput!) {
    createProject(values: $values) {
      ...ProjectListFields
    }
  }
`);

export const UpdateProjectDocument = graphql(`
  mutation UpdateProject($id: UUID!, $set: UpdateProjectInput!) {
    updateProject(set: $set, where: { id: { eq: $id } }) {
      id
      name
      description
    }
  }
`);

export const DeleteProjectDocument = graphql(`
  mutation DeleteProject($id: UUID!) {
    deleteProject(where: { id: { eq: $id } }) {
      id
    }
  }
`);

export const CreateTodoDocument = graphql(`
  mutation CreateTodo($values: CreateTodoInput!) {
    createTodo(values: $values) {
      ...TodoFields
    }
  }
`);

export const UpdateTodoDocument = graphql(`
  mutation UpdateTodo($id: UUID!, $set: UpdateTodoInput!) {
    updateTodo(set: $set, where: { id: { eq: $id } }) {
      id
      title
      notes
      acceptance
      aiIgnored
      dueAt
    }
  }
`);

export const DeleteTodoDocument = graphql(`
  mutation DeleteTodo($id: UUID!) {
    deleteTodo(where: { id: { eq: $id } }) {
      id
    }
  }
`);

export const CompleteTodoDocument = graphql(`
  mutation CompleteTodo($id: ID!) {
    completeTodo(id: $id) {
      id
      completedAt
      isBlocked
      lane {
        ...LaneFields
      }
    }
  }
`);

export const ReopenTodoDocument = graphql(`
  mutation ReopenTodo($id: ID!) {
    reopenTodo(id: $id) {
      id
      completedAt
      isBlocked
      lane {
        ...LaneFields
      }
    }
  }
`);

export const MoveTodoDocument = graphql(`
  mutation MoveTodo($id: ID!, $laneId: ID!, $position: Int) {
    moveTodo(id: $id, laneId: $laneId, position: $position) {
      id
      completedAt
      position
      isBlocked
      lane {
        ...LaneFields
      }
    }
  }
`);

export const CreateLaneDocument = graphql(`
  mutation CreateLane($values: CreateLaneInput!) {
    createLane(values: $values) {
      ...LaneFields
    }
  }
`);

export const RenameLaneDocument = graphql(`
  mutation RenameLane($id: UUID!, $name: String!) {
    updateLane(set: { name: $name }, where: { id: { eq: $id } }) {
      ...LaneFields
    }
  }
`);

export const DeleteLaneDocument = graphql(`
  mutation DeleteLane($id: UUID!) {
    deleteLane(where: { id: { eq: $id } }) {
      id
    }
  }
`);

export const SetDoneLaneDocument = graphql(`
  mutation SetDoneLane($projectId: ID!, $laneId: ID) {
    setDoneLane(projectId: $projectId, laneId: $laneId) {
      ...LaneFields
    }
  }
`);

export const ReorderLanesDocument = graphql(`
  mutation ReorderLanes($projectId: ID!, $laneIds: [ID!]!) {
    reorderLanes(projectId: $projectId, laneIds: $laneIds) {
      ...LaneFields
    }
  }
`);

export const AddTodoDependencyDocument = graphql(`
  mutation AddTodoDependency($todoId: ID!, $dependsOnTodoId: ID!) {
    addTodoDependency(todoId: $todoId, dependsOnTodoId: $dependsOnTodoId) {
      ...TodoFields
    }
  }
`);

export const RemoveTodoDependencyDocument = graphql(`
  mutation RemoveTodoDependency($todoId: ID!, $dependsOnTodoId: ID!) {
    removeTodoDependency(todoId: $todoId, dependsOnTodoId: $dependsOnTodoId) {
      ...TodoFields
    }
  }
`);

export const CreateLabelDocument = graphql(`
  mutation CreateLabel($values: CreateLabelInput!) {
    createLabel(values: $values) {
      ...LabelFields
    }
  }
`);

export const UpdateLabelDocument = graphql(`
  mutation UpdateLabel($id: UUID!, $set: UpdateLabelInput!) {
    updateLabel(set: $set, where: { id: { eq: $id } }) {
      ...LabelFields
    }
  }
`);

export const DeleteLabelDocument = graphql(`
  mutation DeleteLabel($id: UUID!) {
    deleteLabel(where: { id: { eq: $id } }) {
      id
    }
  }
`);

export const AttachTodoLabelDocument = graphql(`
  mutation AttachTodoLabel($todoId: UUID!, $labelId: UUID!) {
    createTodoLabel(values: { todoId: $todoId, labelId: $labelId }) {
      id
      todo {
        ...TodoFields
      }
    }
  }
`);

export const DetachTodoLabelDocument = graphql(`
  mutation DetachTodoLabel($todoId: UUID!, $labelId: UUID!) {
    deleteTodoLabel(where: { todoId: { eq: $todoId }, labelId: { eq: $labelId } }) {
      id
      todo {
        ...TodoFields
      }
    }
  }
`);

export const AttachProjectLabelDocument = graphql(`
  mutation AttachProjectLabel($projectId: UUID!, $labelId: UUID!) {
    createProjectLabel(values: { projectId: $projectId, labelId: $labelId }) {
      id
      project {
        ...ProjectLabelFields
      }
    }
  }
`);

export const DetachProjectLabelDocument = graphql(`
  mutation DetachProjectLabel($projectId: UUID!, $labelId: UUID!) {
    deleteProjectLabel(where: { projectId: { eq: $projectId }, labelId: { eq: $labelId } }) {
      id
      project {
        ...ProjectLabelFields
      }
    }
  }
`);

export const RequestMagicLinkDocument = graphql(`
  mutation RequestMagicLink($email: String!) {
    requestMagicLink(email: $email) {
      ok
      magicLink
      token
      userId
    }
  }
`);

export const VerifyMagicLinkDocument = graphql(`
  mutation VerifyMagicLink($token: String!) {
    verifyMagicLink(token: $token) {
      token
      userId
    }
  }
`);
