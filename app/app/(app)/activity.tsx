import { useQuery } from '@apollo/client';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { ACCOUNT_VIEWS, AccountActivity } from '@/components/domain/ai/account-activity';
import { PageLayout } from '@/components/page-layout';
import { useAi } from '@/lib/ai';
import { AiStateDocument } from '@/lib/graphql';

/**
 * What the account's agents did, across every project: what needs a person,
 * what was spent, and the runs, artifacts and archived todos behind it. Not
 * there at all while AI is off: a link to it goes home. The list that is
 * showing lives in the URL, as a project's view does.
 */
export default function ActivityScreen() {
  const { view } = useLocalSearchParams<{ view?: string }>();
  const ai = useAi();
  const state = useQuery(AiStateDocument);
  if (state.data && !ai.on) return <Redirect href="/" />;

  return (
    <PageLayout
      title="Activity"
      description="What your agents did across every project: what needs you, what it cost, and what they left behind."
      contentSlot={
        <View className="py-6">
          {ai.on ? (
            <AccountActivity
              view={ACCOUNT_VIEWS.find((name) => name === view) ?? 'runs'}
              onViewChange={(next) => router.setParams({ view: next })}
            />
          ) : null}
        </View>
      }
    />
  );
}
