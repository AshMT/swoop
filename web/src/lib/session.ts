import { useQuery } from '@tanstack/react-query';
import { getMe, getVocabulary, type Role, type Vocabulary } from '../api';

const ORDER: Role[] = ['viewer', 'reviewer', 'approver', 'admin'];

/** Mirrors the server's role check; the server is still the one that enforces it. */
export function roleAtLeast(role: string | null | undefined, minimum: Role): boolean {
  const index = ORDER.indexOf(role as Role);
  return index >= 0 && index >= ORDER.indexOf(minimum);
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => getMe().then((r) => r.data),
    staleTime: 60_000,
  });
}

/** True when the signed-in user has at least `minimum`. False while loading. */
export function useCan(minimum: Role): boolean {
  const { data } = useMe();
  return roleAtLeast(data?.role, minimum);
}

export function useVocabulary() {
  return useQuery({
    queryKey: ['vocabulary'],
    queryFn: () => getVocabulary().then((r) => r.data),
    staleTime: Infinity,
  });
}

export function categoryLabel(vocabulary: Vocabulary | undefined, id: string | null | undefined): string {
  if (!id) return 'Uncategorised';
  return vocabulary?.categories.find((c) => c.id === id)?.label ?? id.replace(/_/g, ' ');
}

export function actionLabel(vocabulary: Vocabulary | undefined, id: string | null | undefined): string {
  if (!id) return 'Unclassified';
  if (id === 'ESCALATE') return 'For a technician';
  return vocabulary?.actions.find((a) => a.id === id)?.label ?? id.replace(/_/g, ' ');
}
