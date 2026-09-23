import type { LucideIcon, LucideProps } from 'lucide-react-native';
import ArrowDownWideNarrowSource from 'lucide-react-native/icons/arrow-down-wide-narrow';
import Columns3Source from 'lucide-react-native/icons/columns-3';
import EllipsisSource from 'lucide-react-native/icons/ellipsis';
import Link2Source from 'lucide-react-native/icons/link-2';
import ListSource from 'lucide-react-native/icons/list';
import LogOutSource from 'lucide-react-native/icons/log-out';
import RotateCwSource from 'lucide-react-native/icons/rotate-cw';
import TagSource from 'lucide-react-native/icons/tag';
import { styled } from 'nativewind';
import { useContext } from 'react';
import { IconClassContext } from '@/components/ui/icons-base';
import { cn } from '@/lib/utils';

/**
 * Icons this app draws that cubeui's `icons` item does not ship, wrapped the
 * way `ui/icons.tsx` wraps its own. That file keeps its `icon()` factory
 * private, so this is a copy of it until cubicecho/cubeui#87 exports it.
 */
type IconProps = Omit<LucideProps, 'className'> & {
  className?: string | undefined;
};

function icon(Source: LucideIcon) {
  const Styled = styled(Source, {
    className: {
      target: 'style',
      nativeStyleMapping: { width: true, height: true, color: true },
    },
  });

  return function Icon({ className, ...props }: IconProps) {
    const inherited = useContext(IconClassContext);
    return <Styled className={cn('text-foreground', inherited, className)} {...props} />;
  };
}

export const ArrowDownWideNarrow = icon(ArrowDownWideNarrowSource);
export const Columns3 = icon(Columns3Source);
export const Ellipsis = icon(EllipsisSource);
export const Link2 = icon(Link2Source);
export const List = icon(ListSource);
export const LogOut = icon(LogOutSource);
export const RotateCw = icon(RotateCwSource);
export const Tag = icon(TagSource);
