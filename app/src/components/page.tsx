import { Children, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { PageHeader, type PageHeaderProps } from '@/components/page-header';
import type { IconComponent } from '@/components/ui/icons-base';
import { cn } from '@/lib/utils';

type PageProps = {
  className?: string;
  children: ReactNode;
  /**
   * Full-height flex column (`h-full min-h-0`) instead of the default `flex-1`.
   * For a view whose body scrolls internally rather than as a whole.
   */
  fill?: boolean;
  /** Whether the page itself scrolls. Off for views with an inner scroll area. */
  scroll?: boolean;
  /** `narrow` constrains content to `max-w-2xl` — a settings or detail form. */
  width?: 'narrow';
};

export function Page({ className, children, fill = false, scroll = true, width }: PageProps) {
  const content = cn('container mx-auto px-4 py-6', width === 'narrow' && 'max-w-2xl', className);
  const outer = fill ? 'h-full min-h-0' : 'flex-1';

  if (!scroll) {
    return <View className={cn(outer, 'flex-col', content)}>{children}</View>;
  }

  return (
    <ScrollView className={outer} contentContainerClassName={content}>
      {children}
    </ScrollView>
  );
}

/**
 * The title row at the top of a page. There is one `PageHeader` in this set, and it lives in
 * `page-header`; it is re-exported here so a screen importing it from its page shell keeps
 * working. It took over from the small one this file used to carry, whose props were renamed on
 * the way: `subtitle` is `description`, `actions` is `action`, the heading is an `h1` unless
 * `level` says otherwise, and the `mb-4` under it is gone — space it with the page's own gap.
 */
export { PageHeader, type PageHeaderProps };

/**
 * The responsive card grid shared by list pages.
 *
 * `grid` has no native equivalent, so the columns come from flex wrapping plus
 * a percentage width on each cell. Each child is wrapped here rather than at the
 * call sites: the width has to sit on the cell, and a `Card` that carried it
 * would then only be layout-correct inside a grid.
 */
export function CardGrid({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <View className={cn('flex-row flex-wrap gap-4', className)}>
      {Children.map(children, (child) =>
        child == null || child === false ? null : (
          // The basis is a fraction of the row minus its share of the `gap-4`
          // above, which flex-basis percentages do not account for.
          <View className="w-full sm:w-[calc(50%-0.5rem)] lg:w-[calc(33.333%-0.667rem)] xl:w-[calc(25%-0.75rem)]">
            {child}
          </View>
        ),
      )}
    </View>
  );
}

type EmptyStateProps = {
  icon: IconComponent;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
};

/** The centred icon / title / description / action shown when a list is empty. */
export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <View className="w-full items-center gap-3 py-10">
      <View className="rounded-full bg-muted p-3">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </View>
      <View className="items-center">
        <Text className="font-medium text-sm text-foreground">{title}</Text>
        {description ? <Text className="text-center text-sm text-muted-foreground">{description}</Text> : null}
      </View>
      {action}
    </View>
  );
}
