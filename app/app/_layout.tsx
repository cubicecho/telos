import { ApolloProvider } from '@apollo/client';
import { type ErrorBoundaryProps, Stack } from 'expo-router';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { client } from '@/lib/apollo';
import { syncTheme } from '@/lib/theme';
import '../global.css';

export default function RootLayout() {
  // `public/index.html` has already painted the right theme; this keeps it that
  // way while the app runs, so switching the OS between light and dark repaints
  // a `system` user without a reload.
  useEffect(() => syncTheme(), []);

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
 * so it can use nothing that needs Apollo, and it says only what it honestly
 * knows: something broke, here is what it said, here are the two ways out.
 *
 * `retry` re-renders the route with the error cleared, which is enough for a
 * transient throw; a reload is the escape hatch for one that is not.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <div role="alert" className="flex h-screen flex-col items-center justify-center gap-4 bg-background px-6">
      <div className="max-w-md text-center">
        <h1 className="font-semibold text-xl">Something broke.</h1>
        <p className="mt-2 text-muted-foreground text-sm">
          This is a bug in Telos, not something you did. Your data is untouched.
        </p>
        {/* The message verbatim, not a friendlier paraphrase: whoever ends up
            reading this is the one who has to file it. */}
        <pre className="mt-4 overflow-x-auto whitespace-pre-wrap rounded-md border bg-muted p-3 text-left text-muted-foreground text-xs">
          {error.message}
        </pre>
      </div>
      <div className="flex gap-2">
        <Button onClick={() => void retry()}>Try again</Button>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    </div>
  );
}
