import type { ReactNode } from 'react';
import { LabelManager } from '@/components/domain/label/label-manager';
import { ThemeSelector } from '@/components/domain/settings/theme-selector';

/** One card per thing you can change. Sections, not tabs — there are two. */
function Section({ title, description, children }: { title?: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-5">
      {title ? (
        <header className="mb-4">
          <h2 className="font-medium text-base">{title}</h2>
          {description ? <p className="mt-1 text-muted-foreground text-sm">{description}</p> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export default function SettingsScreen() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-8">
      <header className="border-b pb-4">
        <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Theme is kept on this device; labels belong to your account.
        </p>
      </header>

      <Section title="Theme" description="System follows whatever your operating system is set to.">
        <ThemeSelector />
      </Section>

      {/* No title here: the label manager brings its own heading, because it is
          a list with its own actions rather than a single control. */}
      <Section>
        <LabelManager />
      </Section>
    </div>
  );
}
