import { useMutation, useQuery } from '@apollo/client';
import { Text, View } from 'react-native';
import { Section } from '@/components/section';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import { describeError } from '@/lib/errors';
import { RunRetentionDocument, SetRunRetentionDocument } from '@/lib/graphql';

// How long finished runs are kept. The server prunes hourly, and only runs the
// stations no longer count, so a shorter setting never makes an agent redo work.

const CHOICES = [
  { value: 'forever', label: 'For good', days: null },
  { value: '30', label: '30 days', days: 30 },
  { value: '90', label: '90 days', days: 90 },
  { value: '365', label: 'A year', days: 365 },
] as const;

export function RunRetention() {
  const query = useQuery(RunRetentionDocument);
  const user = query.data?.users[0];
  const [setRetention, { loading, error }] = useMutation(SetRunRetentionDocument);
  const days = user?.runRetentionDays ?? null;
  const current = days === null ? 'forever' : String(days);
  // A number set some other way than here still shows, as itself.
  const choices = CHOICES.some((choice) => choice.value === current)
    ? CHOICES
    : [...CHOICES, { value: current, label: `${days} days`, days }];

  function choose(value: string) {
    const choice = choices.find((option) => option.value === value);
    if (!choice || !user || choice.value === current) return;
    void setRetention({
      variables: { days: choice.days },
      optimisticResponse: { setRunRetention: { __typename: 'User', id: user.id, runRetentionDays: choice.days } },
    }).catch(() => undefined);
  }

  return (
    <Section
      surface="card"
      title="Run history"
      description="How long finished runs and their logs are kept. Notes, history and artifacts stay either way, and a run a station still counts is never pruned."
      content={
        <View className="gap-2">
          <SegmentedGroup aria-label="Keep finished runs" value={current} onValueChange={choose}>
            {choices.map((choice) => (
              <SegmentedButton key={choice.value} value={choice.value} disabled={loading || !user}>
                {choice.label}
              </SegmentedButton>
            ))}
          </SegmentedGroup>
          {error ? (
            <Text className="text-destructive text-sm" aria-live="polite">
              {describeError(error)}
            </Text>
          ) : null}
        </View>
      }
    />
  );
}
