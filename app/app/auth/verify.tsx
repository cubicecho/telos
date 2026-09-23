import { useMutation } from '@apollo/client';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
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
          <>
            <Text role="heading" aria-level={1} className="font-semibold text-foreground text-xl">
              That link didn't work
            </Text>
            <Text className="mt-2 text-center text-muted-foreground text-sm">
              {error ? describeError(error) : 'The link is missing its token.'} Sign-in links expire after 15 minutes.
            </Text>
            <Link href="/login" className="mt-4 text-primary text-sm underline">
              Request a new one
            </Link>
          </>
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
