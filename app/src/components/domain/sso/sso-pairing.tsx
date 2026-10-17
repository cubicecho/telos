import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { SsoSource } from '@/__generated__/graphql';
import { useAppForm } from '@/components/app-form';
import { ConfirmButton } from '@/components/confirm-button';
import { Section } from '@/components/section';
import { SettingRow } from '@/components/setting-row';
import { Code } from '@/components/ui/code';
import { Form } from '@/components/ui/form';
import { describeError } from '@/lib/errors';
import { PairSsoDocument, SignInOptionsDocument, SsoSetupDocument, UnpairSsoDocument } from '@/lib/graphql';
import { CARD_TITLE } from '@/lib/styles';

// Pairing the instance with an OIDC provider (heautou, or any that supports
// Dynamic Client Registration) by pasting the setup URL it gives you. The
// login page's button is `authConfig.sso`, so both queries are asked again
// after a change: the answers have no id to update in place.

const REFETCH = { refetchQueries: [SsoSetupDocument, SignInOptionsDocument], awaitRefetchQueries: true };

/**
 * The paste-and-connect form. The server checks who may pair; this only asks.
 *
 * @param onPaired Called with the provider's name once it is paired.
 */
export function PairSsoForm({ onPaired }: { onPaired?: ((name: string) => void) | undefined }) {
  const [pairSso] = useMutation(PairSsoDocument, REFETCH);
  const [error, setError] = useState<string | null>(null);

  const form = useAppForm({
    defaultValues: { setupUrl: '' },
    onSubmit: async ({ value, formApi }) => {
      setError(null);
      try {
        const { data } = await pairSso({ variables: { setupUrl: value.setupUrl.trim() } });
        formApi.reset();
        onPaired?.(data?.pairSso.name ?? 'SSO');
      } catch (cause) {
        setError(describeError(cause));
      }
    },
  });

  return (
    <View className="gap-3">
      <form.AppForm>
        <Form className="gap-4">
          <form.AppField
            name="setupUrl"
            validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Paste the setup URL.' : undefined) }}
          >
            {(field) => (
              <field.InputField
                label="Setup URL"
                type="url"
                placeholder="https://id.example.com/oidc#setup=…"
                description="Your provider's admin makes this for Telos. It works once, and only for a short while."
                autoCapitalize="none"
                autoCorrect={false}
              />
            )}
          </form.AppField>
          <form.SubmitButton createLabel="Connect" savingLabel="Connecting…" />
        </Form>
      </form.AppForm>
      {error ? (
        <Text className="text-negative text-sm" aria-live="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Settings' sign-in card: which provider the login page offers, and, for an
 * admin, connecting or disconnecting one. A provider set in the server's
 * environment is shown but cannot be changed here.
 */
export function SsoSettings() {
  const { data } = useQuery(SsoSetupDocument);
  const [unpairSso, { loading }] = useMutation(UnpairSsoDocument, REFETCH);
  const [error, setError] = useState<string | null>(null);
  const setup = data?.ssoSetup;
  if (!setup) return null;
  const fromEnv = setup.source === SsoSource.Env;
  // Only someone who may change it is shown the card, and for the environment's
  // provider that is nobody: an admin still wants to see what is set, so the
  // caller decides that case.
  if (!setup.canPair && !fromEnv) return null;

  async function disconnect() {
    setError(null);
    try {
      await unpairSso();
    } catch (cause) {
      setError(describeError(cause));
    }
  }

  return (
    <Section
      surface="card"
      titleClassName={CARD_TITLE}
      title="Sign-in"
      description="People can always sign in with an emailed link. An OpenID Connect provider adds a button for it on the login page."
      contentSlot={
        <View className="gap-3">
          {fromEnv ? (
            <SettingRow
              title={`Sign in with ${setup.name ?? 'SSO'}`}
              description={
                <>
                  Set by <Code>OIDC_ISSUER</Code> in the server's environment, so it is changed there. Its redirect URI
                  is <Code>{setup.redirectUri}</Code>.
                </>
              }
            />
          ) : setup.source === SsoSource.Paired ? (
            <SettingRow
              title={`Sign in with ${setup.name ?? 'SSO'}`}
              description={setup.issuer ? `Paired with ${setup.issuer}.` : 'Paired.'}
              actionSlot={
                <ConfirmButton
                  variant="destructive-outline"
                  content="Disconnect"
                  loading={loading}
                  title={`Disconnect ${setup.name ?? 'the provider'}?`}
                  description="Its button leaves the login page and Telos's client is deleted at the provider. Accounts stay, and can still sign in with an emailed link."
                  confirmLabel="Disconnect"
                  onConfirm={() => void disconnect()}
                />
              }
            />
          ) : (
            <PairSsoForm />
          )}
          {error ? (
            <Text className="text-negative text-sm" aria-live="polite">
              {error}
            </Text>
          ) : null}
        </View>
      }
    />
  );
}
