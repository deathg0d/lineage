export type NodeId = string;

export interface LineageNode {
  id: NodeId;
  source: string;
  operation?: string;
  parentIds: NodeId[];
  timestamp: number;
  valueSnapshot?: unknown;
}

export function uuid(): NodeId {
  return globalThis.crypto.randomUUID();
}

export interface LineageError extends Error {
  __lineageParents?: NodeId[];
  __operation?: string;
}

export function getErrorLineage(err: unknown): { parentIds: NodeId[], operation?: string } | undefined {
  if (err instanceof Error && "__lineageParents" in err) {
    return {
      parentIds: (err as LineageError).__lineageParents ?? [],
      operation: (err as LineageError).__operation
    };
  }
  return undefined;
}