import { useQuery } from '@apollo/client';
import { Redirect } from 'expo-router';
import { View } from 'react-native';
import { AiStatus } from '@/components/domain/ai/ai-status';
import { PageLayout } from '@/components/page-layout';
import { useAi } from '@/lib/ai';
import { AiStateDocument } from '@/lib/graphql';

/**
 * Where the stations stand, across every project with AI on. Not there at all
 * while AI is off: a link to it goes home. At /stations rather than /status,
 * which the dev server answers itself.
 */
export default function StationsScreen() {
  const ai = useAi();
  const state = useQuery(AiStateDocument);
  if (state.data && !ai.on) return <Redirect href="/" />;

  return (
    <PageLayout
      title="Stations"
      description="What your agents are doing, what waits on you, and whether the runner is there."
      content={<View className="py-6">{ai.on ? <AiStatus /> : null}</View>}
    />
  );
}
