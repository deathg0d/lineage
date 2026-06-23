import { LineageNode, uuid, TrackOptions } from "./types";

interface InternalNode extends LineageNode {
  ownDepth: number;
}

const trackingMap = new WeakMap<object, InternalNode>();

function getNode(val: unknown): InternalNode | undefined {
  if (val !== null && (typeof val === "object" || typeof val === "function")) {
    return trackingMap.get(val as object);
  }
  return undefined;
}

function snapshot(value: unknown, redact?: (key: string, value: unknown) => unknown): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;

  const makeSafe = (rawVal: unknown) => {
    if (rawVal !== null && (typeof rawVal === "object" || typeof rawVal === "function")) {
      if (Array.isArray(rawVal)) return "[Array]";
      if (typeof rawVal === "function") return "[Function]";
      if (rawVal instanceof Map) return { __type: "Map", size: rawVal.size };
      if (rawVal instanceof Set) return { __type: "Set", size: rawVal.size };
      if (rawVal instanceof Date) return { __type: "Date", value: rawVal.toISOString() };
      return "[Object]";
    }
    if (typeof rawVal === "string" && rawVal.length > 200) {
      return rawVal.slice(0, 200) + "...[truncated]";
    }
    return rawVal;
  };

  if (Array.isArray(value)) {
    const safe = value.slice(0, 5).map(makeSafe);
    return value.length > 5
      ? [...safe, `...(${value.length - 5} more)`]
      : safe;
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
        const rawVal = (value as any)[k];
        if (redact) {
          const redacted = redact(k, rawVal);
          // If the developer's redact hook returns an object, we safely stringify it 
          // to break references without losing their custom redaction data.
          result[k] = (redacted !== null && (typeof redacted === "object" || typeof redacted === "function")) 
            ? safeStringify(redacted) 
            : redacted;
        } else {
          result[k] = makeSafe(rawVal);
        }
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
  parents: InternalNode[],
  operation?: string,
  valueSnapshot?: unknown,
  ownDepth: number = 0
): InternalNode {
  return {
    id: uuid(),
    source,
    operation,
    parents,
    timestamp: Date.now(),
    valueSnapshot,
    ownDepth,
  };
}

/**
 * Mark an object value as the origin of a lineage chain.
 * Note: The value is snapshotted at tracking time. Subsequent mutations 
 * to the object will not be reflected in the lineage snapshot.
 */
export function track<T extends object>(value: T, sourceName: string, options?: TrackOptions): T {
  const node = makeNode(sourceName, [], undefined, snapshot(value, options?.redact), 0);
  trackingMap.set(value, node);
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
  const parents = inputs
    .map(getNode)
    .filter((n): n is InternalNode => n !== undefined);

  // Each parent independently evaluated — no cross-contamination
  const maxDepth = options?.maxDepth ?? 50;
  const ownDepth = parents.length > 0
    ? Math.max(...parents.map(p => p.ownDepth)) + 1
    : 0;
  const severedParents = parents.filter(p => p.ownDepth < maxDepth);

  const node = makeNode("transform", severedParents, operationName, snapshot(output, options?.redact), ownDepth);
  trackingMap.set(output, node);
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
  return function(this: any, ...args: Args): R | Promise<R> {
    try {
      const result = fn.apply(this, args);
      if (result instanceof Promise) {
        return result.then(
          resolved => transform(resolved, operationName, args, options),
          err => {
            if (err instanceof Error && !("__lineageParents" in err)) {
              const parents = args.map(getNode).filter((n): n is InternalNode => n !== undefined);
              (err as any).__lineageParents = parents;
              (err as any).__operation = operationName;
            }
            throw err;
          }
        );
      }
      return transform(result, operationName, args, options);
    } catch (err) {
      if (err instanceof Error && !("__lineageParents" in err)) {
        const parents = args.map(getNode).filter((n): n is InternalNode => n !== undefined);
        (err as any).__lineageParents = parents;
        (err as any).__operation = operationName;
      }
      throw err;
    }
  };
}

export function getLineage(val: unknown): LineageNode | undefined {
  return getNode(val);
}

export function printLineage(val: unknown): string {
  const rootNode = getNode(val);
  if (!rootNode) return "No lineage found.";

  const lines: string[] = [];
  const visited = new Set<string>();
  const stack: Array<{ node: LineageNode; depth: number }> = [{ node: rootNode, depth: 0 }];

  // Start building lines for topological traversal
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    const indent = "  ".repeat(depth);

    if (visited.has(node.id)) {
      lines.push(`${indent}↳ [shared node: ${node.id}]`);
      continue;
    }
    visited.add(node.id);

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
    for (let i = node.parents.length - 1; i >= 0; i--) {
      stack.push({ node: node.parents[i], depth: depth + 1 });
    }
  }

  return lines.join("\n");
}
