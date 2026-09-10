import { graphql } from '@/__generated__';

// Every document the app sends, in one place. The generated CRUD is wide — most
// of it is filters and pagination this app has no use for — so these are the
// deliberate slice of it Telos actually reads and writes.
//
// The three fragments below are load-bearing rather than tidy: a create
// mutation writes its result straight into the list query's cache entry, so the
// two selections have to agree exactly. Sharing one fragment is what makes that
// true by construction — a field added to a list is a field the mutation starts
// returning, instead of a half-written entity the next read has to go and fetch.

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
      id
      name
      color
    }
    lane {
      ...LaneFields
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
      labels(orderBy: { name: { direction: asc, priority: 1 } }) {
        id
        name
        color
      }
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

export const CreateProjectDocument = graphql(`
  mutation CreateProject($values: CreateProjectInput!) {
    createProject(values: $values) {
      ...ProjectListFields
    }
  }
`);

export const UpdateProjectDocument = graphql(`
  mutation UpdateProject($id: UUID!, $set: UpdateProjectInput!) {
    updateProjectSingle(set: $set, where: { id: { eq: $id } }) {
      id
      name
      description
    }
  }
`);

export const DeleteProjectDocument = graphql(`
  mutation DeleteProject($id: UUID!) {
    deleteProjectSingle(where: { id: { eq: $id } }) {
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
    updateTodoSingle(set: $set, where: { id: { eq: $id } }) {
      id
      title
    }
  }
`);

export const DeleteTodoDocument = graphql(`
  mutation DeleteTodo($id: UUID!) {
    deleteTodoSingle(where: { id: { eq: $id } }) {
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
    updateLaneSingle(set: { name: $name }, where: { id: { eq: $id } }) {
      ...LaneFields
    }
  }
`);

export const DeleteLaneDocument = graphql(`
  mutation DeleteLane($id: UUID!) {
    deleteLaneSingle(where: { id: { eq: $id } }) {
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
      id
      isBlocked
    }
  }
`);

export const RemoveTodoDependencyDocument = graphql(`
  mutation RemoveTodoDependency($todoId: ID!, $dependsOnTodoId: ID!) {
    removeTodoDependency(todoId: $todoId, dependsOnTodoId: $dependsOnTodoId) {
      id
      isBlocked
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
    updateLabelSingle(set: $set, where: { id: { eq: $id } }) {
      ...LabelFields
    }
  }
`);

export const DeleteLabelDocument = graphql(`
  mutation DeleteLabel($id: UUID!) {
    deleteLabelSingle(where: { id: { eq: $id } }) {
      id
    }
  }
`);

export const AttachTodoLabelDocument = graphql(`
  mutation AttachTodoLabel($todoId: UUID!, $labelId: UUID!) {
    createTodoLabel(values: { todoId: $todoId, labelId: $labelId }) {
      id
    }
  }
`);

export const DetachTodoLabelDocument = graphql(`
  mutation DetachTodoLabel($todoId: UUID!, $labelId: UUID!) {
    deleteTodoLabel(where: { todoId: { eq: $todoId }, labelId: { eq: $labelId } }) {
      id
    }
  }
`);

export const AttachProjectLabelDocument = graphql(`
  mutation AttachProjectLabel($projectId: UUID!, $labelId: UUID!) {
    createProjectLabel(values: { projectId: $projectId, labelId: $labelId }) {
      id
    }
  }
`);

export const DetachProjectLabelDocument = graphql(`
  mutation DetachProjectLabel($projectId: UUID!, $labelId: UUID!) {
    deleteProjectLabel(where: { projectId: { eq: $projectId }, labelId: { eq: $labelId } }) {
      id
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
