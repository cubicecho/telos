import { useMutation, useQuery } from '@apollo/client';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { SsoSource } from '@/__generated__/graphql';
import { useAppForm } from '@/components/app-form';
import { CardLayout } from '@/components/card-layout';
import { PairSsoForm } from '@/components/domain/sso/sso-pairing';
import { Button } from '@/components/ui/button';
import { Code } from '@/components/ui/code';
import { Form } from '@/components/ui/form';
import { CircleCheck } from '@/components/ui/icons';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { API_URL } from '@/lib/apollo';
import { setToken } from '@/lib/auth';
import { describeError } from '@/lib/errors';
import { SignInMagicLinkDocument, SignInOptionsDocument, SsoSetupDocument } from '@/lib/graphql';

export default function LoginScreen() {
  const router = useRouter();
  const [magicLink, setMagicLink] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [signInMagicLink, { error }] = useMutation(SignInMagicLinkDocument);
  const sso = useQuery(SignInOptionsDocument).data?.authConfig.sso ?? null;
  // An OIDC sign-in that failed comes back here with better-auth's error code.
  const { error: ssoError } = useLocalSearchParams<{ error?: string }>();
  // A new instance (no accounts yet, no provider) offers to pair one here, so
  // whoever installs it can set sign-in up before there is an admin. After
  // that, pairing is an admin's, in Settings.
  const setup = useQuery(SsoSetupDocument).data?.ssoSetup;
  const offerSetup = setup?.canPair === true && setup.source === SsoSource.None;
  const [tab, setTab] = useState<'sign-in' | 'set-up'>('sign-in');
  const [paired, setPaired] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: { email: '' },
    onSubmit: ({ value }) => send(value.email.trim()),
  });

  async function send(email: string) {
    setSent(false);
    setMagicLink(null);
    try {
      const { data } = await signInMagicLink({ variables: { email } });
      const result = data?.signInMagicLink;
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

  const signIn = (
    <View>
      {sso ? (
        <View className="mb-6 gap-6">
          <Button
            onPress={() => window.location.assign(`${API_URL}${sso.signInPath}`)}
            content={`Sign in with ${sso.name}`}
          />
          <Text className="text-center text-foreground/60 text-sm">or get a sign-in link</Text>
        </View>
      ) : null}

      {ssoError ? (
        <Text className="mb-4 text-negative text-sm">
          {sso ? `Signing in with ${sso.name} didn't work` : "Signing in didn't work"} ({ssoError}). Try again, or ask
          whoever runs this instance.
        </Text>
      ) : null}

      <form.AppForm>
        <Form className="gap-4">
          <form.AppField
            name="email"
            validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Enter your email.' : undefined) }}
          >
            {(field) => <field.InputField label="Email" type="email" placeholder="you@example.com" />}
          </form.AppField>
          <form.SubmitButton createLabel="Send sign-in link" savingLabel="Sending…" />
        </Form>
      </form.AppForm>

      {error ? <Text className="mt-4 text-negative text-sm">{describeError(error)}</Text> : null}

      {sent ? (
        <CardLayout
          className="mt-6"
          iconSlot={<CircleCheck className="size-4 text-positive" />}
          title="Sign-in link sent"
          contentSlot={
            magicLink ? (
              <View className="gap-2">
                <Text className="text-foreground/60 text-sm">
                  This instance has no mail relay, so the link is shown here and printed to the server log.
                </Text>
                <Link href={magicLink} className="break-all text-info text-sm underline">
                  {magicLink}
                </Link>
              </View>
            ) : (
              /* Not "check your inbox": Telos ships no mail relay, so nothing
                 was ever sent anywhere. The link is in the server log, and
                 saying so is the difference between a reader waiting for an
                 email that will not come and one who knows where to look. */
              <Text className="text-foreground/60 text-sm">
                This instance sends no mail — the link was written to the server log. Whoever runs it can read it from
                there, or set <Code>EXPOSE_MAGIC_LINK=true</Code> to show it on this page.
              </Text>
            )
          }
        />
      ) : null}
    </View>
  );

  return (
    <View className="min-h-full flex-1 items-center justify-center bg-background px-4">
      <View className="w-full max-w-sm">
        <View className="mb-8 items-center">
          <Text role="heading" aria-level={1} className="font-semibold text-3xl text-foreground tracking-tight">
            Telos
          </Text>
          <Text className="mt-1 text-foreground/60 text-sm">Projects, todos, and what blocks them.</Text>
        </View>

        {paired ? (
          <Text className="mb-4 text-positive text-sm" aria-live="polite">
            Paired with {paired}. Sign in with it below; the first account to sign in runs this instance.
          </Text>
        ) : null}
        {offerSetup ? (
          <Tabs
            value={tab}
            onValueChange={(next) => setTab(next as 'sign-in' | 'set-up')}
            className="flex flex-col gap-6"
          >
            <TabsList aria-label="Sign in or set up" className="self-center">
              <TabsTrigger value="sign-in">Sign in</TabsTrigger>
              <TabsTrigger value="set-up">Set up sign-in</TabsTrigger>
            </TabsList>
            <TabsContent value="sign-in" className="mt-0">
              {signIn}
            </TabsContent>
            <TabsContent value="set-up" className="mt-0">
              <View className="gap-4">
                <Text className="text-foreground/60 text-sm">
                  Pair Telos with an OpenID Connect provider, such as heautou, and its button joins the emailed link
                  here. Paste the setup URL its admin made for Telos.
                </Text>
                <PairSsoForm
                  onPaired={(name) => {
                    setPaired(name);
                    setTab('sign-in');
                  }}
                />
              </View>
            </TabsContent>
          </Tabs>
        ) : (
          signIn
        )}
      </View>
    </View>
  );
}
