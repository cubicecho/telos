import { Children, Fragment, isValidElement, type ReactElement } from 'react';
import { View } from 'react-native';
import { cn, type SlotNode } from '@/lib/utils';

/**
 * A row's cell. The padding is the list's and not the row's, so a `ListItem`, a `DisclosureRow` and
 * a row an app wrote itself sit the same distance from the rule above them.
 */
const ROW = 'min-w-0 py-1';

/**
 * The rule over every row but the first: the hairline `ItemSeparator` draws, as a border, so it
 * takes no row of its own and a list of one row has none.
 */
const RULE = 'border-foreground/10 border-t';

type ListProps = {
  /** The rows: `ListItem`s, `DisclosureRow`s, an array of them or a fragment. One cell each. */
  contentSlot?: SlotNode;
  /** What the list is a list of, in the reader's words: "Workspaces". Its accessible name. */
  label?: string;
  /** A rule between rows. On unless turned off, for rows that are cards of their own. */
  divided?: boolean;
  className?: string;
};

/**
 * The list a row sits in: a `<ul>` whose `<li>`s it writes itself, on device `role="list"` and
 * `role="listitem"`, so a screen reader says "list, 4 items" and a row is "2 of 4".
 *
 * - Each element of `contentSlot` is one row. An array or a fragment is opened first, so
 *   `rows.map(...)` beside a fixed last row is that many rows and not two.
 * - The rule between rows and the padding around each are the list's. A row brings neither.
 * - It has no empty and no loading state: those rungs are `QueryState`'s, above the list, and a
 *   list of no rows is not drawn at all rather than announced as "list, 0 items".
 */
function List({ contentSlot, label, divided = true, className }: ListProps) {
  const all = rows(contentSlot);
  if (all.length === 0) {
    return null;
  }

  return (
    <View role="list" testID="list" aria-label={label} className={cn('min-w-0', className)}>
      {all.map(({ key, row }, index) => (
        <View key={key} role="listitem" testID="list-row" className={cn(ROW, divided && index > 0 && RULE)}>
          {row}
        </View>
      ))}
    </View>
  );
}

/**
 * A slot's elements, one per row: arrays and fragments opened, the nothing values dropped. A row's
 * key is prefixed with its fragment's, since two opened fragments number their rows alike.
 */
function rows(slot: SlotNode, prefix = ''): { key: string; row: ReactElement }[] {
  return Children.toArray(slot).flatMap((child) => {
    if (isValidElement<{ children?: SlotNode }>(child) === false) {
      return [];
    }
    const key = `${prefix}${child.key}`;
    return child.type === Fragment ? rows(child.props.children, key) : [{ key, row: child }];
  });
}

export type { ListProps };
export { List };
