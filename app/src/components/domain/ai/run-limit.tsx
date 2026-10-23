import { useMutation, useQuery } from '@apollo/client';
import { Text, View } from 'react-native';
import { Section } from '@/components/section';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import { describeError } from '@/lib/errors';
import { InstanceRunLimitDocument, SetInstanceRunLimitDocument } from '@/lib/graphql';
import { CARD_TITLE } from '@/lib/styles';

// How many runs the instance works at once, across every runner, lane and
// account. The server reads it on every poll, so a change applies within one;
// lowering it stops nothing that is already running.

const CHOICES = [1, 2, 3, 4, 6, 8] as const;

export function RunLimit() {
  const query = useQuery(InstanceRunLimitDocument);
  const limit = query.data?.instanceRunLimit;
  const [setLimit, { loading, error }] = useMutation(SetInstanceRunLimitDocument, {
    update(cache, { data }) {
      if (data)
        cache.writeQuery({ query: InstanceRunLimitDocument, data: { instanceRunLimit: data.setInstanceRunLimit } });
    },
  });
  // A number set some other way than here still shows, as itself.
  const choices: readonly number[] =
    limit === undefined || CHOICES.some((choice) => choice === limit)
      ? CHOICES
      : [...CHOICES, limit].sort((a, b) => a - b);

  function choose(value: string) {
    const next = Number(value);
    if (!Number.isInteger(next) || next === limit) return;
    void setLimit({
      variables: { limit: next },
      optimisticResponse: { setInstanceRunLimit: next },
    }).catch(() => undefined);
  }

  return (
    <Section
      surface="card"
      titleClassName={CARD_TITLE}
      title="Runs at once"
      description="The most runs this instance works at the same time, for everyone on this server; only admins see this. Each lane's limit applies under it. Lowering it lets running work finish."
      contentSlot={
        <View className="gap-2">
          <SegmentedGroup
            aria-label="Runs at once"
            value={limit === undefined ? '' : String(limit)}
            onValueChange={choose}
          >
            {choices.map((choice) => (
              <SegmentedButton key={choice} value={String(choice)} disabled={loading || limit === undefined}>
                {String(choice)}
              </SegmentedButton>
            ))}
          </SegmentedGroup>
          {query.error || error ? (
            <Text className="text-negative text-sm" aria-live="polite">
              {describeError(query.error ?? error)}
            </Text>
          ) : null}
        </View>
      }
    />
  );
}
