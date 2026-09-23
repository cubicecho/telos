import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoadFailure } from '../load-failure';

describe('LoadFailure', () => {
  it('says what went wrong, as an alert', () => {
    render(<LoadFailure error={new Error('Failed to fetch')} onRetry={() => {}} what="your projects" />);
    // An alert rather than a polite region: this stands where the content the
    // reader was waiting for should have been.
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load your projects');
    // In the app's words, not the browser's.
    expect(alert).toHaveTextContent('Couldn’t reach the server.');
  });

  it('retries once per click and re-enables itself', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn().mockResolvedValue(undefined);
    render(<LoadFailure error={new Error('Boom')} onRetry={onRetry} what="your projects" />);

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: /try again/i })).toBeEnabled();
  });

  it('survives a retry that fails too', async () => {
    const user = userEvent.setup();
    // The rejection is the point: an unhandled one here would turn a visible
    // failure into a second, invisible one.
    const onRetry = vi.fn().mockRejectedValue(new Error('Still down'));
    render(<LoadFailure error={new Error('Boom')} onRetry={onRetry} what="your projects" />);

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByRole('button', { name: /try again/i })).toBeEnabled();
    // Still showing the query's error, which is the one the screen reads.
    expect(screen.getByRole('alert')).toHaveTextContent('Boom');
  });
});
