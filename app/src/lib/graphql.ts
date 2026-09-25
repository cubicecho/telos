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

// AI. Whether the server offers AI (`authConfig.aiAvailable`) decides whether
// any of the documents below exist in its schema at all, and the instance's
// switch (`authConfig.ai`) whether they do anything: they are generated into
// the app's types regardless, so every screen that sends one checks `useAi`
// first. Off, not one of them is sent, bar an admin's instance switch.

export const AiStateDocument = graphql(`
  query AiState {
    authConfig {
      ai
      aiAvailable
    }
    users {
      id
      aiEnabled
      isAdmin
    }
  }
`);

export const SetInstanceAiEnabledDocument = graphql(`
  mutation SetInstanceAiEnabled($enabled: Boolean!) {
    setInstanceAiEnabled(enabled: $enabled) {
      ai
      aiAvailable
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

// Agents, and the lanes they work as stations. `apiKey` is not in the schema:
// it is written with `setAgentApiKey`, and all that comes back is `hasApiKey`.

export const AgentFieldsFragment = graphql(`
  fragment AgentFields on Agent {
    id
    name
    baseUrl
    model
    systemPrompt
    temperature
    maxTokens
    contextLength
    maxToolIterations
    toolDiscovery
    toolSelectModel
    requestTimeoutSeconds
    maxRetries
    mcpServers
    hasApiKey
  }
`);

export const AgentsDocument = graphql(`
  query Agents {
    agents(orderBy: { name: { direction: asc, priority: 1 } }) {
      ...AgentFields
    }
  }
`);

export const CreateAgentDocument = graphql(`
  mutation CreateAgent($values: CreateAgentInput!) {
    createAgent(values: $values) {
      ...AgentFields
    }
  }
`);

export const UpdateAgentDocument = graphql(`
  mutation UpdateAgent($id: UUID!, $set: UpdateAgentInput!) {
    updateAgent(set: $set, where: { id: { eq: $id } }) {
      ...AgentFields
    }
  }
`);

export const DeleteAgentDocument = graphql(`
  mutation DeleteAgent($id: UUID!) {
    deleteAgent(where: { id: { eq: $id } }) {
      id
    }
  }
`);

export const SetAgentApiKeyDocument = graphql(`
  mutation SetAgentApiKey($agentId: ID!, $apiKey: String) {
    setAgentApiKey(agentId: $agentId, apiKey: $apiKey) {
      id
      hasApiKey
    }
  }
`);

// The station columns exist only while the instance has AI, so they are not
// in `LaneFields` — every board would ask for fields the server does not have.
// Read on their own, they land on the same normalized `Lane` rows.
export const StationFieldsFragment = graphql(`
  fragment StationFields on Lane {
    id
    agentId
    contract
    prompt
    onSuccessLaneId
    onFailureLaneId
    wipLimit
    maxAttempts
  }
`);

export const ProjectStationsDocument = graphql(`
  query ProjectStations($projectId: UUID!) {
    lanes(where: { projectId: { eq: $projectId } }) {
      ...StationFields
    }
    agents(orderBy: { name: { direction: asc, priority: 1 } }) {
      id
      name
    }
  }
`);

export const UpdateStationDocument = graphql(`
  mutation UpdateStation($id: UUID!, $set: UpdateLaneInput!) {
    updateLane(set: $set, where: { id: { eq: $id } }) {
      ...StationFields
    }
  }
`);

// Runs and what they left behind: a todo's, read by the todo dialog, and a
// project's, read by its Runs and Artifacts views and the board's live marks.
// Read only while AI is on for the account.

// A run's summary is what a list polls: no log, no prompts, no output, which
// are the heavy parts. RunFields adds them, for a run someone has opened.
export const RunSummaryFieldsFragment = graphql(`
  fragment RunSummaryFields on Run {
    id
    status
    verdict
    contract
    error
    toolCalls
    promptTokens
    completionTokens
    totalTokens
    model
    startedAt
    finishedAt
    cancelRequestedAt
    agent {
      id
      name
    }
    lane {
      id
      name
    }
    todo {
      id
      title
    }
  }
`);

export const RunFieldsFragment = graphql(`
  fragment RunFields on Run {
    ...RunSummaryFields
    output
    events
    systemPrompt
    userPrompt
  }
`);

export const ArtifactFieldsFragment = graphql(`
  fragment ArtifactFields on Artifact {
    id
    location
    source
    action
    serverSlug
    tool
    title
    description
    mediaType
    sizeBytes
    createdAt
  }
`);

export const TodoRunsDocument = graphql(`
  query TodoRuns($id: UUID!) {
    todo(where: { id: { eq: $id } }) {
      id
      project {
        id
        aiEnabled
      }
      runs(orderBy: { startedAt: { direction: desc, priority: 1 } }) {
        ...RunSummaryFields
      }
      artifacts(orderBy: { createdAt: { direction: desc, priority: 1 } }) {
        ...ArtifactFields
      }
    }
  }
`);

export const CancelRunDocument = graphql(`
  mutation CancelRun($id: ID!) {
    cancelRun(id: $id) {
      ...RunSummaryFields
    }
  }
`);

export const DeleteRunDocument = graphql(`
  mutation DeleteRun($id: ID!) {
    deleteRun(id: $id)
  }
`);

/** One run, for a view that follows it as it goes. */
export const RunDocument = graphql(`
  query Run($id: UUID!) {
    run(where: { id: { eq: $id } }) {
      ...RunFields
    }
  }
`);

/** A project's runs, newest first, a page at a time, optionally of one status. */
export const ProjectRunsDocument = graphql(`
  query ProjectRuns($where: RunFilters!, $limit: Int!, $offset: Int!) {
    runs(where: $where, orderBy: { startedAt: { direction: desc, priority: 1 } }, limit: $limit, offset: $offset) {
      ...RunSummaryFields
    }
  }
`);

/**
 * What a project's agents are doing now, and have spent since `since`: the
 * board's live marks and the project header's figures, polled together.
 */
export const ProjectActivityDocument = graphql(`
  query ProjectActivity($projectId: UUID!, $project: ID!, $since: DateTime!) {
    stations: aiStatus(projectId: $project) {
      todos {
        todoId
        state
        reason
        failures
      }
    }
    live: runs(where: { projectId: { eq: $projectId }, status: { eq: "running" } }) {
      id
      todoId
      laneId
      cancelRequestedAt
      agent {
        id
        name
      }
    }
    spent: runsAggregate(where: { projectId: { eq: $projectId }, startedAt: { gte: $since } }) {
      count
      sum {
        promptTokens
        completionTokens
        totalTokens
      }
    }
  }
`);

/** Everything a project's runs left behind, newest first, with the todo each is on. */
export const ProjectArtifactsDocument = graphql(`
  query ProjectArtifacts($projectId: UUID!, $limit: Int!, $offset: Int!) {
    artifacts(
      where: { projectId: { eq: $projectId } }
      orderBy: { createdAt: { direction: desc, priority: 1 } }
      limit: $limit
      offset: $offset
    ) {
      ...ArtifactFields
      todo {
        id
        title
      }
    }
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
    runId
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
        runId
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

// Deleting a todo archives it (the server's `softDelete`): out of every list
// until restored. Only `hard: true` removes it.
export const ArchiveTodoDocument = graphql(`
  mutation ArchiveTodo($id: UUID!) {
    deleteTodo(where: { id: { eq: $id } }) {
      id
    }
  }
`);

export const ArchivedTodosDocument = graphql(`
  query ArchivedTodos($projectId: UUID!) {
    todos(
      where: { projectId: { eq: $projectId } }
      deleted: ONLY
      orderBy: { archivedAt: { direction: desc, priority: 1 } }
    ) {
      id
      title
      completedAt
      archivedAt
      lane {
        id
        name
      }
    }
  }
`);

export const RestoreTodoDocument = graphql(`
  mutation RestoreTodo($id: UUID!) {
    restoreTodo(where: { id: { eq: $id } }) {
      id
    }
  }
`);

export const DeleteTodoForGoodDocument = graphql(`
  mutation DeleteTodoForGood($id: UUID!) {
    deleteTodo(where: { id: { eq: $id } }, hard: true) {
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

/** Where every open todo stands with the stations, across the AI projects. */
export const AiStatusDocument = graphql(`
  query AiStatus {
    aiStatus {
      todos {
        todoId
        title
        projectId
        laneId
        state
        reason
        failures
        liveRunId
      }
      projects {
        projectId
        name
        lanes {
          laneId
          name
          station
          isDone
          attention
          running
          blocked
          queued
          parked
          done
        }
      }
      runnerSeenAt
    }
  }
`);

/** Just how many todos need a person, for the sidebar. */
export const AiAttentionDocument = graphql(`
  query AiAttention {
    aiStatus {
      todos {
        todoId
        state
      }
    }
  }
`);

/** The most recent runs that failed, anywhere. */
export const RecentFailuresDocument = graphql(`
  query RecentFailures($since: DateTime!) {
    runs(
      where: { status: { eq: "error" }, startedAt: { gte: $since } }
      orderBy: { startedAt: { direction: desc, priority: 1 } }
      limit: 10
    ) {
      ...RunSummaryFields
      project {
        id
        name
      }
    }
  }
`);

export const RetryTodoDocument = graphql(`
  mutation RetryTodo($id: ID!, $reason: String) {
    retryTodo(id: $id, reason: $reason)
  }
`);
