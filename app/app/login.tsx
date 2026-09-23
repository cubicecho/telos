import { useMutation } from '@apollo/client';
import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormElement } from '@/components/ui/form-element';
import { CircleCheck } from '@/components/ui/icons';
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
  const canSubmit = !loading && email.trim() !== '';

  async function onSubmit() {
    // Enter submits the `<form>` whether or not the button is enabled, so the
    // guard the button's `disabled` gives has to be repeated here.
    if (!canSubmit) return;
    setSent(false);
    setMagicLink(null);
    try {
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
    } catch {
      // Rendered from `error` below.
    }
  }

  return (
    <View className="min-h-full flex-1 items-center justify-center bg-background px-4">
      <View className="w-full max-w-sm">
        <View className="mb-8 items-center">
          <Text role="heading" aria-level={1} className="font-semibold text-3xl text-foreground tracking-tight">
            Telos
          </Text>
          <Text className="mt-1 text-muted-foreground text-sm">Projects, todos, and what blocks them.</Text>
        </View>

        <FormElement onSubmit={() => void onSubmit()} className="gap-4">
          <View className="gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" placeholder="you@example.com" value={email} onChangeText={setEmail} />
          </View>
          <Button disabled={!canSubmit} onPress={() => void onSubmit()}>
            {loading ? <Spinner className="text-primary-foreground" /> : 'Send sign-in link'}
          </Button>
        </FormElement>

        {error ? <Text className="mt-4 text-destructive text-sm">{describeError(error)}</Text> : null}

        {sent ? (
          <Card className="mt-6 gap-0 border-border p-4">
            <View className="flex-row items-center gap-2">
              <CircleCheck className="h-4 w-4 text-primary" aria-hidden />
              <Text className="font-medium text-card-foreground text-sm">Sign-in link sent</Text>
            </View>
            {magicLink ? (
              <>
                <Text className="mt-2 text-muted-foreground text-sm">
                  This instance has no mail relay, so the link is shown here and printed to the server log.
                </Text>
                <Link href={magicLink} className="mt-2 break-all text-primary text-sm underline">
                  {magicLink}
                </Link>
              </>
            ) : (
              /* Not "check your inbox": Telos ships no mail relay, so nothing
                 was ever sent anywhere. The link is in the server log, and
                 saying so is the difference between a reader waiting for an
                 email that will not come and one who knows where to look. */
              <Text className="mt-2 text-muted-foreground text-sm">
                This instance sends no mail — the link was written to the server log. Whoever runs it can read it from
                there, or set{' '}
                <Text className="rounded bg-muted px-1 py-0.5 font-mono text-xs">EXPOSE_MAGIC_LINK=true</Text> to show
                it on this page.
              </Text>
            )}
          </Card>
        ) : null}
      </View>
    </View>
  );
}
