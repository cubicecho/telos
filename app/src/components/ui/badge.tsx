import { Children } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  type BadgeProps,
  type BadgeVariant,
  badgeContainerVariants,
  badgeHasLabel,
  badgeIconClass,
  badgeInkFallback,
  badgeInkVariants,
  badgeRemoveLabel,
  badgeTextFallback,
  badgeTextVariants,
  badgeVariants,
} from '@/components/ui/badge-base';
import { X } from '@/components/ui/icons';
import { IconClassContext } from '@/components/ui/icons-base';
import { cn } from '@/lib/utils';

/** A 12px glyph grown to about 28 by 28 of touch, without growing the pill. */
const REMOVE_HIT_SLOP = { top: 8, bottom: 8, left: 6, right: 8 } as const;

export type { BadgeProps, BadgeVariant };

/** A small pill naming a kind or a state, or a dot of the same colour when it has no children. */
export function Badge({
  variant = 'default',
  backgroundColor,
  textColor,
  className,
  label,
  onRemove,
  removeLabel,
  children,
}: BadgeProps) {
  const shape = badgeHasLabel(children) ? 'pill' : 'dot';
  const textClass = backgroundColor ? badgeTextFallback : badgeTextVariants({ variant });
  const inkClass = backgroundColor ? badgeInkFallback : badgeInkVariants({ variant });
  const dotName = label ? ({ role: 'img', 'aria-label': label } as const) : ({ 'aria-hidden': true } as const);

  return (
    <View
      // Yoga stretches a child across a column and has no fit-content to stop it, so on native the
      // badge pins itself to the start. In a centred row, pass `className="self-center"`.
      className={cn('self-start', badgeContainerVariants({ variant, shape }), className)}
      {...(backgroundColor ? { style: { backgroundColor } } : {})}
      // A dot carries meaning and no text, so it is named or it is decoration;
      // the same split `color-dot` makes, for the same reason.
      {...(shape === 'dot' ? dotName : {})}
    >
      {/* An icon passed as a child takes the badge's ink at the web's `[&>svg]:size-3`. */}
      <IconClassContext.Provider value={cn('size-3', textClass)}>
        {shape === 'pill'
          ? Children.map(children, (child) =>
              typeof child === 'string' || typeof child === 'number' ? (
                <Text numberOfLines={1} className={textClass} {...(textColor ? { style: { color: textColor } } : {})}>
                  {child}
                </Text>
              ) : (
                child
              ),
            )
          : null}
      </IconClassContext.Provider>
      {shape === 'pill' && onRemove ? (
        <Pressable
          onPress={onRemove}
          // The `role` is hand-written because a `<button>` has no native counterpart.
          role="button"
          aria-label={removeLabel ?? badgeRemoveLabel(children, label)}
          hitSlop={REMOVE_HIT_SLOP}
        >
          <X
            className={cn(badgeIconClass, inkClass)}
            // An inline prop wins over the colour the class maps to, as `style` does on the `Text`.
            {...(textColor ? { color: textColor } : {})}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

export { badgeVariants };
