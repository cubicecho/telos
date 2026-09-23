import { View } from 'react-native';
import { LabelManager } from '@/components/domain/label/label-manager';
import { PageHeader } from '@/components/page-header';
import { Section } from '@/components/section';
import { ThemePicker } from '@/components/ui/theme-picker';

/** One card per thing you can change. Sections, not tabs — there are two. */
export default function SettingsScreen() {
  return (
    <View className="mx-auto w-full max-w-2xl gap-6 px-6 py-8">
      <PageHeader
        title="Settings"
        description="Theme is kept on this device; labels belong to your account."
        className="px-0 pt-0"
      />

      <Section
        surface="card"
        title="Theme"
        description="System follows whatever your operating system is set to."
        content={<ThemePicker />}
      />

      {/* No title here: the label manager brings its own heading, because it is
          a list with its own actions rather than a single control. */}
      <Section surface="card" content={<LabelManager />} />
    </View>
  );
}
