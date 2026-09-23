import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from '@/components/ui/icons';
import type { IconComponent } from '@/components/ui/icons-base';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { getThemePreference, setThemePreference, type ThemePreference } from '@/lib/theme';

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: IconComponent; hint: string }> = [
  { value: 'system', label: 'System', icon: Monitor, hint: 'Follow the operating system' },
  { value: 'light', label: 'Light', icon: Sun, hint: 'Always light' },
  { value: 'dark', label: 'Dark', icon: Moon, hint: 'Always dark' },
];

/** A radio group of three cards; cubeui's `RadioGroup` owns the roles and the arrow keys. */
export function ThemeSelector() {
  // localStorage is not readable while the markup hydrates, so the selection is
  // decided after mount. Until then nothing is marked active, which is honest —
  // the app does not yet know.
  const [preference, setPreference] = useState<ThemePreference | null>(null);
  useEffect(() => {
    setPreference(getThemePreference());
  }, []);

  function choose(value: string) {
    const next = value as ThemePreference;
    setThemePreference(next);
    setPreference(next);
  }

  return (
    <RadioGroup variant="card" aria-label="Theme" value={preference ?? undefined} onValueChange={choose}>
      {OPTIONS.map(({ value, label, icon: Icon, hint }) => (
        <RadioGroupItem
          key={value}
          value={value}
          label={label}
          hint={hint}
          icon={<Icon className="h-5 w-5 text-muted-foreground" />}
        />
      ))}
    </RadioGroup>
  );
}
