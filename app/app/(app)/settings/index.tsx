import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { AgentSettings, AiSettings } from '@/components/domain/ai/ai-settings';
import { McpServerManager } from '@/components/domain/ai/mcp-server-manager';
import { LabelManager } from '@/components/domain/label/label-manager';
import { TemplateManager } from '@/components/domain/template/template-manager';
import { PageLayout } from '@/components/page-layout';
import { Section } from '@/components/section';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ThemePicker } from '@/components/ui/theme-picker';
import { PALETTE_PREFERENCES } from '@/components/ui/theme-preference-base';
import { useAi } from '@/lib/ai';

type SettingsTab = 'general' | 'ai' | 'agents' | 'mcp';

/**
 * One card per thing you can change, in tabs: the board's own settings; AI's
 * switches and keys; and, once AI is on, the agents and the MCP servers they
 * reach, each a tab of its own. The tab lives in the URL, as the project's view
 * does, so a link can open one. The AI tab is not there at all for someone with
 * nothing in it — AI stays out of sight until the instance has it on — and a
 * link to Agents or MCP servers while AI is off lands on General.
 */
export default function SettingsScreen() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  const ai = useAi();
  const open: readonly SettingsTab[] = ai.on ? ['ai', 'agents', 'mcp'] : ai.settings ? ['ai'] : [];
  const current: SettingsTab = open.find((name) => name === tab) ?? 'general';

  const general = (
    <View className="gap-6">
      <Section
        surface="card"
        title="Theme"
        description="System follows whatever your operating system is set to. A dark-only palette, such as Monokai, keeps the page dark whatever the theme says."
        content={<ThemePicker palettes={PALETTE_PREFERENCES} />}
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
      description="Theme and palette are kept on this device; everything else belongs to your account."
      content={
        <View className="py-6">
          {ai.settings ? (
            <Tabs
              value={current}
              // `undefined` rather than `general`, so the default leaves no trace on the URL.
              onValueChange={(next) => router.setParams({ tab: next === 'general' ? undefined : next })}
              className="flex flex-col gap-6"
            >
              <TabsList aria-label="Settings" className="self-start">
                <TabsTrigger value="general">General</TabsTrigger>
                <TabsTrigger value="ai">AI</TabsTrigger>
                {ai.on ? (
                  <>
                    <TabsTrigger value="agents">Agents</TabsTrigger>
                    <TabsTrigger value="mcp">MCP servers</TabsTrigger>
                  </>
                ) : null}
              </TabsList>
              <TabsContent value="general" className="mt-0">
                {general}
              </TabsContent>
              <TabsContent value="ai" className="mt-0">
                <View className="gap-6">
                  <AiSettings />
                </View>
              </TabsContent>
              {ai.on ? (
                <>
                  <TabsContent value="agents" className="mt-0">
                    <View className="gap-6">
                      <AgentSettings />
                    </View>
                  </TabsContent>
                  <TabsContent value="mcp" className="mt-0">
                    <View className="gap-6">
                      <McpServerManager />
                    </View>
                  </TabsContent>
                </>
              ) : null}
            </Tabs>
          ) : (
            general
          )}
        </View>
      }
    />
  );
}
