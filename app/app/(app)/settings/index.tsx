import { View } from 'react-native';
import { LabelManager } from '@/components/domain/label/label-manager';
import { ThemeSelector } from '@/components/domain/settings/theme-selector';
import { PageHeader } from '@/components/page-header';
import { Section } from '@/components/section';

/** One card per thing you can change. Sections, not tabs — there are two. */
export default function SettingsScreen() {
  return (
    <View className="mx-auto w-full max-w-2xl gap-6 px-6 py-8">
      <PageHeader
        title="Settings"
        description="Theme is kept on this device; labels belong to your account."
        className="px-0 pt-0"
        // Until cubicecho/cubeui#78: the title leaves its colour to inheritance on
        // the web, and react-native-web's Text draws black instead.
        titleClassName="text-foreground"
      />

      {/* `border-border` until cubicecho/cubeui#78: the card surface's border names no
          colour, and react-native-web's default is black. */}
      <Section
        surface="card"
        className="border-border"
        title="Theme"
        description="System follows whatever your operating system is set to."
        content={<ThemeSelector />}
      />

      {/* No title here: the label manager brings its own heading, because it is
          a list with its own actions rather than a single control. */}
      <Section surface="card" className="border-border" content={<LabelManager />} />
    </View>
  );
}
