export interface LineageNode {
  id: string;
  source: string;
  operation?: string;
  parents: LineageNode[];
  timestamp: number;
  valueSnapshot?: unknown;
}

export function uuid(): string {
  return globalThis.crypto.randomUUID();
}

export interface TrackOptions {
  redact?: (key: string, value: unknown) => unknown;
  maxDepth?: number; // Maximum ancestor depth to retain
}

export interface LineageError extends Error {
  __lineageParents?: LineageNode[];
  __operation?: string;
}

export function getErrorLineage(err: unknown): { parents: LineageNode[], operation?: string } | undefined {
  if (err instanceof Error && "__lineageParents" in err) {
    return {
      parents: (err as LineageError).__lineageParents ?? [],
      operation: (err as LineageError).__operation
    };
  }
  return undefined;
}
