import { ApolloProvider } from '@apollo/client';
import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { client } from '@/lib/apollo';
import { syncTheme } from '@/lib/theme';
import '../global.css';

export default function RootLayout() {
  // `+html.tsx` has already painted the right theme; this keeps it that way
  // while the app runs, so switching the OS between light and dark repaints a
  // `system` user without a reload.
  useEffect(() => syncTheme(), []);

  return (
    <ApolloProvider client={client}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }} />
    </ApolloProvider>
  );
}
