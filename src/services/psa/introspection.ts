/**
 * Small GraphQL introspection helpers.
 *
 * Swoop talks to SuperOps, whose schema is not published in a form we can pin
 * against, and whose field names have already burned this project once (the git
 * history is a string of "field not in schema" fixes). Rather than guess, we
 * ask the live endpoint what it actually exposes and build queries from that.
 */

export interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}

export interface FieldInfo {
  name: string;
  type: TypeRef;
  args?: ArgInfo[];
}

export interface ArgInfo {
  name: string;
  type: TypeRef;
}

export const TYPE_REF_FRAGMENT = `
  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType { kind name }
            }
          }
        }
      }
    }
  }
`;

/** Unwraps NON_NULL / LIST wrappers down to the named type. */
export function namedType(ref: TypeRef | null | undefined): { kind: string; name: string | null } {
  let current: TypeRef | null | undefined = ref;
  while (current && !current.name && current.ofType) current = current.ofType;
  return { kind: current?.kind ?? 'UNKNOWN', name: current?.name ?? null };
}

/** True when the type ref is a list at any wrapper level. */
export function isListType(ref: TypeRef | null | undefined): boolean {
  let current: TypeRef | null | undefined = ref;
  while (current) {
    if (current.kind === 'LIST') return true;
    current = current.ofType;
  }
  return false;
}

/** A named type is a leaf if it needs no sub-selection. */
export function isLeafType(ref: TypeRef | null | undefined): boolean {
  const { kind } = namedType(ref);
  return kind === 'SCALAR' || kind === 'ENUM';
}

/**
 * Picks the first candidate present in `available`, comparing
 * case-insensitively so `ticketId` still matches a schema spelling it `ticketID`.
 * Returns the name as the schema spells it.
 */
export function pickField(available: readonly string[], candidates: readonly string[]): string | null {
  const byLower = new Map(available.map((name) => [name.toLowerCase(), name]));
  for (const candidate of candidates) {
    const hit = byLower.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** Every candidate that exists, in candidate order. */
export function pickFields(available: readonly string[], candidates: readonly string[]): string[] {
  const byLower = new Map(available.map((name) => [name.toLowerCase(), name]));
  const out: string[] = [];
  for (const candidate of candidates) {
    const hit = byLower.get(candidate.toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}
