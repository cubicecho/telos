import { ApolloProvider } from '@apollo/client';
import { type ErrorBoundaryProps, Stack } from 'expo-router';
import { Text, View } from 'react-native';
import { RouteError } from '@/components/route-error';
import { Button } from '@/components/ui/button';
import { useThemePreference } from '@/components/ui/theme-preference';
import { client } from '@/lib/apollo';
import { describeError } from '@/lib/errors';
import '../global.css';

export default function RootLayout() {
  // `public/index.html` has already painted the right theme; this keeps it that
  // way on every screen, not only Settings, and repaints a `system` user when
  // the OS switches between light and dark.
  useThemePreference();

  return (
    <ApolloProvider client={client}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }} />
    </ApolloProvider>
  );
}

/**
 * The last thing between a thrown render and a white page.
 *
 * Expo Router looks for this named export on a route file and wraps the route
 * in it, so exporting it from the root layout covers every screen. It sits
 * *outside* the provider above — the throw may well have come from inside it —
 * so it can use nothing that needs Apollo.
 *
 * Worded through `describeError`, so a thrown query failure reads the same here
 * as everywhere else. The raw message is shown too — whoever ends up reading
 * this is the one who has to file it — and a reload is the escape hatch for a
 * throw that `retry` does not clear.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View className="h-full flex-1 bg-background">
      <RouteError
        error={error}
        reset={() => void retry()}
        describe={describeError}
        details
        actions={
          <Button variant="outline" size="sm" onPress={() => window.location.reload()}>
            Reload
          </Button>
        }
      />
      <Text className="mx-auto max-w-md px-6 pb-12 text-center text-muted-foreground text-sm">
        This is a bug in Telos, not something you did. Your data is untouched.
      </Text>
    </View>
  );
}
