import { useQuery } from '@apollo/client';
import { Text, View } from 'react-native';
import { ActionButton } from '@/components/action-button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldContent, FieldDescription, FieldTitle } from '@/components/ui/field';
import { X } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { McpServersDocument } from '@/lib/graphql';

/**
 * Which of the account's MCP servers an agent reaches. One of three things:
 * every server, whatever is added later (null); none (an empty list); or
 * exactly the ones ticked.
 *
 * A slug the list holds that names no server is shown, not dropped: the runs
 * say so too, and removing it is the person's to do.
 */
export function McpServerPicker({
  slugs,
  onChange,
}: {
  slugs: string[] | null;
  onChange: (slugs: string[] | null) => void;
}) {
  const query = useQuery(McpServersDocument);
  const servers = query.data?.mcpServers ?? [];
  const known = new Set(servers.map((server) => server.slug));
  const missing = (slugs ?? []).filter((slug) => known.has(slug) === false);

  function toggle(slug: string, on: boolean) {
    const rest = (slugs ?? []).filter((held) => held !== slug);
    onChange(on ? [...rest, slug] : rest);
  }

  return (
    <View className="gap-2">
      <Text className="font-medium text-foreground text-sm">MCP servers</Text>
      <Text className="text-muted-foreground text-xs">
        Telos's own tools are chosen below. The servers themselves are kept under MCP servers, in settings.
      </Text>
      <Field orientation="horizontal">
        <Checkbox
          checked={slugs === null}
          // Narrowing starts from what it reaches now, so unticking this alone changes nothing.
          onCheckedChange={(checked) => onChange(checked === true ? null : servers.map((server) => server.slug))}
          accessibilityLabel="Every server"
        />
        <FieldContent>
          <FieldTitle>Every server</FieldTitle>
          <FieldDescription>All of the account's, including any added later.</FieldDescription>
        </FieldContent>
      </Field>
      {slugs === null ? null : (
        <View className="gap-2 pl-6">
          <LoadState
            query={query}
            what="your MCP servers"
            count={servers.length + missing.length}
            empty={<Text className="text-muted-foreground text-xs">No servers yet, so it reaches none.</Text>}
          />
          {servers.map((server) => (
            <Field key={server.id} orientation="horizontal">
              <Checkbox
                checked={slugs.includes(server.slug)}
                onCheckedChange={(checked) => toggle(server.slug, checked === true)}
                accessibilityLabel={server.name}
              />
              <FieldContent>
                <FieldTitle>{server.name}</FieldTitle>
                <FieldDescription>
                  {server.slug}
                  {server.enabled ? '' : ' · switched off, so no agent reaches it'}
                </FieldDescription>
              </FieldContent>
            </Field>
          ))}
          {missing.map((slug) => (
            <View key={slug} className="flex-row items-center gap-2">
              <Text className="flex-1 text-destructive text-xs">“{slug}” no longer exists, so it is left out.</Text>
              <ActionButton variant="ghost" size="icon-sm" label={`Remove ${slug}`} onPress={() => toggle(slug, false)}>
                <X className="h-4 w-4" />
              </ActionButton>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
