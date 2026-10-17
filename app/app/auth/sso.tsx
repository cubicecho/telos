import { useMutation } from '@apollo/client';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import { EmptyState } from '@/components/empty-state';
import { CircleAlert } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/spinner';
import { setToken } from '@/lib/auth';
import { describeError } from '@/lib/errors';
import { VerifyOneTimeTokenDocument } from '@/lib/graphql';

// Where an OIDC sign-in lands: the server's callback opened a session and put
// a one-time token for it on this URL, which is swapped for the session here.
export default function SsoScreen() {
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const [verifyOneTimeToken, { error }] = useMutation(VerifyOneTimeTokenDocument);
  // The token is spent on first use, and effects can run more than once.
  const started = useRef(false);

  useEffect(() => {
    if (started.current || !token) return;
    started.current = true;
    verifyOneTimeToken({ variables: { token } })
      .then(({ data }) => {
        if (!data?.verifyOneTimeToken) return;
        setToken(data.verifyOneTimeToken.token);
        router.replace('/');
      })
      .catch(() => {
        // Rendered from `error` below.
      });
  }, [token, verifyOneTimeToken, router]);

  return (
    <View className="min-h-full flex-1 items-center justify-center bg-background px-4">
      <View className="w-full max-w-sm items-center">
        {!token || error ? (
          <EmptyState
            iconSlot={<CircleAlert />}
            title="That sign-in didn't work"
            description={`${error ? describeError(error) : 'The sign-in came back without its token.'} It has to be finished within 3 minutes.`}
            actionSlot={
              <Link href="/login" className="text-info text-sm underline">
                Try again
              </Link>
            }
          />
        ) : (
          <View className="flex-row items-center justify-center gap-2">
            <Spinner />
            <Text className="text-foreground/60 text-sm">Signing you in…</Text>
          </View>
        )}
      </View>
    </View>
  );
}
