import { LINEAGE_SYMBOL, LineageNode, LineageRef, NodeId, uuid } from "./types";
import { registerNode, lookupNode, registerTracked } from "./store";

function getNodeId(val: unknown): NodeId | undefined {
  if (val !== null && typeof val === "object" && LINEAGE_SYMBOL in val) {
    return (val as LineageRef)[LINEAGE_SYMBOL];
  }
  return undefined;
}

function snapshot(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 5);
  try {
    const name = value.constructor?.name;
    const spread = { ...value };
    return name && name !== "Object" ? { __type: name, ...spread } : spread;
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

function attachRef<T extends object>(value: T, id: NodeId): T {
  Object.defineProperty(value, LINEAGE_SYMBOL, {
    value: id,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return value;
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

export function track<T extends object>(value: T, sourceName: string): T {
  const node = makeNode(sourceName, [], undefined, snapshot(value));
  registerNode(node);
  const tracked = attachRef(value, node.id);
  registerTracked(tracked, node.id);
  return tracked;
}

export function transform<T extends object>(
  output: T,
  operationName: string,
  inputs: unknown[]
): T {
  const parentIds = inputs
    .map(getNodeId)
    .filter((id): id is NodeId => id !== undefined);

  const node = makeNode("transform", parentIds, operationName, snapshot(output));
  registerNode(node);
  const tracked = attachRef(output, node.id);
  registerTracked(tracked, node.id);
  return tracked;
}

export function wrapFunction<Args extends unknown[], R extends object>(
  fn: (...args: Args) => R,
  operationName: string = fn.name || "anonymous"
): (...args: Args) => R {
  return (...args: Args): R => {
    try {
      const result = fn(...args);
      return transform(result, operationName, args);
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

  const allNodes = new Map<NodeId, LineageNode>();
  const queue: NodeId[] = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (allNodes.has(id)) continue;
    const node = lookupNode(id);
    if (!node) continue;
    allNodes.set(id, node);
    queue.push(...node.parentIds);
  }

  const sorted: LineageNode[] = [];
  const visited = new Set<NodeId>();

  function visit(id: NodeId) {
    if (visited.has(id)) return;
    visited.add(id);
    const node = allNodes.get(id);
    if (!node) return;
    for (const parentId of node.parentIds) visit(parentId);
    sorted.push(node);
  }
  visit(rootId);

  const lines: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const node = sorted[i];
    const step = `[${i + 1}/${sorted.length}]`;
    const label = node.operation
      ? `transform: ${node.operation}`
      : `source: ${node.source}`;
    const time = new Date(node.timestamp).toISOString();
    const snap =
      node.valueSnapshot !== undefined
        ? `  value: ${safeStringify(node.valueSnapshot)}`
        : "";
    lines.push(`${step} ${label} @ ${time}  (id: ${node.id})${snap}`);
  }

  return lines.join("\n");
}