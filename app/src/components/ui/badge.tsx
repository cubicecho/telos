import { Children } from 'react';
import { Text, View } from 'react-native';
import {
  type BadgeProps,
  type BadgeVariant,
  badgeContainerVariants,
  badgeHasLabel,
  badgeTextFallback,
  badgeTextVariants,
  badgeVariants,
} from '@/components/ui/badge-base';
import { cn } from '@/lib/utils';

export type { BadgeProps, BadgeVariant };

export function Badge({ variant = 'default', backgroundColor, textColor, className, label, children }: BadgeProps) {
  const shape = badgeHasLabel(children) ? 'pill' : 'dot';
  const textClass = backgroundColor ? badgeTextFallback : badgeTextVariants({ variant });

  return (
    <View
      className={cn(badgeContainerVariants({ variant, shape }), className)}
      {...(backgroundColor ? { style: { backgroundColor } } : {})}
      // A dot carries meaning and no text, so it is named or it is decoration;
      // the same split `color-dot` makes, for the same reason.
      {...(shape === 'dot'
        ? label
          ? ({ role: 'img', 'aria-label': label } as const)
          : ({ 'aria-hidden': true } as const)
        : {})}
    >
      {shape === 'pill'
        ? Children.map(children, (child) =>
            typeof child === 'string' || typeof child === 'number' ? (
              <Text className={textClass} {...(textColor ? { style: { color: textColor } } : {})}>
                {child}
              </Text>
            ) : (
              child
            ),
          )
        : null}
    </View>
  );
}

export { badgeVariants };
