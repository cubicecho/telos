import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoadFailure } from '../load-failure';

describe('LoadFailure', () => {
  it('says what went wrong, as an alert', () => {
    render(<LoadFailure error={new Error('Failed to fetch')} />);
    // An alert rather than a polite region: this stands where the content the
    // reader was waiting for should have been.
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t reach the server.');
  });

  it('offers no Retry when there is nothing to retry with', () => {
    render(<LoadFailure error={new Error('Boom')} />);
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('retries once per click and re-enables itself', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn().mockResolvedValue(undefined);
    render(<LoadFailure error={new Error('Boom')} onRetry={onRetry} />);

    await user.click(screen.getByRole('button', { name: /retry/i }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /retry/i })).toBeEnabled();
  });

  it('survives a retry that fails too', async () => {
    const user = userEvent.setup();
    // The rejection is the point: an unhandled one here would turn a visible
    // failure into a second, invisible one.
    const onRetry = vi.fn().mockRejectedValue(new Error('Still down'));
    render(<LoadFailure error={new Error('Boom')} onRetry={onRetry} />);

    await user.click(screen.getByRole('button', { name: /retry/i }));

    const button = screen.getByRole('button', { name: /retry/i });
    expect(button).toBeEnabled();
    // Still showing the query's error, which is the one the screen reads.
    expect(screen.getByRole('alert')).toHaveTextContent('Boom');
  });
});
