import { LineageNode, NodeId, uuid, TrackOptions } from "./types";
import { registerNode, lookupNode, registerTracked, getNodeId } from "./store";

function snapshot(value: unknown, redact?: (key: string, value: unknown) => unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.length > 5
      ? [...value.slice(0, 5), `...(${value.length - 5} more)`]
      : value.slice();
  }
  try {
    const name = value.constructor?.name;
    // Note: Object.keys only returns own enumerable properties. Properties 
    // defined via getters on the class prototype will not be snapshotted.
    const keys = Object.keys(value);
    const limited = keys.slice(0, 10);
    const result: Record<string, unknown> = {};
    for (const k of limited) {
      const desc = Object.getOwnPropertyDescriptor(value, k);
      if (desc && desc.get) {
        result[k] = "[getter]";
      } else {
        const val = (value as any)[k];
        result[k] = redact ? redact(k, val) : val;
      }
    }
    if (keys.length > 10) result["__truncated"] = `...(${keys.length - 10} more properties)`;
    return name && name !== "Object" ? { __type: name, ...result } : result;
  } catch {
    return "[unsnapshotable]";
  }
}

function safeStringify(val: unknown): string {
  try {
    return JSON.stringify(val);
  } catch {
    return '"[circular]"';
  }
}

function makeNode(
  source: string,
  parentIds: NodeId[],
  operation?: string,
  valueSnapshot?: unknown
): LineageNode {
  return {
    id: uuid(),
    source,
    operation,
    parentIds,
    timestamp: Date.now(),
    valueSnapshot,
  };
}

/**
 * Mark an object value as the origin of a lineage chain.
 * Note: The value is snapshotted at tracking time. Subsequent mutations 
 * to the object will not be reflected in the lineage snapshot.
 */
export function track<T extends object>(value: T, sourceName: string, options?: TrackOptions): T {
  const node = makeNode(sourceName, [], undefined, snapshot(value, options?.redact));
  registerNode(node);
  registerTracked(value, node.id);
  return value;
}

/**
 * Record a transformation from inputs to an output.
 * Note: The output is snapshotted at tracking time.
 */
export function transform<T extends object>(
  output: T,
  operationName: string,
  inputs: unknown[],
  options?: TrackOptions
): T {
  const parentIds = inputs
    .map(getNodeId)
    .filter((id): id is NodeId => id !== undefined);

  const node = makeNode("transform", parentIds, operationName, snapshot(output, options?.redact));
  registerNode(node);
  registerTracked(output, node.id);
  return output;
}

export function wrapFunction<Args extends unknown[], R extends object>(
  fn: (...args: Args) => R,
  operationName?: string,
  options?: TrackOptions
): (...args: Args) => R;
export function wrapFunction<Args extends unknown[], R extends object>(
  fn: (...args: Args) => Promise<R>,
  operationName?: string,
  options?: TrackOptions
): (...args: Args) => Promise<R>;
export function wrapFunction<Args extends unknown[], R extends object>(
  fn: (...args: Args) => R | Promise<R>,
  operationName: string = fn.name || "anonymous",
  options?: TrackOptions
): (...args: Args) => R | Promise<R> {
  return (...args: Args): R | Promise<R> => {
    try {
      const result = fn(...args);
      if (result instanceof Promise) {
        return result.then(
          resolved => transform(resolved, operationName, args, options),
          err => {
            if (err instanceof Error) {
              const parentIds = args.map(getNodeId).filter((id): id is NodeId => id !== undefined);
              (err as any).__lineageParents = parentIds;
              (err as any).__operation = operationName;
            }
            throw err;
          }
        );
      }
      return transform(result, operationName, args, options);
    } catch (err) {
      if (err instanceof Error) {
        const parentIds = args.map(getNodeId).filter((id): id is NodeId => id !== undefined);
        (err as any).__lineageParents = parentIds;
        (err as any).__operation = operationName;
      }
      throw err;
    }
  };
}

export function getLineage(val: unknown): LineageNode | undefined {
  const id = getNodeId(val);
  return id ? lookupNode(id) : undefined;
}

export function printLineage(val: unknown): string {
  const rootId = getNodeId(val);
  if (!rootId) return "No lineage found.";

  const lines: string[] = [];
  const visited = new Set<NodeId>();
  const stack: Array<{ id: NodeId; depth: number }> = [{ id: rootId, depth: 0 }];

  // Start building lines for topological traversal
  while (stack.length > 0) {
    const { id, depth } = stack.pop()!;
    const indent = "  ".repeat(depth);

    if (visited.has(id)) {
      lines.push(`${indent}↳ [shared node: ${id}]`);
      continue;
    }
    visited.add(id);

    const node = lookupNode(id);
    if (!node) {
      lines.push(`${indent}↳ [evicted: ${id}]`);
      continue;
    }

    const label = node.operation
      ? `transform: ${node.operation}`
      : `source: ${node.source}`;
    
    // Optional: Format timestamp nicely, or remove it if you prefer ultra-compact
    const time = new Date(node.timestamp).toISOString();
    const snap =
      node.valueSnapshot !== undefined
        ? `  value: ${safeStringify(node.valueSnapshot)}`
        : "";
    
    lines.push(`${indent}↳ ${label} @ ${time}  (id: ${node.id})${snap}`);

    // Push parents in reverse order so they pop out in their original order
    for (let i = node.parentIds.length - 1; i >= 0; i--) {
      stack.push({ id: node.parentIds[i], depth: depth + 1 });
    }
  }

  return lines.join("\n");
}