import { useQuery } from '@apollo/client';
import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { LiveRun } from '@/components/domain/ai/project-activity';
import { StationDialog } from '@/components/domain/ai/station-dialog';
import { WatchRunDialog } from '@/components/domain/ai/watch-run-dialog';
import { TodoFormDialog } from '@/components/domain/todo/todo-form-dialog';
import type { TodoSummary } from '@/components/domain/todo/types';
import { useAi } from '@/lib/ai';
import type { CachedLane } from '@/lib/cache';
import { describeError } from '@/lib/errors';
import { ProjectStationsDocument } from '@/lib/graphql';
import { todosInLane } from '@/lib/lanes';
import { BoardCardBody } from './board-card';
import { DragBoard } from './drag-surfaces';
import type { Drop } from './drag-surfaces-base';
import type { LaneSummary } from './lane-badge';
import { LaneColumn } from './lane-column';
import { LaneComposer } from './lane-composer';
import { useLaneActions } from './use-lane-actions';
import { useMoveTodo } from './use-move-todo';

/**
 * The project's todos as columns.
 *
 * The board shows the same rows as the list and changes them the same way —
 * `position` is project-wide and completion follows the done lane — so the two
 * tabs are two drawings of one list rather than two states to keep in step.
 *
 * Dragging is the obvious gesture and reaches only a pointer, so every move it
 * offers is also a menu item: each card carries "Move to", each column header
 * carries its own actions.
 *
 * With AI on for the account and the project, a column can also be a station,
 * and its settings are read here in a query of their own: the columns do not
 * exist in the schema otherwise, so `LaneFields` cannot carry them.
 */
export function Board({
  projectId,
  aiEnabled = false,
  lanes,
  todos,
  live,
}: {
  projectId: string;
  /** The project's own AI switch. */
  aiEnabled?: boolean;
  lanes: readonly CachedLane[];
  todos: readonly TodoSummary[];
  /** The runs working todos now, by todo id. The page polls it, for its header too. */
  live?: ReadonlyMap<string, LiveRun> | undefined;
}) {
  const [dragging, setDragging] = useState<TodoSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One dialog for the whole board rather than one per card: it is modal, so
  // only ever one can be open, and mounting dozens would cost a Radix portal
  // each for a surface nobody has asked for yet.
  const [editing, setEditing] = useState<TodoSummary | null>(null);

  const ai = useAi();
  const stationsOn = ai.on && aiEnabled;
  const stationsQuery = useQuery(ProjectStationsDocument, { variables: { projectId }, skip: !stationsOn });
  const stations = useMemo(
    () => new Map((stationsQuery.data?.lanes ?? []).map((row) => [row.id, row])),
    [stationsQuery.data],
  );
  const agents = stationsQuery.data?.agents ?? [];
  const [stationLane, setStationLane] = useState<CachedLane | null>(null);
  const [watching, setWatching] = useState<TodoSummary | null>(null);
  const shownLive = stationsOn ? live : undefined;

  const actions = useLaneActions(projectId);
  const moveTodo = useMoveTodo(projectId);

  // Returns the promise so a caller that awaits — LaneComposer does — is
  // awaiting something that cannot reject. Every lane action goes through
  // here; one that does not is a silent failure by construction.
  function run(action: () => Promise<unknown>): Promise<void> {
    setError(null);
    return action().then(
      () => undefined,
      (reason) => setError(describeError(reason)),
    );
  }

  function onDragStart(id: string) {
    setDragging(todos.find((todo) => todo.id === id) ?? null);
  }

  function onDrop({ activeId, overId, overLaneId }: Drop) {
    setDragging(null);

    const todo = todos.find((row) => row.id === activeId);
    if (!todo) return;

    // A drop lands either on a column or on a card in one; over a card, the
    // lane comes from the sortable context the card belongs to.
    const onColumn = lanes.find((row) => row.id === overId);
    const laneId = onColumn?.id ?? overLaneId;
    const lane = lanes.find((row) => row.id === laneId);
    if (!lane) return;

    const inLane = todosInLane(todos, lane.id);
    const at = onColumn ? -1 : inLane.findIndex((row) => row.id === overId);
    run(() => moveTodo(todo, lane, at < 0 ? inLane.length : at));
  }

  function move(todo: TodoSummary, lane: LaneSummary) {
    const target = lanes.find((row) => row.id === lane.id);
    if (target) run(() => moveTodo(todo, target));
  }

  return (
    <View className="gap-2">
      {error ? (
        <Text className="text-destructive text-sm" aria-live="polite">
          {error}
        </Text>
      ) : null}

      <DragBoard
        onDragStart={onDragStart}
        onDrop={onDrop}
        onDragCancel={() => setDragging(null)}
        overlay={dragging ? <BoardCardBody todo={dragging} lanes={lanes} live={shownLive?.get(dragging.id)} /> : null}
      >
        <ScrollView horizontal contentContainerClassName="flex-row items-start gap-3 pb-2">
          {lanes.map((lane) => (
            <LaneColumn
              key={lane.id}
              lane={lane}
              lanes={lanes}
              todos={todosInLane(todos, lane.id)}
              onMove={move}
              onEdit={setEditing}
              onRename={(name) => run(() => actions.renameLane(lane, name))}
              onReorder={(delta) => run(() => actions.moveLane(lanes, lane, delta))}
              onToggleDone={() => run(() => actions.toggleDoneLane(lane))}
              onDelete={() => run(() => actions.deleteLane(lane))}
              station={stationsOn ? (stations.get(lane.id) ?? null) : undefined}
              agentName={agents.find((agent) => agent.id === stations.get(lane.id)?.agentId)?.name}
              // Offered once the settings are in, so a save cannot overwrite them with defaults.
              onEditStation={stationsOn && stationsQuery.data ? () => setStationLane(lane) : undefined}
              live={shownLive}
              onWatch={shownLive ? setWatching : undefined}
            />
          ))}
          <LaneComposer onCreate={(name) => run(() => actions.createLane(name, lanes.length))} />
        </ScrollView>
      </DragBoard>

      {/* Todos with no lane at all only happen between a lane being deleted and
          the refetch that rehomes them, but saying so beats them vanishing. */}
      {todos.some((todo) => todo.lane == null) ? (
        <Text className="text-muted-foreground text-xs">Some todos are not in a lane yet. Reload to place them.</Text>
      ) : null}

      {/* Keyed by id so reopening on a different card resets the form, and
          unmounted while closed so a stale todo cannot be edited after the
          board has moved on from it. */}
      {editing ? (
        <TodoFormDialog key={editing.id} open onOpenChange={(next) => !next && setEditing(null)} todo={editing} />
      ) : null}

      {/* Keyed by todo: the dialog follows the todo from run to run, and
          stays open on the last one after the todo's run ends. */}
      {watching ? (
        <WatchRunDialog
          key={watching.id}
          open
          onOpenChange={(next) => !next && setWatching(null)}
          todoTitle={watching.title}
          live={shownLive?.get(watching.id)}
        />
      ) : null}

      {stationLane && stationsOn ? (
        <StationDialog
          key={stationLane.id}
          open
          onOpenChange={(next) => !next && setStationLane(null)}
          lane={stationLane}
          lanes={lanes}
          station={stations.get(stationLane.id) ?? null}
          agents={agents}
        />
      ) : null}
    </View>
  );
}
