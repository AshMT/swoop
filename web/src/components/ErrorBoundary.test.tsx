import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

/**
 * The dashboard renders values that come straight from the API and from stored
 * JSON, so a render-time throw is a real possibility. Without a boundary React
 * unmounts the whole tree, leaving a blank page whose only explanation is in
 * the browser console.
 */

// The return annotation is required because a function that always throws
// infers `never`, which TypeScript will not accept as a JSX component.
function Boom({ message = 'entities is not valid JSON' }: { message?: string }): JSX.Element {
  throw new Error(message);
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs the caught error itself; silence it so a passing run is quiet.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  cleanup();
});

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>the dashboard</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('the dashboard')).toBeTruthy();
  });

  it('shows a panel instead of a blank page when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();
    // The message is surfaced, not swallowed.
    expect(screen.getByText(/entities is not valid JSON/)).toBeTruthy();
  });

  it('names the page that failed when given a label', () => {
    render(
      <ErrorBoundary label="The dashboard">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/the dashboard could not be displayed/i)).toBeTruthy();
  });

  /**
   * The operator's first worry on seeing an error is whether triage stopped.
   * It did not — the poller runs server-side — and the panel says so.
   */
  it('reassures that classification is unaffected', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/carries on in the background/i)).toBeTruthy();
  });

  it('offers a way back rather than a dead end', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /reload the page/i })).toBeTruthy();
  });

  it('recovers when Try again is pressed and the cause has gone', () => {
    let shouldThrow = true;
    function Flaky(): JSX.Element {
      if (shouldThrow) throw new Error('transient');
      return <p>recovered content</p>;
    }

    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/something went wrong/i)).toBeTruthy();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByText('recovered content')).toBeTruthy();
  });

  it('logs the failure so a developer has the component stack', () => {
    render(
      <ErrorBoundary>
        <Boom message="diagnostic detail" />
      </ErrorBoundary>,
    );
    const logged = consoleError.mock.calls.some((call) =>
      call.some((arg) => String(arg).includes('[Swoop] Render error')),
    );
    expect(logged).toBe(true);
  });

  it('uses a custom fallback when one is supplied', () => {
    render(
      <ErrorBoundary fallback={(error) => <p>custom: {error.message}</p>}>
        <Boom message="boom" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('custom: boom')).toBeTruthy();
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });

  it('isolates the failure — a sibling boundary still renders', () => {
    render(
      <div>
        <ErrorBoundary label="Panel A">
          <Boom />
        </ErrorBoundary>
        <ErrorBoundary label="Panel B">
          <p>panel B is fine</p>
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByText(/panel a could not be displayed/i)).toBeTruthy();
    expect(screen.getByText('panel B is fine')).toBeTruthy();
  });
});
