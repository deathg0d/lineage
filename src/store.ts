import { LineageNode, NodeId } from "./types";

const nodeStore = new Map<NodeId, LineageNode>();
const refCount = new Map<NodeId, number>();
export const trackingMap = new WeakMap<object, NodeId>();

export function registerNode(node: LineageNode): void {
  nodeStore.set(node.id, node);
  refCount.set(node.id, 0);
  for (const parentId of node.parentIds) {
    refCount.set(parentId, (refCount.get(parentId) ?? 0) + 1);
  }
}

export function lookupNode(id: NodeId): LineageNode | undefined {
  return nodeStore.get(id);
}

function cascadeEvict(startId: NodeId): void {
  const queue: NodeId[] = [startId];
  while (queue.length > 0) {
    // Replaced shift() with pop() for O(1) array removal
    const id = queue.pop()!;
    if (!nodeStore.has(id)) continue;
    const count = refCount.get(id) ?? 0;
    if (count > 0) continue;
    
    const node = nodeStore.get(id);
    if (!node) continue;
    
    nodeStore.delete(id);
    refCount.delete(id);
    
    for (const parentId of node.parentIds) {
      if (!refCount.has(parentId)) continue;
      refCount.set(parentId, Math.max(0, (refCount.get(parentId) ?? 0) - 1));
      queue.push(parentId);
    }
  }
}

const registry = new FinalizationRegistry((id: NodeId) => {
  cascadeEvict(id);
});

export function registerTracked(value: object, id: NodeId): void {
  trackingMap.set(value, id);
  registry.register(value, id);
}

export function evictBefore(timestamp: number): void {
  const candidates = [...nodeStore.entries()]
    .filter(([id, node]) => 
      node.timestamp < timestamp && (refCount.get(id) ?? 0) === 0
    )
    .map(([id]) => id);
  
  for (const id of candidates) cascadeEvict(id);
}

export function clearAll(): void {
  nodeStore.clear();
  refCount.clear();
  // WeakMap doesn't need (or support) clear()
}