import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { AiSettings } from '@/components/domain/ai/ai-settings';
import { LabelManager } from '@/components/domain/label/label-manager';
import { TemplateManager } from '@/components/domain/template/template-manager';
import { PageLayout } from '@/components/page-layout';
import { Section } from '@/components/section';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ThemePicker } from '@/components/ui/theme-picker';
import { useAi } from '@/lib/ai';

type SettingsTab = 'general' | 'ai';

/**
 * One card per thing you can change, in two tabs: the board's own settings,
 * and AI's, which has grown its keys and agents. The tab lives in the URL, as
 * the project's view does, so a link can open the AI tab. The AI tab is not
 * there at all for someone with nothing in it — AI stays out of sight until the
 * instance has it on.
 */
export default function SettingsScreen() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const ai = useAi();
  const current: SettingsTab = tab === 'ai' && ai.settings ? 'ai' : 'general';

  const general = (
    <View className="gap-6">
      <Section
        surface="card"
        title="Theme"
        description="System follows whatever your operating system is set to."
        content={<ThemePicker />}
      />
      {/* Its own section: the header's "New label" shares the list's state. */}
      <LabelManager />
      <TemplateManager />
    </View>
  );

  return (
    <PageLayout
      width="prose"
      title="Settings"
      description="Theme is kept on this device; everything else belongs to your account."
      content={
        <View className="py-6">
          {ai.settings ? (
            <Tabs
              value={current}
              // `undefined` rather than `general`, so the default leaves no trace on the URL.
              onValueChange={(next) => router.setParams({ tab: next === 'ai' ? 'ai' : undefined })}
              className="flex flex-col gap-6"
            >
              <TabsList aria-label="Settings" className="self-start">
                <TabsTrigger value="general">General</TabsTrigger>
                <TabsTrigger value="ai">AI</TabsTrigger>
              </TabsList>
              <TabsContent value="general" className="mt-0">
                {general}
              </TabsContent>
              <TabsContent value="ai" className="mt-0">
                <View className="gap-6">
                  <AiSettings />
                </View>
              </TabsContent>
            </Tabs>
          ) : (
            general
          )}
        </View>
      }
    />
  );
}
