/**
 * A loading indicator: the `LoaderCircle` glyph, turning. `spinner.web.tsx` is
 * the web counterpart and `spinner-base.ts` holds what they share.
 *
 * Not `ActivityIndicator`. That one draws the platform's own spinner, which is
 * a different shape on iOS, on Android and in the browser, and takes a colour
 * prop but no class. This is the same glyph the web half turns, sized and
 * coloured by `className` through `@cubeui/icons` — so inside a `Button` it
 * takes the button's ink from `IconClassContext`, as any icon there does.
 *
 * The turn is `Animated` on the native driver, one linear turn a second, which
 * is Tailwind's `animate-spin`. The compiler refuses `Animated`, which is why
 * the web half is hand-written rather than compiled from this file.
 */
import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { LoaderCircle } from '@/components/ui/icons';
import { SPIN_DURATION_MS, type SpinnerProps, spinnerClass } from '@/components/ui/spinner-base';
import { cn } from '@/lib/utils';

export type { SpinnerProps };

/** A turning glyph that says something is loading. */
export function Spinner({ label = 'Loading', className }: SpinnerProps) {
  const turn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(turn, {
        toValue: 1,
        duration: SPIN_DURATION_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [turn]);

  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <Animated.View role="status" aria-label={label} style={{ alignSelf: 'flex-start', transform: [{ rotate }] }}>
      <LoaderCircle className={cn(spinnerClass, className)} aria-hidden />
    </Animated.View>
  );
}
