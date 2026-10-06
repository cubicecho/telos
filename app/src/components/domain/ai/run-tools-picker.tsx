import { useQuery } from '@apollo/client';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldLegend, FieldSet, FieldTitle } from '@/components/ui/field';
import { LoadState } from '@/components/ui/load-failure';
import { Switch } from '@/components/ui/switch';
import { McpToolsDocument } from '@/lib/graphql';

/**
 * Which of telos's own tools an agent's runs have, one switch per tool of the
 * MCP door, as a key has (api-key-manager.tsx). Null is the run default:
 * every read, adding todos and their dependencies, and notes; what the door
 * adds later follows it. A list is exactly the tools that are off.
 *
 * A tool no run may have (`record_artifact`: a run has the runner's) is not
 * shown. Whatever is switched on, a run writes only its own todo's tree and
 * what it made, and never moves, archives or deletes its own todo.
 */
export function RunToolsPicker({
  toolsOff,
  onChange,
}: {
  toolsOff: string[] | null;
  onChange: (toolsOff: string[] | null) => void;
}) {
  const query = useQuery(McpToolsDocument);
  const tools = (query.data?.mcpTools ?? []).filter((tool) => tool.forRuns);
  const isOn = (tool: (typeof tools)[number]) => (toolsOff === null ? tool.runDefault : !toolsOff.includes(tool.name));

  /** Saves the tools `on` leaves off, in door order, dropping names the door no longer has. */
  function save(on: (tool: (typeof tools)[number]) => boolean) {
    onChange(tools.filter((tool) => !on(tool)).map((tool) => tool.name));
  }

  function flip(name: string, on: boolean) {
    save((tool) => (tool.name === name ? on : isOn(tool)));
  }

  const groups = [
    { legend: 'Reading', tools: tools.filter((tool) => !tool.writes) },
    { legend: 'Writing', tools: tools.filter((tool) => tool.writes) },
  ];

  return (
    <View className="gap-2">
      <Text className="font-medium text-foreground text-sm">Telos tools for its runs</Text>
      <Text className="text-muted-foreground text-xs">
        {toolsOff === null
          ? 'The defaults: it reads the board, adds todos and leaves notes.'
          : 'Chosen for this agent.'}{' '}
        Whatever is on, a run changes only its own todo, the todos under it and the ones it made, and its todo's lane is
        decided when the run finishes.
      </Text>
      <LoadState query={query} what="the MCP tools" count={tools.length} emptySlot={null} />
      {tools.length === 0 ? null : (
        <View className="flex-row flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={toolsOff === null}
            onPress={() => onChange(null)}
            content="Defaults"
          />
          <Button variant="outline" size="sm" onPress={() => save((tool) => !tool.writes)} content="Read only" />
          <Button variant="outline" size="sm" onPress={() => onChange([])} content="All on" />
        </View>
      )}
      {groups.map((group) =>
        group.tools.length === 0 ? null : (
          <FieldSet key={group.legend} className="gap-3">
            <FieldLegend variant="label">{group.legend}</FieldLegend>
            {group.tools.map((tool) => (
              <Field key={tool.name} orientation="horizontal">
                <Switch
                  checked={isOn(tool)}
                  onCheckedChange={(on) => flip(tool.name, on)}
                  accessibilityLabel={tool.name}
                />
                <FieldContent>
                  <FieldTitle className="font-mono">{tool.name}</FieldTitle>
                  <FieldDescription>{tool.description.split('\n')[0]}</FieldDescription>
                </FieldContent>
              </Field>
            ))}
          </FieldSet>
        ),
      )}
    </View>
  );
}
