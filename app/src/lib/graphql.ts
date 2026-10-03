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
      autoRun
      ...ProjectLabelFields
    }
  }
`);

// The board's order is `position`; `createdAt` only breaks a tie. The highest
// `priority` sorts first, so `position` has the higher one: the other way
// round, a lane or card moved ahead of an older one snaps back on refetch.
export const ProjectTodosDocument = graphql(`
  query ProjectTodos($projectId: UUID!) {
    todos(
      where: { projectId: { eq: $projectId } }
      orderBy: { position: { direction: asc, priority: 2 }, createdAt: { direction: asc, priority: 1 } }
    ) {
      ...TodoFields
    }
  }
`);

export const ProjectLanesDocument = graphql(`
  query ProjectLanes($projectId: UUID!) {
    lanes(
      where: { projectId: { eq: $projectId } }
      orderBy: { position: { direction: asc, priority: 2 }, createdAt: { direction: asc, priority: 1 } }
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

export const RunRetentionDocument = graphql(`
  query RunRetention {
    users {
      id
      runRetentionDays
    }
  }
`);

export const SetRunRetentionDocument = graphql(`
  mutation SetRunRetention($days: Int) {
    setRunRetention(days: $days) {
      id
      runRetentionDays
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

export const SetProjectAutoRunDocument = graphql(`
  mutation SetProjectAutoRun($projectId: ID!, $enabled: Boolean!) {
    setProjectAutoRun(projectId: $projectId, enabled: $enabled) {
      id
      autoRun
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
    toolsOff
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

// The MCP door's tools, in the order a client is shown them, for a key's
// switches and an agent's.
export const McpToolsDocument = graphql(`
  query McpTools {
    mcpTools {
      name
      description
      writes
      forRuns
      runDefault
    }
  }
`);

export const SetApiKeyToolsDocument = graphql(`
  mutation SetApiKeyTools($id: ID!, $off: [String!]!) {
    setApiKeyTools(id: $id, off: $off) {
      ...ApiKeyFields
    }
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
    mcpServerSlugs
    toolsOff
    hasApiKey
  }
`);

// The account's MCP servers, which its agents name by slug. `headers` and `env`
// are not in the schema: they are written one at a time with
// `setMcpServerSecret`, and all that comes back is their names.

export const McpServerFieldsFragment = graphql(`
  fragment McpServerFields on McpServer {
    id
    slug
    name
    url
    command
    args
    hiddenTools
    hooks
    enabled
    checkedAt
    checkOk
    checkError
    tools
    headerNames
    envNames
  }
`);

export const McpServersDocument = graphql(`
  query McpServers {
    mcpServers(orderBy: { slug: { direction: asc, priority: 1 } }) {
      ...McpServerFields
    }
  }
`);

export const CreateMcpServerDocument = graphql(`
  mutation CreateMcpServer($values: CreateMcpServerInput!) {
    createMcpServer(values: $values) {
      ...McpServerFields
    }
  }
`);

export const UpdateMcpServerDocument = graphql(`
  mutation UpdateMcpServer($id: UUID!, $set: UpdateMcpServerInput!) {
    updateMcpServer(set: $set, where: { id: { eq: $id } }) {
      ...McpServerFields
    }
  }
`);

export const DeleteMcpServerDocument = graphql(`
  mutation DeleteMcpServer($id: UUID!) {
    deleteMcpServer(where: { id: { eq: $id } }) {
      id
    }
  }
`);

export const SetMcpServerSecretDocument = graphql(`
  mutation SetMcpServerSecret($id: ID!, $kind: McpSecretKind!, $name: String!, $value: String) {
    setMcpServerSecret(id: $id, kind: $kind, name: $name, value: $value) {
      id
      headerNames
      envNames
    }
  }
`);

export const TestMcpServerDocument = graphql(`
  mutation TestMcpServer($id: ID!) {
    testMcpServer(id: $id) {
      id
    }
  }
`);

export const McpProbeDocument = graphql(`
  query McpProbe($id: ID!) {
    mcpProbe(id: $id) {
      id
      status
      ok
      tools {
        name
        description
      }
      error
    }
  }
`);

export const AgentModelsDocument = graphql(`
  query AgentModels($baseUrl: String!, $agentId: ID) {
    agentModels(baseUrl: $baseUrl, agentId: $agentId) {
      id
      contextLength
    }
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
    archiveOnSuccess
    wipLimit
    maxAttempts
    presetId
    presetOverrides
  }
`);

// A preset: a station's contract, prompt and limits, kept on the account. A
// lane that follows one (`presetId`) holds its values, bar the fields named in
// the lane's `presetOverrides`, and adds its own prompt after the preset's.
export const LanePresetFieldsFragment = graphql(`
  fragment LanePresetFields on LanePreset {
    id
    name
    contract
    prompt
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
    lanePresets(orderBy: { name: { direction: asc, priority: 1 } }) {
      ...LanePresetFields
    }
  }
`);

// The presets with the lanes that follow each, for the settings page.
export const LanePresetsDocument = graphql(`
  query LanePresets {
    lanePresets(orderBy: { name: { direction: asc, priority: 1 } }) {
      ...LanePresetFields
      lanes {
        id
        name
        presetOverrides
        project {
          id
          name
        }
      }
    }
  }
`);

export const CreateLanePresetDocument = graphql(`
  mutation CreateLanePreset($values: CreateLanePresetInput!) {
    createLanePreset(values: $values) {
      ...LanePresetFields
    }
  }
`);

export const UpdateLanePresetDocument = graphql(`
  mutation UpdateLanePreset($id: UUID!, $set: UpdateLanePresetInput!) {
    updateLanePreset(set: $set, where: { id: { eq: $id } }) {
      ...LanePresetFields
    }
  }
`);

export const DeleteLanePresetDocument = graphql(`
  mutation DeleteLanePreset($id: UUID!) {
    deleteLanePreset(where: { id: { eq: $id } }) {
      id
    }
  }
`);

export const SaveLaneAsPresetDocument = graphql(`
  mutation SaveLaneAsPreset($laneId: ID!, $name: String!, $id: ID) {
    saveLaneAsPreset(laneId: $laneId, name: $name, id: $id) {
      ...LanePresetFields
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
// A run is a station's work on a todo or an agent's reply in a draft (`kind`),
// and has the todo and lane, or the draft, to match.
export const RunSummaryFieldsFragment = graphql(`
  fragment RunSummaryFields on Run {
    id
    kind
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
    draft {
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
    todoId
    todoTitle
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

/** Takes an artifact off the board. What it points at stays where it was stored. */
export const DeleteArtifactDocument = graphql(`
  mutation DeleteArtifact($id: ID!) {
    deleteArtifact(id: $id)
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
 * `spent` is every run; `draftSpent` is how much of it was replies in drafts.
 */
export const ProjectActivityDocument = graphql(`
  query ProjectActivity($projectId: UUID!, $project: ID!, $since: DateTime!) {
    stations: aiStatus(projectId: $project) {
      todos {
        todoId
        state
        reason
        failures
        awaitsRun
        runRequested
      }
    }
    live: runs(where: { projectId: { eq: $projectId }, status: { eq: "running" } }) {
      id
      kind
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
    draftSpent: runsAggregate(
      where: { projectId: { eq: $projectId }, kind: { eq: "draft" }, startedAt: { gte: $since } }
    ) {
      count
      sum {
        totalTokens
      }
    }
  }
`);

/**
 * Everything made for a project's todos, newest first, with the todo each is
 * on: the whole of it, so a note artifact can open that todo's dialog. One
 * whose todo was deleted has no todo, only the title it had (`todoTitle`).
 */
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
        ...TodoFields
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
    editedAt
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
      draft {
        id
        runs(orderBy: { startedAt: { direction: asc, priority: 1 } }) {
          ...RunSummaryFields
        }
      }
      project {
        id
        aiEnabled
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

export const EditTodoNoteDocument = graphql(`
  mutation EditTodoNote($id: ID!, $body: String!) {
    editTodoNote(id: $id, body: $body) {
      ...TodoNoteFields
    }
  }
`);

export const DeleteTodoNoteDocument = graphql(`
  mutation DeleteTodoNote($id: ID!) {
    deleteTodoNote(id: $id) {
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

/** What is in place for a first run, for the setup checklist. */
export const AiSetupDocument = graphql(`
  query AiSetup {
    aiSetup {
      agent
      station
      stationProjectIds
      projectAi
      request
      started
      runnerSeenAt
    }
  }
`);

/**
 * What a board's cards have to show: notes, and how each todo's last run went.
 * Only todos with something to mark come back. An active query, so it follows
 * `boardChanged` with the rest of the board.
 */
export const CardMarksDocument = graphql(`
  query CardMarks($projectId: ID!) {
    cardMarks(projectId: $projectId) {
      todoId
      notes
      lastRun
      reason
      runId
      attempts
      maxAttempts
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

export const RunTodoDocument = graphql(`
  mutation RunTodo($id: ID!) {
    runTodo(id: $id) {
      id
    }
  }
`);

// The account's activity: what its agents did, spent and left behind across
// every project it owns. The lists are the generated ones with no project named,
// which are the account's own already; each row says which project it is from.

/** The account's runs, newest first, a page at a time, optionally of one status. */
export const AccountRunsDocument = graphql(`
  query AccountRuns($where: RunFilters, $limit: Int!, $offset: Int!) {
    runs(where: $where, orderBy: { startedAt: { direction: desc, priority: 1 } }, limit: $limit, offset: $offset) {
      ...RunSummaryFields
      project {
        id
        name
      }
    }
  }
`);

/**
 * Everything the account's runs left behind, newest first. The todo is the
 * whole of it, so a note artifact can open that todo's dialog; an artifact
 * whose todo is gone has none.
 */
export const AccountArtifactsDocument = graphql(`
  query AccountArtifacts($limit: Int!, $offset: Int!) {
    artifacts(orderBy: { createdAt: { direction: desc, priority: 1 } }, limit: $limit, offset: $offset) {
      ...ArtifactFields
      project {
        id
        name
      }
      todo {
        ...TodoFields
      }
    }
  }
`);

/** The account's archived todos, the latest put away first, a page at a time. */
export const AccountArchivedTodosDocument = graphql(`
  query AccountArchivedTodos($limit: Int!, $offset: Int!) {
    todos(
      deleted: ONLY
      orderBy: { archivedAt: { direction: desc, priority: 1 } }
      limit: $limit
      offset: $offset
    ) {
      id
      title
      completedAt
      archivedAt
      lane {
        id
        name
      }
      project {
        id
        name
      }
    }
  }
`);

export const SpendLineFieldsFragment = graphql(`
  fragment SpendLineFields on SpendLine {
    id
    name
    runs
    draftReplies
    promptTokens
    completionTokens
    totalTokens
  }
`);

/** What the account's runs spent since `since`, by project and by agent. */
export const AccountSpendDocument = graphql(`
  query AccountSpend($since: DateTime!) {
    accountSpend(since: $since) {
      since
      keptSince
      retentionDays
      total {
        ...SpendLineFields
      }
      byProject {
        ...SpendLineFields
      }
      byAgent {
        ...SpendLineFields
      }
    }
  }
`);

/** The todos, across projects, that are out of attempts or whose last run errored. */
export const AccountAttentionDocument = graphql(`
  query AccountAttention {
    accountAttention {
      todoId
      title
      projectId
      projectName
      laneId
      laneName
      outOfAttempts
      errored
      reason
      runId
      attempts
      maxAttempts
    }
  }
`);

export const BoardTemplatesDocument = graphql(`
  query BoardTemplates {
    boardTemplates(orderBy: { name: { direction: asc, priority: 1 } }) {
      id
      name
      lanes
    }
  }
`);

export const SaveBoardTemplateDocument = graphql(`
  mutation SaveBoardTemplate($projectId: ID!, $name: String!) {
    saveBoardTemplate(projectId: $projectId, name: $name) {
      id
      name
      lanes
    }
  }
`);

export const ApplyBoardTemplateDocument = graphql(`
  mutation ApplyBoardTemplate($projectId: ID!, $templateId: ID!) {
    applyBoardTemplate(projectId: $projectId, templateId: $templateId) {
      id
    }
  }
`);

export const DeleteBoardTemplateDocument = graphql(`
  mutation DeleteBoardTemplate($id: UUID!) {
    deleteBoardTemplate(where: { id: { eq: $id } }) {
      id
    }
  }
`);

export const SearchTodosDocument = graphql(`
  query SearchTodos($text: String!) {
    todos(
      where: { OR: [{ title: { iContains: $text } }, { notes: { iContains: $text } }] }
      orderBy: { updatedAt: { direction: desc, priority: 1 } }
      limit: 20
    ) {
      ...TodoFields
      project {
        id
        name
      }
    }
  }
`);

// Drafts: talking a request over with an agent before it becomes a todo.
// The runner answers, so an open draft polls while it waits.

export const DraftFieldsFragment = graphql(`
  fragment DraftFields on Draft {
    id
    projectId
    agentId
    title
    brief
    waitingSince
    error
    todoId
    updatedAt
  }
`);

export const DraftDocument = graphql(`
  query Draft($id: UUID!) {
    draft(where: { id: { eq: $id } }) {
      ...DraftFields
      agent {
        id
        name
      }
      messages(orderBy: { createdAt: { direction: asc, priority: 1 } }) {
        id
        role
        content
      }
      runs(orderBy: { startedAt: { direction: desc, priority: 1 } }) {
        ...RunSummaryFields
      }
    }
  }
`);

export const OpenDraftsDocument = graphql(`
  query OpenDrafts($projectId: UUID!) {
    drafts(
      where: { projectId: { eq: $projectId }, todoId: { isNull: true } }
      orderBy: { updatedAt: { direction: desc, priority: 1 } }
      limit: 5
    ) {
      ...DraftFields
    }
  }
`);

export const StartDraftDocument = graphql(`
  mutation StartDraft($projectId: ID!, $agentId: ID!, $message: String!) {
    startDraft(projectId: $projectId, agentId: $agentId, message: $message) {
      ...DraftFields
    }
  }
`);

export const SayToDraftDocument = graphql(`
  mutation SayToDraft($id: ID!, $message: String!) {
    sayToDraft(id: $id, message: $message) {
      ...DraftFields
    }
  }
`);

export const StopDraftDocument = graphql(`
  mutation StopDraft($id: ID!) {
    stopDraft(id: $id) {
      ...DraftFields
    }
  }
`);

export const MakeTodoFromDraftDocument = graphql(`
  mutation MakeTodoFromDraft($id: ID!, $title: String, $brief: String) {
    makeTodoFromDraft(id: $id, title: $title, brief: $brief) {
      id
      title
    }
  }
`);

export const DiscardDraftDocument = graphql(`
  mutation DiscardDraft($id: ID!) {
    discardDraft(id: $id)
  }
`);

export const BoardChangedDocument = graphql(`
  subscription BoardChanged($projectId: ID!) {
    boardChanged(projectId: $projectId) {
      projectId
      table
    }
  }
`);
