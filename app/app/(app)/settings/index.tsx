import { View } from 'react-native';
import { AiSettings } from '@/components/domain/ai/ai-settings';
import { LabelManager } from '@/components/domain/label/label-manager';
import { PageLayout } from '@/components/page-layout';
import { Section } from '@/components/section';
import { ThemePicker } from '@/components/ui/theme-picker';

/** One card per thing you can change. Sections, not tabs — there are two. */
export default function SettingsScreen() {
  return (
    <PageLayout
      width="prose"
      title="Settings"
      description="Theme is kept on this device; labels belong to your account."
      content={
        <View className="gap-6 py-6">
          <Section
            surface="card"
            title="Theme"
            description="System follows whatever your operating system is set to."
            content={<ThemePicker />}
          />
          {/* Its own section: the header's "New label" shares the list's state. */}
          <LabelManager />
          {/* Nothing at all when the instance has no AI. */}
          <AiSettings />
        </View>
      }
    />
  );
}
