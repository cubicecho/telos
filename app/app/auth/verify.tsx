import { useMutation } from '@apollo/client';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
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
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm text-center">
        {!token || error ? (
          <>
            <h1 className="font-semibold text-xl">That link didn't work</h1>
            <p className="mt-2 text-muted-foreground text-sm">
              {error ? describeError(error) : 'The link is missing its token.'} Sign-in links expire after 15 minutes.
            </p>
            <Link href="/login" className="mt-4 inline-block text-primary text-sm underline">
              Request a new one
            </Link>
          </>
        ) : (
          <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
            <Spinner />
            Signing you in…
          </div>
        )}
      </div>
    </div>
  );
}
