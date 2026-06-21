import { LineageNode, NodeId, uuid } from "./types";
import { registerNode, lookupNode, registerTracked, trackingMap } from "./store";

function getNodeId(val: unknown): NodeId | undefined {
  if (val !== null && typeof val === "object") {
    return trackingMap.get(val);
  }
  return undefined;
}

function snapshot(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.length > 5
      ? [...value.slice(0, 5), `...(${value.length - 5} more)`]
      : value.slice();
  }
  try {
    const name = value.constructor?.name;
    const keys = Object.keys(value);
    const limited = keys.slice(0, 10);
    const result: Record<string, unknown> = {};
    for (const k of limited) result[k] = (value as any)[k];
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

export function track<T extends object>(value: T, sourceName: string): T {
  const node = makeNode(sourceName, [], undefined, snapshot(value));
  registerNode(node);
  registerTracked(value, node.id);
  return value;
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
  registerTracked(output, node.id);
  return output;
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
  const stack: Array<{ id: NodeId; phase: "enter" | "exit" }> = [
    { id: rootId, phase: "enter" }
  ];

  while (stack.length > 0) {
    const { id, phase } = stack.pop()!;
    if (phase === "exit") {
      sorted.push(allNodes.get(id)!);
      continue;
    }
    if (visited.has(id)) continue;
    visited.add(id);
    const node = allNodes.get(id);
    if (!node) continue;
    stack.push({ id, phase: "exit" });
    for (const parentId of node.parentIds) {
      if (!visited.has(parentId)) stack.push({ id: parentId, phase: "enter" });
    }
  }

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