/**
 * Lexical similarity between tickets: TF-IDF weighted cosine.
 *
 * Deliberately not embeddings. It needs no second model, no vector store and
 * no network call, runs in a millisecond over a few hundred tickets, and is
 * explainable — two tickets match because they share these words. For short
 * support tickets from the same handful of clients, that finds duplicates and
 * outage bursts well; it is the right first tool, and the interface leaves
 * room to swap in embeddings later.
 */

const STOPWORDS = new Set(
  (
    'a about above after again all am an and any are as at be because been before being below between both but by ' +
    'can could did do does doing down during each few for from further had has have having he her here hers him his ' +
    'how i if in into is it its itself just me more most my no nor not now of off on once only or other our ours out ' +
    'over own same she should so some such than that the their theirs them then there these they this those through ' +
    'to too under until up very was we were what when where which while who whom why will with would you your yours ' +
    'hi hello hey thanks thank cheers regards kind please pls team help need needs get got also im ive dont cant ' +
    'can\'t don\'t i\'m i\'ve it\'s let know let\'s asap urgent today morning afternoon sent iphone re fw fwd'
  ).split(/\s+/),
);

/** Lower-cases, strips punctuation, drops stopwords and very short tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9@.\-\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

/** A light suffix strip so "printer"/"printers"/"printing" land together. */
function stem(token: string): string {
  if (token.includes('@') || token.includes('.')) return token;
  return token.replace(/(ing|ers|er|ed|es|s)$/, '') || token;
}

export interface SimilarityDoc {
  id: string;
  subject: string;
  body?: string | null;
}

/** The subject says what the ticket is; weight it above a long body. */
function docTerms(doc: Pick<SimilarityDoc, 'subject' | 'body'>): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (tokens: string[], weight: number) => {
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + weight);
  };
  add(tokenize(doc.subject ?? ''), 2);
  add(tokenize((doc.body ?? '').slice(0, 1500)), 1);
  return counts;
}

export interface ScoredDoc<T> {
  doc: T;
  score: number;
  /** The highest-weighted shared terms, for "why did these match". */
  sharedTerms: string[];
}

/**
 * Scores every candidate against the target. IDF comes from the candidate set
 * plus the target, so words common across this tenant's tickets ("email",
 * "user") count for little and the distinctive ones carry the match.
 */
export function rankSimilar<T extends SimilarityDoc>(
  target: Pick<SimilarityDoc, 'subject' | 'body'>,
  candidates: readonly T[],
  options: { minScore?: number; limit?: number } = {},
): Array<ScoredDoc<T>> {
  if (candidates.length === 0) return [];
  const targetTerms = docTerms(target);
  if (targetTerms.size === 0) return [];

  const candidateTerms = candidates.map((c) => docTerms(c));
  const documentFrequency = new Map<string, number>();
  for (const terms of [targetTerms, ...candidateTerms]) {
    for (const term of terms.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const n = candidates.length + 1;
  const idf = (term: string) => Math.log(1 + n / (documentFrequency.get(term) ?? 1));

  const weigh = (terms: Map<string, number>) => {
    const vector = new Map<string, number>();
    let norm = 0;
    for (const [term, count] of terms) {
      const w = (1 + Math.log(count)) * idf(term);
      vector.set(term, w);
      norm += w * w;
    }
    return { vector, norm: Math.sqrt(norm) };
  };

  const t = weigh(targetTerms);
  const minScore = options.minScore ?? 0;
  const results: Array<ScoredDoc<T>> = [];

  candidateTerms.forEach((terms, index) => {
    const c = weigh(terms);
    if (c.norm === 0 || t.norm === 0) return;
    let dot = 0;
    const shared: Array<[string, number]> = [];
    for (const [term, weight] of t.vector) {
      const other = c.vector.get(term);
      if (other) {
        dot += weight * other;
        shared.push([term, weight * other]);
      }
    }
    const score = dot / (t.norm * c.norm);
    if (score < minScore || score === 0) return;
    shared.sort((a, b) => b[1] - a[1]);
    results.push({ doc: candidates[index], score, sharedTerms: shared.slice(0, 5).map(([term]) => term) });
  });

  results.sort((a, b) => b.score - a.score);
  return options.limit ? results.slice(0, options.limit) : results;
}
