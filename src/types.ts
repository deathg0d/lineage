export const LINEAGE_SYMBOL = Symbol("lineage");

export type NodeId = string;

export interface LineageNode {
  id: NodeId;
  source: string;
  operation?: string;
  parentIds: NodeId[];
  timestamp: number;
  valueSnapshot?: unknown;
}

export interface LineageRef {
  [LINEAGE_SYMBOL]: NodeId;
}

export type Tracked<T> = T extends object ? T & LineageRef : never;

export function uuid(): NodeId {
  return globalThis.crypto.randomUUID();
}

export interface LineageError extends Error {
  __lineageParents?: NodeId[];
  __operation?: string;
}

export function getErrorLineage(err: unknown): { parentIds: NodeId[], operation: string } | undefined {
  if (err instanceof Error && "__lineageParents" in err) {
    return {
      parentIds: (err as LineageError).__lineageParents ?? [],
      operation: (err as LineageError).__operation ?? "unknown"
    };
  }
  return undefined;
}