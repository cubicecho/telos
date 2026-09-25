import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { describeError } from '@/lib/errors';
import {
  AgentsDocument,
  DiscardDraftDocument,
  DraftDocument,
  MakeTodoFromDraftDocument,
  OpenDraftsDocument,
  SayToDraftDocument,
  StartDraftDocument,
  StopDraftDocument,
} from '@/lib/graphql';

/** How often an open draft asks whether its agent has answered. */
export const DRAFT_POLL_MS = 1500;

/**
 * Talking a request over with an agent before it becomes a todo. The person
 * says what they want; the runner hands it to the agent, which asks what it
 * needs to and keeps a title and brief up to date as it goes. Either side can
 * edit those, and "Make a todo" puts them in the project's first open lane.
 *
 * Turns alternate: while the agent is thinking there is nothing to send, only
 * Stop, which gives the turn back and drops whatever answer comes late.
 */
export function DraftDialog({
  open,
  onOpenChange,
  projectId,
  onMade,
  pollMs = DRAFT_POLL_MS,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** Told the new todo's title, since the dialog closes on it. */
  onMade?: (title: string) => void;
  pollMs?: number;
}) {
  const [draftId, setDraftId] = useState<string | null>(null);

  // Each opening starts at the list, where an unfinished draft can be picked up.
  useEffect(() => {
    if (open) setDraftId(null);
  }, [open]);

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Talk a request over"
      description="Say what you want. The agent asks what it needs to and writes it up as a todo's brief."
      content={
        draftId ? (
          <DraftTalk
            draftId={draftId}
            pollMs={pollMs}
            onBack={() => setDraftId(null)}
            onMade={(title) => {
              onOpenChange(false);
              onMade?.(title);
            }}
          />
        ) : (
          <DraftStart projectId={projectId} open={open} onStarted={setDraftId} />
        )
      }
    />
  );
}

function DraftStart({
  projectId,
  open,
  onStarted,
}: {
  projectId: string;
  open: boolean;
  onStarted: (id: string) => void;
}) {
  const agents = useQuery(AgentsDocument, { skip: !open });
  const drafts = useQuery(OpenDraftsDocument, {
    variables: { projectId },
    skip: !open,
    fetchPolicy: 'cache-and-network',
  });
  const [agentId, setAgentId] = useState('');
  const [message, setMessage] = useState('');
  const [start, { loading, error }] = useMutation(StartDraftDocument, { refetchQueries: [OpenDraftsDocument] });

  const agentList = agents.data?.agents ?? [];
  const chosen = agentId || agentList[0]?.id || '';
  const openDrafts = drafts.data?.drafts ?? [];

  async function send() {
    if (!chosen || !message.trim() || loading) return;
    try {
      const result = await start({ variables: { projectId, agentId: chosen, message: message.trim() } });
      const id = result.data?.startDraft.id;
      if (id) {
        setMessage('');
        onStarted(id);
      }
    } catch {
      // Shown under the button.
    }
  }

  if (agents.loading && !agents.data) return <Spinner />;
  if (agentList.length === 0) {
    return <Text className="text-muted-foreground text-sm">Add an agent in Settings to talk a request over.</Text>;
  }

  return (
    <View className="gap-4">
      {openDrafts.length > 0 ? (
        <View className="gap-2">
          <Text className="font-medium text-foreground text-sm">Carry on with</Text>
          <View className="flex-row flex-wrap gap-2">
            {openDrafts.map((draft) => (
              <Button key={draft.id} variant="outline" size="sm" onPress={() => onStarted(draft.id)}>
                {draft.title || 'Untitled draft'}
              </Button>
            ))}
          </View>
        </View>
      ) : null}

      <View className="gap-2">
        <Label id="draft-agent">Agent</Label>
        <Select value={chosen} onValueChange={setAgentId}>
          <SelectTrigger aria-labelledby="draft-agent">
            <SelectValue placeholder="Choose an agent" />
          </SelectTrigger>
          <SelectContent>
            {agentList.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </View>

      <View className="gap-2">
        <Label htmlFor="draft-first">What do you want done?</Label>
        <Textarea
          id="draft-first"
          value={message}
          onChangeText={setMessage}
          placeholder="In your own words. The agent will ask about the rest."
          rows={4}
          maxLength={10000}
        />
      </View>

      <View className="flex-row items-center justify-end gap-2">
        {error ? <Text className="flex-1 text-destructive text-sm">{describeError(error)}</Text> : null}
        <Button disabled={!message.trim() || loading} onPress={send}>
          Start
        </Button>
      </View>
    </View>
  );
}

function DraftTalk({
  draftId,
  pollMs,
  onBack,
  onMade,
}: {
  draftId: string;
  pollMs: number;
  onBack: () => void;
  onMade: (title: string) => void;
}) {
  const query = useQuery(DraftDocument, { variables: { id: draftId }, fetchPolicy: 'cache-and-network' });
  const draft = query.data?.draft;
  const waiting = !!draft?.waitingSince;
  const { startPolling, stopPolling } = query;

  useEffect(() => {
    if (waiting) startPolling(pollMs);
    else stopPolling();
    return () => stopPolling();
  }, [waiting, pollMs, startPolling, stopPolling]);

  // The agent rewrites the title and brief as it goes; an edit here holds until
  // it next does.
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  useEffect(() => setTitle(draft?.title ?? ''), [draft?.title]);
  useEffect(() => setBrief(draft?.brief ?? ''), [draft?.brief]);

  const [message, setMessage] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const refetch = { refetchQueries: [DraftDocument] };
  const [say, sayState] = useMutation(SayToDraftDocument, refetch);
  const [stop, stopState] = useMutation(StopDraftDocument);
  const [make, makeState] = useMutation(MakeTodoFromDraftDocument, { refetchQueries: 'active' });
  const [discard, discardState] = useMutation(DiscardDraftDocument, { refetchQueries: [OpenDraftsDocument] });

  async function act<T>(action: () => Promise<T>): Promise<T | undefined> {
    setActionError(null);
    try {
      return await action();
    } catch (cause) {
      setActionError(describeError(cause));
      return undefined;
    }
  }

  async function send() {
    const text = message.trim();
    if (!text || waiting) return;
    const done = await act(() => say({ variables: { id: draftId, message: text } }));
    if (done) setMessage('');
  }

  async function makeTodo() {
    const result = await act(() =>
      make({ variables: { id: draftId, title: title.trim() || null, brief: brief.trim() } }),
    );
    const todo = result?.data?.makeTodoFromDraft;
    if (todo) onMade(todo.title);
  }

  async function throwAway() {
    const result = await act(() => discard({ variables: { id: draftId } }));
    if (result) onBack();
  }

  if (!draft) {
    if (query.error) return <Text className="text-destructive text-sm">{describeError(query.error)}</Text>;
    return <Spinner />;
  }
  const agentName = draft.agent?.name ?? 'The agent';
  const busy = sayState.loading || stopState.loading || makeState.loading || discardState.loading;

  return (
    <View className="gap-4">
      <View className="gap-3" aria-live="polite">
        {draft.messages.map((line) => (
          <View key={line.id} className="gap-1">
            <Text className="font-medium text-muted-foreground text-xs">
              {line.role === 'user' ? 'You' : agentName}
            </Text>
            <Text className="text-foreground text-sm">{line.content}</Text>
          </View>
        ))}
        {waiting ? (
          <View className="flex-row items-center gap-2">
            <Spinner />
            <Text className="text-muted-foreground text-sm">{agentName} is thinking…</Text>
          </View>
        ) : null}
        {draft.error ? <Text className="text-destructive text-sm">{draft.error}</Text> : null}
      </View>

      <View className="gap-2">
        <Label htmlFor="draft-say">Reply</Label>
        <Textarea
          id="draft-say"
          value={message}
          onChangeText={setMessage}
          placeholder={waiting ? 'Wait for the answer, or stop it.' : 'Answer, or say more.'}
          rows={3}
          maxLength={10000}
          disabled={waiting}
        />
        <View className="flex-row justify-end gap-2">
          {waiting ? (
            <Button variant="outline" disabled={busy} onPress={() => act(() => stop({ variables: { id: draftId } }))}>
              Stop
            </Button>
          ) : null}
          <Button disabled={waiting || busy || !message.trim()} onPress={send}>
            Send
          </Button>
        </View>
      </View>

      <View className="gap-2 border-border border-t pt-4">
        <Label htmlFor="draft-title">Title</Label>
        <Input id="draft-title" value={title} onChangeText={setTitle} maxLength={200} placeholder="From the brief" />
        <Label htmlFor="draft-brief">Brief</Label>
        <Textarea
          id="draft-brief"
          value={brief}
          onChangeText={setBrief}
          rows={6}
          maxLength={20000}
          placeholder="The agent writes this as you talk."
        />
      </View>

      {actionError ? (
        <Text className="text-destructive text-sm" aria-live="polite">
          {actionError}
        </Text>
      ) : null}

      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <View className="flex-row gap-2">
          <Button variant="ghost" disabled={busy} onPress={onBack}>
            Back
          </Button>
          <Button variant="destructive-outline" disabled={busy} onPress={throwAway}>
            Discard
          </Button>
        </View>
        <Button disabled={busy || !brief.trim()} onPress={makeTodo}>
          Make a todo
        </Button>
      </View>
    </View>
  );
}
