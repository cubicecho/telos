import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { getThemePreference, setThemePreference, type ThemePreference } from '@/lib/theme';
import { cn } from '@/lib/utils';

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof Sun; hint: string }> = [
  { value: 'system', label: 'System', icon: Monitor, hint: 'Follow the operating system' },
  { value: 'light', label: 'Light', icon: Sun, hint: 'Always light' },
  { value: 'dark', label: 'Dark', icon: Moon, hint: 'Always dark' },
];

/**
 * Real radio inputs rather than buttons with `role="radio"`: it costs nothing
 * and brings arrow-key navigation and the group semantics along with it. The
 * input is visually hidden and the styled box is its sibling, so `peer-` can
 * carry focus and checked state across.
 */
export function ThemeSelector() {
  const name = useId();
  // localStorage is not readable while the markup hydrates, so the selection is
  // decided after mount. Until then nothing is marked active, which is honest —
  // the app does not yet know.
  const [preference, setPreference] = useState<ThemePreference | null>(null);
  useEffect(() => {
    setPreference(getThemePreference());
  }, []);

  function choose(value: ThemePreference) {
    setThemePreference(value);
    setPreference(value);
  }

  return (
    <fieldset className="grid grid-cols-3 gap-2">
      <legend className="sr-only">Theme</legend>
      {OPTIONS.map(({ value, label, icon: Icon, hint }) => {
        const active = preference === value;
        return (
          <label key={value} title={hint} className="cursor-pointer">
            <input
              type="radio"
              name={name}
              value={value}
              checked={active}
              onChange={() => choose(value)}
              className="peer sr-only"
            />
            <span
              className={cn(
                'flex flex-col items-center gap-2 rounded-lg border px-3 py-4 text-sm transition-colors',
                'peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2',
                active
                  ? 'border-primary bg-accent text-accent-foreground'
                  : 'border-border bg-card text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              <Icon className="h-5 w-5" />
              {label}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
