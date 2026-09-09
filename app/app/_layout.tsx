import { ApolloProvider } from '@apollo/client';
import { Stack } from 'expo-router';
import { client } from '@/lib/apollo';
import '../global.css';

export default function RootLayout() {
  return (
    <ApolloProvider client={client}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }} />
    </ApolloProvider>
  );
}
