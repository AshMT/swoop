import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  errorMessage,
  getAction,
  reclassifyAction,
  reviewAction,
  type ActionLog,
  type Client,
  type ReviewVerdict,
} from '../api';
import { formatDuration, formatRelative, humanClassification, parseEntities, hasEntities } from '../lib/format';
import { Badge, ClassificationBadge, ConfidenceBar, Spinner, useToast } from './ui';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ExternalIcon, RefreshIcon, XIcon } from './Icons';

interface Props {
  log: ActionLog;
  client?: Client;
  classifications: string[];
  confidenceThreshold: number | null;
  selected: boolean;
  onSelect: (id: string, selected: boolean) => void;
  /** Expansion is parent-controlled so a keyboard shortcut can drive it. */
  expanded: boolean;
  onToggleExpanded: (id: string) => void;
  /** The row the keyboard is on. */
  focused: boolean;
  onFocus: (id: string) => void;
}

export default function ActionRow({
  log,
  client,
  classifications,
  confidenceThreshold,
  selected,
  onSelect,
  expanded,
  onToggleExpanded,
  focused,
  onFocus,
}: Props) {
  const [correctLabel, setCorrectLabel] = useState(log.reviewCorrectClassification ?? '');
  const [reviewNote, setReviewNote] = useState(log.reviewNote ?? '');
  const [ticketUrl, setTicketUrl] = useState<string | null>(log.ticketUrl ?? null);
  const queryClient = useQueryClient();
  const toast = useToast();

  const entities = parseEntities(log.entities);
  const failed = log.status === 'ai_failed';

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['actions'] });
    void queryClient.invalidateQueries({ queryKey: ['stats'] });
    void queryClient.invalidateQueries({ queryKey: ['calibration'] });
  };

  const review = useMutation({
    mutationFn: (verdict: ReviewVerdict | null) =>
      reviewAction(log.id, {
        verdict,
        correctClassification: verdict === 'incorrect' ? correctLabel || null : null,
        note: verdict ? reviewNote || null : null,
      }),
    onSuccess: (_res, verdict) => {
      invalidate();
      toast.success(verdict === null ? 'Review cleared' : `Marked ${verdict}`);
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not save the review')),
  });

  const reclassify = useMutation({
    mutationFn: () => reclassifyAction(log.id, false),
    onSuccess: () => {
      invalidate();
      toast.success('Re-ran the classifier — the new result is at the top of the log');
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not re-run the classifier')),
  });

  /**
   * Saves a detail of an existing review. Kept separate from the verdict
   * mutation so a dropdown or a blurred textarea persists immediately, and
   * separate from a bare fetch so a failure is actually reported.
   */
  const saveReview = (patch: { correctClassification?: string | null; note?: string | null }) => {
    if (!log.reviewVerdict) return;
    reviewAction(log.id, {
      verdict: log.reviewVerdict,
      correctClassification: patch.correctClassification ?? correctLabel ?? null,
      note: patch.note ?? reviewNote ?? null,
    })
      .then(invalidate)
      .catch((err) => toast.error(errorMessage(err, 'Could not save the review')));
  };

  /** The deep link is built server-side, so fetch it when the row opens. */
  const expand = async () => {
    const next = !expanded;
    onFocus(log.id);
    onToggleExpanded(log.id);
    if (next && !ticketUrl) {
      try {
        const res = await getAction(log.id);
        setTicketUrl(res.data.ticketUrl ?? null);
      } catch {
        /* the link is a convenience; the row is still readable without it */
      }
    }
  };

  return (
    <>
      <tr
        data-action-row={log.id}
        onMouseDown={() => onFocus(log.id)}
        className={`border-b border-slate-100 dark:border-slate-800 ${
          focused
            ? 'bg-swoop-50 ring-1 ring-inset ring-swoop-400 dark:bg-swoop-950/40 dark:ring-swoop-700'
            : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
        }`}
      >
        <td className="px-3 py-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect(log.id, e.target.checked)}
            aria-label={`Select ticket ${log.ticketDisplayId || log.ticketId}`}
            className="h-4 w-4 rounded border-slate-300 text-swoop-600 dark:border-slate-600 dark:bg-slate-800"
          />
        </td>

        <td className="td cursor-pointer font-mono text-xs" onClick={expand}>
          {log.ticketDisplayId || log.ticketId}
        </td>

        <td className="td max-w-xs cursor-pointer" onClick={expand}>
          <div className="truncate font-medium text-slate-900 dark:text-slate-100">
            {log.ticketSubject || '(no subject)'}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {log.sensitivity === 'high' && <Badge tone="danger">High sensitivity</Badge>}
            {log.status === 'note_failed' && (
              <Badge tone="warning">
                {log.noteAttempts && log.noteAttempts >= 5 ? 'Note failed' : 'Note retrying'}
              </Badge>
            )}
            {failed && <Badge tone="danger">AI failed</Badge>}
            {log.requesterEmail && (
              <span className="truncate text-xs text-slate-400 dark:text-slate-500">{log.requesterEmail}</span>
            )}
          </div>
        </td>

        <td className="td cursor-pointer whitespace-nowrap" onClick={expand}>
          {client?.name ?? <span className="text-slate-400">—</span>}
        </td>

        <td className="td cursor-pointer whitespace-nowrap" onClick={expand}>
          {failed ? (
            <span className="text-xs text-slate-400">—</span>
          ) : (
            <ClassificationBadge value={log.classification} label={humanClassification(log.classification)} />
          )}
        </td>

        <td className="td cursor-pointer whitespace-nowrap" onClick={expand}>
          <ConfidenceBar value={log.confidence} threshold={confidenceThreshold} />
        </td>

        {/* The review controls are the point of the whole read-only phase, so
            they sit inline rather than behind the expander. */}
        <td className="td whitespace-nowrap">
          {failed ? (
            <span className="text-xs text-slate-400">n/a</span>
          ) : (
            <div className="flex items-center gap-1">
              <button
                onClick={() => review.mutate(log.reviewVerdict === 'correct' ? null : 'correct')}
                disabled={review.isPending}
                title={log.reviewVerdict === 'correct' ? 'Clear this review' : 'The AI got this right'}
                aria-label="Mark correct"
                className={`rounded p-1.5 transition-colors ${
                  log.reviewVerdict === 'correct'
                    ? 'bg-emerald-600 text-white'
                    : 'text-slate-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950'
                }`}
              >
                <CheckIcon className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => {
                  if (log.reviewVerdict === 'incorrect') {
                    review.mutate(null);
                  } else {
                    // Opening the row is how the correct label gets chosen.
                    if (!expanded) onToggleExpanded(log.id);
                    review.mutate('incorrect');
                  }
                }}
                disabled={review.isPending}
                title={log.reviewVerdict === 'incorrect' ? 'Clear this review' : 'The AI got this wrong'}
                aria-label="Mark incorrect"
                className={`rounded p-1.5 transition-colors ${
                  log.reviewVerdict === 'incorrect'
                    ? 'bg-red-600 text-white'
                    : 'text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950'
                }`}
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
              {review.isPending && <Spinner className="h-3 w-3 text-slate-400" />}
            </div>
          )}
        </td>

        <td className="td cursor-pointer whitespace-nowrap text-xs text-slate-400" onClick={expand}>
          {formatRelative(log.createdAt)}
        </td>

        <td className="td w-8">
          <button onClick={expand} aria-label={expanded ? 'Collapse' : 'Expand'} className="text-slate-400">
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </button>
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-slate-100 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/60">
          <td colSpan={9} className="px-4 py-4">
            <div className="grid gap-5 lg:grid-cols-3">
              {/* ─── What the AI concluded ─────────────────────────────────── */}
              <div className="space-y-4">
                <Section title="AI reasoning">
                  <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                    {log.reasoning || '—'}
                  </p>
                  {log.followUpQuestion && (
                    <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
                      <span className="font-medium text-amber-700 dark:text-amber-400">
                        Suggested question:{' '}
                      </span>
                      {log.followUpQuestion}
                    </p>
                  )}
                  {log.escalationReason && (
                    <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
                      <span className="font-medium text-red-700 dark:text-red-400">Escalated because: </span>
                      {log.escalationReason}
                    </p>
                  )}
                </Section>

                <Section title="Extracted details">
                  {hasEntities(entities) ? (
                    <dl className="space-y-1 text-xs">
                      {entities.target_user_email && (
                        <Row label="User" value={entities.target_user_email} mono />
                      )}
                      {entities.target_user_display_name && (
                        <Row label="Name" value={entities.target_user_display_name} />
                      )}
                      {entities.group_name && <Row label="Group" value={entities.group_name} />}
                      {entities.license_sku && <Row label="Licence" value={entities.license_sku} />}
                    </dl>
                  ) : (
                    <p className="text-xs text-slate-400 dark:text-slate-500">Nothing extracted.</p>
                  )}
                </Section>

                <Section title="Run details">
                  <dl className="space-y-1 text-xs">
                    <Row label="Model" value={log.aiModel ?? '—'} mono />
                    <Row label="Latency" value={formatDuration(log.aiLatencyMs)} />
                    <Row
                      label="Note posted"
                      value={
                        log.notePosted
                          ? log.noteAttempts && log.noteAttempts > 1
                            ? `Yes, on attempt ${log.noteAttempts}`
                            : 'Yes'
                          : log.noteAttempts && log.noteAttempts > 1
                            ? `No — ${log.noteAttempts} attempts`
                            : 'No'
                      }
                    />
                    <Row label="Ticket ID" value={log.ticketId} mono />
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {ticketUrl && (
                      <a href={ticketUrl} target="_blank" rel="noreferrer" className="btn-secondary !py-1 text-xs">
                        <ExternalIcon className="h-3.5 w-3.5" />
                        Open in SuperOps
                      </a>
                    )}
                    <button
                      onClick={() => reclassify.mutate()}
                      disabled={reclassify.isPending}
                      className="btn-secondary !py-1 text-xs"
                      title="Run the current prompt against this ticket again"
                    >
                      {reclassify.isPending ? <Spinner className="h-3.5 w-3.5" /> : <RefreshIcon className="h-3.5 w-3.5" />}
                      Re-run classifier
                    </button>
                  </div>
                </Section>
              </div>

              {/* ─── The note that was posted ──────────────────────────────── */}
              <div className="space-y-4">
                <Section title="Internal note">
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 font-mono text-[11px] leading-relaxed text-slate-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400">
                    {log.proposedPsaNote || '—'}
                  </pre>
                </Section>

                {(log.errorMessage || log.noteError) && (
                  <Section title="Error">
                    <p className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-300">
                      {log.errorMessage || log.noteError}
                    </p>
                  </Section>
                )}
              </div>

              {/* ─── The technician's verdict ──────────────────────────────── */}
              <div>
                <Section title="Your review">
                  {failed ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      This entry records an AI failure rather than a classification, so there is nothing to
                      review. It is excluded from the accuracy figures.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex gap-2">
                        <button
                          onClick={() => review.mutate('correct')}
                          disabled={review.isPending}
                          className={`btn flex-1 !py-1.5 text-xs ${
                            log.reviewVerdict === 'correct'
                              ? 'bg-emerald-600 text-white'
                              : 'border border-slate-300 bg-white text-slate-700 hover:bg-emerald-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
                          }`}
                        >
                          <CheckIcon className="h-3.5 w-3.5" /> Correct
                        </button>
                        <button
                          onClick={() => review.mutate('incorrect')}
                          disabled={review.isPending}
                          className={`btn flex-1 !py-1.5 text-xs ${
                            log.reviewVerdict === 'incorrect'
                              ? 'bg-red-600 text-white'
                              : 'border border-slate-300 bg-white text-slate-700 hover:bg-red-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
                          }`}
                        >
                          <XIcon className="h-3.5 w-3.5" /> Incorrect
                        </button>
                      </div>

                      {log.reviewVerdict === 'incorrect' && (
                        <div>
                          <label className="label text-xs">What should it have been?</label>
                          <select
                            value={correctLabel}
                            onChange={(e) => {
                              const next = e.target.value;
                              setCorrectLabel(next);
                              // Persisting on change keeps the confusion table
                              // accurate without a separate save step.
                              saveReview({ correctClassification: next || null });
                            }}
                            className="input text-xs"
                          >
                            <option value="">Not sure</option>
                            {classifications.map((id) => (
                              <option key={id} value={id}>
                                {humanClassification(id)}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      {log.reviewVerdict && (
                        <div>
                          <label className="label text-xs">Note (optional)</label>
                          <textarea
                            value={reviewNote}
                            onChange={(e) => setReviewNote(e.target.value)}
                            onBlur={() => {
                              if ((log.reviewNote ?? '') === reviewNote) return;
                              saveReview({ note: reviewNote || null });
                            }}
                            rows={3}
                            placeholder="Why was this wrong? What did the model miss?"
                            className="input text-xs"
                          />
                        </div>
                      )}

                      {log.reviewedBy && (
                        <p className="text-xs text-slate-400 dark:text-slate-500">
                          Reviewed by {log.reviewedBy} {formatRelative(log.reviewedAt)}
                        </p>
                      )}

                      {log.reviewVerdict && (
                        <button
                          onClick={() => review.mutate(null)}
                          className="text-xs text-slate-500 underline hover:text-slate-700 dark:text-slate-400"
                        >
                          Clear this review
                        </button>
                      )}
                    </div>
                  )}
                </Section>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {title}
      </h4>
      {children}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className={`min-w-0 break-words text-slate-700 dark:text-slate-300 ${mono ? 'font-mono' : ''}`}>
        {value}
      </dd>
    </div>
  );
}
