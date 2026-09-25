import { useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import type { RunFieldsFragment, RunSummaryFieldsFragment } from '@/__generated__/graphql';
import { Disclosure } from '@/components/disclosure';
import { Badge } from '@/components/ui/badge';
import type { BadgeVariant } from '@/components/ui/badge-base';
import { formatTimestamp } from '@/lib/dates';
import { cn } from '@/lib/utils';

// What an agent did in one run, drawn the way it happened: what it was told,
// then each turn's thinking, what it said, the tools it called and what they
// answered. The runner reports it every couple of seconds while the run is
// live, so a view that polls the run is watching it work.

/** One entry in a run's log, as the runner writes it. */
export interface RunEvent {
  at?: string;
  kind?: string;
  name?: string | null;
  ok?: boolean | null;
  text?: string | null;
}

export const RUN_STATUS: Record<string, { label: string; variant: BadgeVariant }> = {
  running: { label: 'Running', variant: 'warning' },
  ok: { label: 'Finished', variant: 'success' },
  error: { label: 'Failed', variant: 'destructive' },
  stopped: { label: 'Stopped', variant: 'outline' },
};

export function RunStatusBadge({ status }: { status: string }) {
  const shown = RUN_STATUS[status] ?? { label: status, variant: 'outline' as const };
  return <Badge variant={shown.variant}>{shown.label}</Badge>;
}

/** A dot that says "this is happening now". */
export function LiveDot({ className }: { className?: string }) {
  return (
    <View
      aria-hidden
      className={cn('size-2 shrink-0 rounded-full bg-green-600', Platform.OS === 'web' && 'animate-pulse', className)}
    />
  );
}

export function runEvents(run: Pick<RunFieldsFragment, 'events'>): RunEvent[] {
  return Array.isArray(run.events) ? (run.events as RunEvent[]) : [];
}

/** When it started, how long it took, and what it spent. */
export function describeRun(run: RunSummaryFieldsFragment): string {
  const parts = [formatTimestamp(run.startedAt)];
  const seconds = elapsedSeconds(run.startedAt, run.finishedAt);
  if (seconds !== null)
    parts.push(run.finishedAt ? `took ${formatDuration(seconds)}` : `${formatDuration(seconds)} so far`);
  if (run.totalTokens > 0) {
    parts.push(`${run.totalTokens.toLocaleString()} tokens (${run.promptTokens} in, ${run.completionTokens} out)`);
  }
  if (run.toolCalls > 0) parts.push(`${run.toolCalls} tool ${run.toolCalls === 1 ? 'call' : 'calls'}`);
  return parts.join(' · ');
}

function elapsedSeconds(from: string, to: string | null | undefined): number | null {
  const start = Date.parse(from);
  const end = to ? Date.parse(to) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** How near the bottom counts as "at the bottom", for following the log. */
const FOLLOW_SLACK = 24;

/**
 * A run in full: its prompts, its log as it streams, and how it ended.
 *
 * The log follows its own end while the reader is there. Someone who has
 * scrolled up to read something is left where they are.
 */
export function RunLog({ run, className }: { run: RunFieldsFragment; className?: string }) {
  const running = run.status === 'running';
  const events = runEvents(run);
  const said = events.some((event) => event.kind === 'output');
  const scroller = useRef<ScrollView>(null);
  const following = useRef(true);

  return (
    <View className={cn('gap-3', className)}>
      {run.systemPrompt || run.userPrompt ? (
        <Disclosure
          title="What it was told"
          description={run.model ? `Model ${run.model}` : undefined}
          content={
            <View className="gap-2">
              {run.systemPrompt ? <PromptBlock label="System" text={run.systemPrompt} /> : null}
              {run.userPrompt ? <PromptBlock label="Task" text={run.userPrompt} /> : null}
            </View>
          }
        />
      ) : run.model ? (
        <Text className="text-muted-foreground text-xs">Model {run.model}</Text>
      ) : null}

      <ScrollView
        ref={scroller}
        className="max-h-96 rounded-md border border-border"
        contentContainerClassName="gap-1.5 p-3"
        scrollEventThrottle={100}
        onScroll={({ nativeEvent }) => {
          const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
          following.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - FOLLOW_SLACK;
        }}
        onContentSizeChange={() => {
          if (running && following.current) scroller.current?.scrollToEnd({ animated: false });
        }}
      >
        <View role="log" aria-label="Run log" aria-live={running ? 'polite' : 'off'} className="gap-1.5">
          {events.length === 0 ? (
            <Text className="text-muted-foreground text-xs">{running ? 'Nothing yet.' : 'Nothing logged.'}</Text>
          ) : (
            events.map((event, index) => (
              // The log is append-only, and a streamed block only grows at the
              // end, so a position is a stable key.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <LogEntry key={index} event={event} />
            ))
          )}
          {running ? (
            <View className="flex-row items-center gap-2 pt-1">
              <LiveDot />
              <Text className="text-muted-foreground text-xs">
                {run.cancelRequestedAt ? 'Asked to stop…' : 'Working…'}
              </Text>
            </View>
          ) : null}
        </View>
      </ScrollView>

      {run.error ? (
        <Text selectable className="text-destructive text-sm">
          {run.error}
        </Text>
      ) : null}
      {/* The final output is the last thing it said, which the log already
          holds when it streamed; shown on its own only when it did not. */}
      {run.output && !said ? (
        <Text selectable className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-foreground text-sm">
          {run.output}
        </Text>
      ) : null}
    </View>
  );
}

function PromptBlock({ label, text }: { label: string; text: string }) {
  return (
    <View className="gap-1">
      <Text className="font-medium text-muted-foreground text-xs">{label}</Text>
      <ScrollView className="max-h-64 rounded-md bg-muted" contentContainerClassName="px-3 py-2">
        <Text selectable className="whitespace-pre-wrap font-mono text-foreground text-xs">
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

function timeOf(event: RunEvent): string {
  const at = event.at ? new Date(event.at) : null;
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString() : '';
}

function LogEntry({ event }: { event: RunEvent }) {
  const text = event.text ?? '';
  switch (event.kind) {
    case 'turn':
      return (
        <View className="flex-row items-center gap-2 py-1">
          <View className="h-px flex-1 bg-border" />
          <Text className="text-muted-foreground text-xs">{text || 'Next turn'}</Text>
          <View className="h-px flex-1 bg-border" />
        </View>
      );
    case 'thinking':
      return (
        <Text
          selectable
          className="whitespace-pre-wrap border-border border-l-2 pl-2 text-muted-foreground text-xs italic"
        >
          {text}
        </Text>
      );
    case 'output':
      return (
        <Text selectable className="whitespace-pre-wrap text-foreground text-sm">
          {text}
        </Text>
      );
    case 'tool_call':
      return <MonoLine title={timeOf(event)} line={`→ ${event.name ?? 'tool'}(${text})`} />;
    case 'tool_result':
      return (
        <MonoLine
          title={timeOf(event)}
          line={`← ${event.name ?? 'tool'}${event.ok === false ? ' failed' : ''}${text ? `: ${text}` : ''}`}
          failed={event.ok === false}
        />
      );
    case 'hook':
      return <MonoLine title={timeOf(event)} line={`Hook ${text || event.name || ''}`} failed={event.ok === false} />;
    case 'notice':
      return (
        <Text selectable className="text-amber-700 text-xs dark:text-amber-400">
          {[event.name, text].filter(Boolean).join(': ')}
        </Text>
      );
    default:
      return <MonoLine title={timeOf(event)} line={[event.kind, event.name, text].filter(Boolean).join(' ')} />;
  }
}

/** A tool line: three lines at most until someone asks for the rest. */
function MonoLine({ line, title, failed = false }: { line: string; title: string; failed?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = line.length > 240 || line.split('\n').length > 3;
  const body = (
    <Text
      selectable
      numberOfLines={long && !open ? 3 : undefined}
      className={cn('whitespace-pre-wrap font-mono text-xs', failed ? 'text-destructive' : 'text-muted-foreground')}
    >
      {title ? <Text className="text-muted-foreground/70">{title} </Text> : null}
      {line}
    </Text>
  );
  if (!long) return body;
  return (
    <Pressable role="button" aria-expanded={open} onPress={() => setOpen(!open)}>
      {body}
      <Text className="text-muted-foreground text-xs underline">{open ? 'Show less' : 'Show all'}</Text>
    </Pressable>
  );
}
