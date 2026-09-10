import { useMutation } from '@apollo/client';
import { type CachedLane, updateProjectLanes } from '@/lib/cache';
import {
  CreateLaneDocument,
  DeleteLaneDocument,
  ProjectDocument,
  ProjectsDocument,
  ProjectTodosDocument,
  RenameLaneDocument,
  ReorderLanesDocument,
  SetDoneLaneDocument,
} from '@/lib/graphql';
import { newId } from '@/lib/ids';

/**
 * Everything the board can do to its own columns.
 *
 * Adding, renaming and reordering touch nothing but the lane rows, so they are
 * written to the cache immediately. Deleting a lane and moving the done flag
 * both reach into the todos — one rehomes the cards it held, the other ticks
 * off or reopens everything in the column — and neither effect is something the
 * client can name, so those ask the server what happened.
 */
export function useLaneActions(projectId: string) {
  const refetchQueries = [
    { query: ProjectTodosDocument, variables: { projectId } },
    { query: ProjectDocument, variables: { id: projectId } },
    ProjectsDocument,
  ];

  const [create] = useMutation(CreateLaneDocument);
  const [rename] = useMutation(RenameLaneDocument);
  const [remove] = useMutation(DeleteLaneDocument, { refetchQueries });
  const [setDone] = useMutation(SetDoneLaneDocument, { refetchQueries });
  const [reorder] = useMutation(ReorderLanesDocument);

  return {
    async createLane(name: string, position: number): Promise<void> {
      const id = newId();
      await create({
        variables: { values: { id, projectId, name, position } },
        optimisticResponse: { createLane: { __typename: 'Lane', id, name, position, isDone: false } },
        update(cache, { data }) {
          const lane = data?.createLane;
          if (!lane) return;
          updateProjectLanes(cache, projectId, (lanes) => [...lanes.filter((row) => row.id !== lane.id), lane]);
        },
      });
    },

    async renameLane(lane: CachedLane, name: string): Promise<void> {
      await rename({
        variables: { id: lane.id, name },
        optimisticResponse: { updateLaneSingle: { ...lane, name } },
      });
    },

    async deleteLane(lane: CachedLane): Promise<void> {
      await remove({
        variables: { id: lane.id },
        update(cache, { data }) {
          if (!data?.deleteLaneSingle) return;
          updateProjectLanes(cache, projectId, (lanes) => lanes.filter((row) => row.id !== lane.id));
          cache.evict({ id: cache.identify({ __typename: 'Lane', id: lane.id }) });
        },
      });
    },

    /** Hand the done flag to `lane`, or take it away when `lane` already has it. */
    async toggleDoneLane(lane: CachedLane): Promise<void> {
      await setDone({
        variables: { projectId, laneId: lane.isDone ? null : lane.id },
        update(cache, { data }) {
          if (!data?.setDoneLane) return;
          updateProjectLanes(cache, projectId, () => [...data.setDoneLane]);
        },
      });
    },

    /** Move `lane` one place along the board. */
    async moveLane(lanes: readonly CachedLane[], lane: CachedLane, delta: number): Promise<void> {
      const from = lanes.findIndex((row) => row.id === lane.id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= lanes.length) return;

      const ordered = lanes.filter((row) => row.id !== lane.id);
      ordered.splice(to, 0, lane);

      await reorder({
        variables: { projectId, laneIds: ordered.map((row) => row.id) },
        optimisticResponse: {
          reorderLanes: ordered.map((row, position) => ({ ...row, position })),
        },
        update(cache, { data }) {
          if (!data?.reorderLanes) return;
          updateProjectLanes(cache, projectId, () => [...data.reorderLanes]);
        },
      });
    },
  };
}
