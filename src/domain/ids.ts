/**
 * Identifier generation.
 *
 * IDs are prefixed (matching the spec's `sub_…` / `evt_…` examples) and carry a
 * random UUID. Prefixes make IDs self-describing in logs and prevent an ID of
 * one kind being mistaken for another.
 */

import { randomUUID } from 'node:crypto';

export type IdKind = 'subscription' | 'event' | 'delivery';

const PREFIXES: Record<IdKind, string> = {
  subscription: 'sub',
  event: 'evt',
  delivery: 'del',
};

export function newId(kind: IdKind): string {
  return `${PREFIXES[kind]}_${randomUUID()}`;
}

/** An {@link IdGenerator} allows tests to supply deterministic identifiers. */
export interface IdGenerator {
  next(kind: IdKind): string;
}

export const randomIdGenerator: IdGenerator = {
  next: newId,
};
