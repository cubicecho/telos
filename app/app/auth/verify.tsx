import { useMutation } from '@apollo/client';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import { EmptyState } from '@/components/page';
import { CircleAlert } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/spinner';
import { setToken } from '@/lib/auth';
import { describeError } from '@/lib/errors';
import { VerifyMagicLinkDocument } from '@/lib/graphql';

export default function VerifyScreen() {
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const [verifyMagicLink, { error }] = useMutation(VerifyMagicLinkDocument);
  // Strict mode and route re-renders both run effects more than once; a magic
  // token is meant to be spent exactly once.
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !token) return;
    started.current = true;
    verifyMagicLink({ variables: { token } })
      .then(({ data }) => {
        if (!data?.verifyMagicLink) return;
        setToken(data.verifyMagicLink.token);
        router.replace('/');
      })
      .catch(() => {
        // Rendered from `error` below.
      });
  }, [token, verifyMagicLink, router]);

  return (
    <View className="min-h-full flex-1 items-center justify-center bg-background px-4">
      <View className="w-full max-w-sm items-center">
        {!token || error ? (
          <EmptyState
            icon={CircleAlert}
            title="That link didn't work"
            description={`${error ? describeError(error) : 'The link is missing its token.'} Sign-in links expire after 15 minutes.`}
            action={
              <Link href="/login" className="text-primary text-sm underline">
                Request a new one
              </Link>
            }
          />
        ) : (
          <View className="flex-row items-center justify-center gap-2">
            <Spinner />
            <Text className="text-muted-foreground text-sm">Signing you in…</Text>
          </View>
        )}
      </View>
    </View>
  );
}
