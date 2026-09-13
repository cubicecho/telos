import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { focusAndSelect, isTyping, useHotkey } from '../hotkeys';

function Harness({ onFire, hotkey = 'n' }: { onFire: () => void; hotkey?: string }) {
  useHotkey(hotkey, onFire);
  return (
    <div>
      <button type="button">Somewhere else</button>
      <input aria-label="A field" />
      <textarea aria-label="A note" />
      <div role="dialog" aria-label="A dialog">
        <button type="button">Inside the dialog</button>
      </div>
    </div>
  );
}

describe('useHotkey', () => {
  it('fires on the key, from outside a field', async () => {
    const user = userEvent.setup();
    const onFire = vi.fn();
    render(<Harness onFire={onFire} />);

    await user.click(screen.getByRole('button', { name: 'Somewhere else' }));
    await user.keyboard('n');

    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('stays quiet while a field has focus — "n" must type an "n"', async () => {
    const user = userEvent.setup();
    const onFire = vi.fn();
    render(<Harness onFire={onFire} />);

    await user.click(screen.getByLabelText('A field'));
    await user.keyboard('n');

    expect(onFire).not.toHaveBeenCalled();
    expect(screen.getByLabelText('A field')).toHaveValue('n');
  });

  it('stays quiet inside a textarea too', async () => {
    const user = userEvent.setup();
    const onFire = vi.fn();
    render(<Harness onFire={onFire} />);

    await user.click(screen.getByLabelText('A note'));
    await user.keyboard('n');

    expect(onFire).not.toHaveBeenCalled();
  });

  it('stays quiet behind an open dialog, field or no field', async () => {
    const user = userEvent.setup();
    const onFire = vi.fn();
    render(<Harness onFire={onFire} />);

    // A shortcut that fires from behind a modal acts on a screen the reader
    // cannot see, so the dialog's own buttons count as "not out here".
    await user.click(screen.getByRole('button', { name: 'Inside the dialog' }));
    await user.keyboard('n');

    expect(onFire).not.toHaveBeenCalled();
  });

  it('leaves a modified press to the browser', async () => {
    const user = userEvent.setup();
    const onFire = vi.fn();
    render(<Harness onFire={onFire} />);

    await user.click(screen.getByRole('button', { name: 'Somewhere else' }));
    await user.keyboard('{Control>}n{/Control}');
    await user.keyboard('{Meta>}n{/Meta}');
    await user.keyboard('{Alt>}n{/Alt}');

    expect(onFire).not.toHaveBeenCalled();
  });

  it('ignores every other key', async () => {
    const user = userEvent.setup();
    const onFire = vi.fn();
    render(<Harness onFire={onFire} />);

    await user.click(screen.getByRole('button', { name: 'Somewhere else' }));
    await user.keyboard('m/e');

    expect(onFire).not.toHaveBeenCalled();
  });

  it('still fires Escape from inside a field, which is the point of Escape', async () => {
    const user = userEvent.setup();
    const onFire = vi.fn();
    render(<Harness onFire={onFire} hotkey="Escape" />);

    await user.click(screen.getByLabelText('A field'));
    await user.keyboard('{Escape}');

    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('stops listening when unmounted', async () => {
    const user = userEvent.setup();
    const onFire = vi.fn();
    const { unmount } = render(<Harness onFire={onFire} />);

    unmount();
    await user.keyboard('n');

    expect(onFire).not.toHaveBeenCalled();
  });

  it('calls the latest handler, not the one it mounted with', async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness onFire={first} />);

    rerender(<Harness onFire={second} />);
    await user.keyboard('n');

    // The handler lives in a ref so callers need not memoize it; a stale
    // closure here would be a shortcut acting on last render's state.
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('isTyping', () => {
  it('says no for a button and yes for the fields', () => {
    render(<Harness onFire={() => {}} />);

    expect(isTyping(screen.getByRole('button', { name: 'Somewhere else' }))).toBe(false);
    expect(isTyping(screen.getByLabelText('A field'))).toBe(true);
    expect(isTyping(screen.getByLabelText('A note'))).toBe(true);
    expect(isTyping(null)).toBe(false);
  });

  it('says yes for a widget wearing a field role, element notwithstanding', () => {
    // Built by hand rather than rendered: these are ARIA roles pinned onto
    // divs, which is the shape `isTyping` exists to catch and the shape a JSX
    // linter is right to complain about everywhere else.
    for (const role of ['textbox', 'combobox', 'searchbox']) {
      const widget = document.createElement('div');
      widget.setAttribute('role', role);
      expect(isTyping(widget)).toBe(true);
    }
  });

  it('says yes for a contenteditable', () => {
    const rich = document.createElement('div');
    // jsdom parses the attribute but does not derive `isContentEditable` from
    // it, so state it directly — the property is what the predicate reads.
    Object.defineProperty(rich, 'isContentEditable', { value: true });
    expect(isTyping(rich)).toBe(true);
  });

  it('says yes for anything inside a dialog, whatever it is', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const button = document.createElement('button');
    dialog.append(button);
    expect(isTyping(button)).toBe(true);
  });

  it('says no for a target that is not an element at all', () => {
    // `document` and `window` both arrive as event targets, and neither is a
    // place a keystroke means a character.
    expect(isTyping(document)).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});

describe('focusAndSelect', () => {
  function Focusable() {
    const ref = useRef<HTMLInputElement>(null);
    return (
      <>
        <input ref={ref} aria-label="Target" defaultValue="already here" />
        <button type="button" onClick={() => focusAndSelect(ref.current)}>
          Focus
        </button>
      </>
    );
  }

  it('focuses the field and selects what is in it, so typing replaces', async () => {
    const user = userEvent.setup();
    render(<Focusable />);

    await user.click(screen.getByRole('button', { name: 'Focus' }));

    const field = screen.getByLabelText('Target') as HTMLInputElement;
    expect(field).toHaveFocus();
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe('already here'.length);
  });

  it('does nothing at all when there is no element yet', () => {
    expect(() => focusAndSelect(null)).not.toThrow();
  });
});
