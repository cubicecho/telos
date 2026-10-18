/**
 * A description folded behind a small button: what `descriptionPlacement="popover"` draws on the
 * bound fields, `CardLayout`, `Section` and `SettingRow`, written once so the four agree.
 *
 * A description that came from a schema is a paragraph, and a paragraph under every field, card
 * and row is a page nobody reads. It is still the best answer to "what is this?", so it goes one
 * press away instead of being deleted. Written by hand at a call site this goes wrong the same
 * three ways each time: the button lands inside the label's `Text`, the name "About …" is built
 * from a label that had to be narrowed to a string first, and the control stops being described
 * because the text left the page with the popover.
 *
 * Two parts, because they sit in different places: `DescriptionHint` is the button and its pane,
 * beside the title; `DescriptionHintText` is the copy assistive technology reads, wherever the
 * inline description would have been.
 */
import type { ReactNode } from 'react';
import { Platform, Text } from 'react-native';
import { Button } from '@/components/ui/button';
import { CircleQuestionMark } from '@/components/ui/icons';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { SlotNode } from '@/lib/utils';

/** Where a description is drawn: under what it describes, or behind a button beside its title. */
type DescriptionPlacement = 'inline' | 'popover';

type DescriptionHintProps = {
  /** The sentence the pane shows. */
  description: ReactNode;
  /**
   * What the description is about: the field's label, the card's title. A string names the
   * button and the pane "About <label>"; anything else falls back to `fallbackName`.
   */
  label?: ReactNode | undefined;
  /** The name when `label` is not a string: "About this field", "About this card". */
  fallbackName: string;
  /** The button's glyph. A question mark by default. */
  iconSlot?: SlotNode | undefined;
  /** The button's `testID` / `data-slot`, so each shell's trigger can be told apart. */
  testID?: string | undefined;
};

/** The button and the pane it opens. Place it beside the title, never inside the title's text. */
function DescriptionHint({ description, label, fallbackName, iconSlot, testID }: DescriptionHintProps) {
  // One name for both: the web pane is a `dialog`, and a dialog with no name is announced as
  // just that. The paragraph inside it is the description, not the name.
  const name = typeof label === 'string' ? `About ${label}` : fallbackName;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          testID={testID}
          variant="ghost"
          size="icon-xs"
          aria-label={name}
          // The row is as tall as its title, not as tall as a button: the margin gives back what
          // the button's box adds, so a title with a hint and one without sit on the same line.
          className="-my-1 shrink-0 rounded-full text-foreground/60"
          iconSlot={iconSlot ?? <CircleQuestionMark aria-hidden />}
        />
      </PopoverTrigger>
      <PopoverContent align="start" aria-label={name} className="max-w-xs">
        <Text className="text-foreground text-sm leading-relaxed">{description}</Text>
      </PopoverContent>
    </Popover>
  );
}

type DescriptionHintTextProps = {
  /** The id the control's `aria-describedby` points at. */
  id?: string | undefined;
  children: ReactNode;
};

/**
 * The description, off the screen and still read, for `aria-describedby` to reach while the
 * pane is shut: a popover's content is unmounted on close, so a description living only there is
 * one a screen reader never meets. Web only. A device has no `aria-describedby` to resolve, and
 * hidden text there is text VoiceOver stops on between the label and the control.
 */
function DescriptionHintText({ id, children }: DescriptionHintTextProps) {
  if (Platform.OS !== 'web') {
    return null;
  }
  return (
    <Text testID="description-hint-text" id={id} className="sr-only">
      {children}
    </Text>
  );
}

export type { DescriptionHintProps, DescriptionHintTextProps, DescriptionPlacement };
export { DescriptionHint, DescriptionHintText };
