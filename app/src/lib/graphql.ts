import { graphql } from '@/__generated__';

// Every document the app sends, in one place. The generated CRUD is wide — most
// of it is filters and pagination this app has no use for — so these are the
// deliberate slice of it Telos actually reads and writes.

export const ProjectsDocument = graphql(`
  query Projects {
    projects(where: { archivedAt: { isNull: true } }, orderBy: { name: { direction: asc, priority: 1 } }) {
      id
      name
      todoCount
      openTodoCount
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
    }
  }
`);

export const LabelsDocument = graphql(`
  query Labels {
    labels(orderBy: { name: { direction: asc, priority: 1 } }) {
      id
      name
      color
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
      id
      name
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
      id
      title
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
    }
  }
`);

export const ReopenTodoDocument = graphql(`
  mutation ReopenTodo($id: ID!) {
    reopenTodo(id: $id) {
      id
      completedAt
      isBlocked
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
      id
      name
      color
    }
  }
`);

export const UpdateLabelDocument = graphql(`
  mutation UpdateLabel($id: UUID!, $set: UpdateLabelInput!) {
    updateLabelSingle(set: $set, where: { id: { eq: $id } }) {
      id
      name
      color
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
