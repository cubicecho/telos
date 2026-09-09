import { index, pgTable, unique, uuid } from 'drizzle-orm/pg-core';

import { labels } from './labels.ts';
import { projects } from './projects.ts';
import { users } from './users.ts';

export const projectLabels = pgTable(
  'project_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => [
    unique('uq_project_labels_pair').on(t.projectId, t.labelId),
    index('idx_project_labels_user_id').on(t.userId),
    index('idx_project_labels_project_id').on(t.projectId),
    index('idx_project_labels_label_id').on(t.labelId),
  ],
);

export type ProjectLabel = typeof projectLabels.$inferSelect;
export type NewProjectLabel = typeof projectLabels.$inferInsert;
