import { useMutation } from '@apollo/client';
import { Link, useRouter } from 'expo-router';
import { CheckCircle2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { setToken } from '@/lib/auth';
import { describeError } from '@/lib/errors';
import { RequestMagicLinkDocument } from '@/lib/graphql';

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [magicLink, setMagicLink] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [requestMagicLink, { loading, error }] = useMutation(RequestMagicLinkDocument);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSent(false);
    setMagicLink(null);
    const { data } = await requestMagicLink({ variables: { email } });
    const result = data?.requestMagicLink;
    if (!result) return;
    // With AUTH_MAGIC_LINK=false the server hands back a live session instead of
    // a link, so the client keeps one code path and stores whatever it gets.
    if (result.token) {
      setToken(result.token);
      router.replace('/');
      return;
    }
    setMagicLink(result.magicLink ?? null);
    setSent(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="font-semibold text-3xl tracking-tight">Telos</h1>
          <p className="mt-1 text-muted-foreground text-sm">Projects, todos, and what blocks them.</p>
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={loading || email.trim() === ''}>
            {loading ? <Spinner className="text-primary-foreground" /> : 'Send sign-in link'}
          </Button>
        </form>

        {error ? <p className="mt-4 text-destructive text-sm">{describeError(error)}</p> : null}

        {sent ? (
          <div className="mt-6 rounded-lg border bg-card p-4">
            <p className="flex items-center gap-2 font-medium text-sm">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              Sign-in link sent
            </p>
            {magicLink ? (
              <>
                <p className="mt-2 text-muted-foreground text-sm">
                  This instance has no mail relay, so the link is shown here and printed to the server log.
                </p>
                <Link href={magicLink} className="mt-2 block break-all text-primary text-sm underline">
                  {magicLink}
                </Link>
              </>
            ) : (
              /* Not "check your inbox": Telos ships no mail relay, so nothing
                 was ever sent anywhere. The link is in the server log, and
                 saying so is the difference between a reader waiting for an
                 email that will not come and one who knows where to look. */
              <p className="mt-2 text-muted-foreground text-sm">
                This instance sends no mail — the link was written to the server log. Whoever runs it can read it from
                there, or set <code className="rounded bg-muted px-1 py-0.5 text-xs">EXPOSE_MAGIC_LINK=true</code> to
                show it on this page.
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
