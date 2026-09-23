import { Redirect, Slot } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Sidebar } from '@/components/layouts/sidebar';
import { isAuthenticated } from '@/lib/auth';

export default function AppLayout() {
  // The token lives in localStorage, which the first render cannot read on the
  // server or during hydration — so decide after mount rather than redirecting
  // a signed-in user to /login for one frame.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    setSignedIn(isAuthenticated());
  }, []);

  if (signedIn === null) return <View className="flex-1 bg-background" />;
  if (!signedIn) return <Redirect href="/login" />;

  return (
    <View className="h-full flex-1 flex-row bg-background">
      <Sidebar />
      {/* `role="main"` is what react-native-web turns into a <main>. */}
      <ScrollView role="main" className="flex-1" contentContainerClassName="min-h-full">
        <Slot />
      </ScrollView>
    </View>
  );
}
