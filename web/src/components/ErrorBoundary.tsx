import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render-time throw so one bad component does not white-screen the
 * whole app.
 *
 * This is not hypothetical here: the dashboard renders values that come
 * straight from the API and from stored JSON, and a malformed `entities`
 * string or an unexpected null is enough to throw during render. Without a
 * boundary React unmounts the entire tree, leaving a blank page with nothing
 * on screen to explain it — the operator's only clue is the browser console.
 */
interface Props {
  children: ReactNode;
  /** Shown above the message, e.g. the page that failed. */
  label?: string;
  /** Rendered instead of the default panel. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is where a developer will look; the panel is for the operator.
    console.error('[Swoop] Render error:', error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="card w-full max-w-lg p-6">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">
            {this.props.label ? `${this.props.label} could not be displayed` : 'Something went wrong'}
          </h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            This is a bug in Swoop's interface, not a problem with your tickets. Classification carries on in
            the background regardless — nothing has been lost.
          </p>

          <pre className="mt-4 max-h-40 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400">
            {error.message || String(error)}
          </pre>

          <div className="mt-5 flex flex-wrap gap-2">
            <button onClick={this.reset} className="btn-primary">
              Try again
            </button>
            <button onClick={() => window.location.reload()} className="btn-secondary">
              Reload the page
            </button>
            <a href="/queue" className="btn-ghost">
              Back to the queue
            </a>
          </div>

          <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
            If it keeps happening, the browser console has the component stack — please include it in a bug
            report.
          </p>
        </div>
      </div>
    );
  }
}
