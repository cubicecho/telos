import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoadFailure, LoadState } from '../load-failure';

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

describe('LoadState', () => {
  const refetch = () => Promise.resolve();

  it('stands in with placeholders while there is no answer yet', () => {
    render(<LoadState query={{ loading: true, refetch }} what="your labels" count={0} empty="No labels yet." />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText('No labels yet.')).not.toBeInTheDocument();
  });

  it('says it failed rather than that there are none', () => {
    render(
      <LoadState
        query={{ loading: false, error: new Error('Failed to fetch'), refetch }}
        what="your labels"
        count={0}
        empty="No labels yet."
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t reach the server.');
    expect(screen.queryByText('No labels yet.')).not.toBeInTheDocument();
  });

  it('keeps the last good rows through a refetch and a failed one', () => {
    const data = { labels: [{ id: '1' }] };
    const { container, rerender } = render(
      <LoadState query={{ loading: true, data, refetch }} what="your labels" count={1} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <LoadState query={{ loading: false, error: new Error('Boom'), data, refetch }} what="your labels" count={1} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('says there are none once the server says so', () => {
    render(
      <LoadState
        query={{ loading: false, data: { labels: [] }, refetch }}
        what="your labels"
        count={0}
        empty="No labels yet."
      />,
    );
    expect(screen.getByText('No labels yet.')).toBeInTheDocument();
  });
});
