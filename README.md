# data-lineage

**Data provenance as a zero-cost annotation layer.**

Every piece of data in your system came from somewhere. A user input, an API response, a database row, a calculation. By the time it causes a problem — a wrong invoice, a corrupted record, a bad ML prediction — the origin is completely untraceable. Standard stack traces tell you *where the code crashed*, but not *how the data became poisoned*.

`data-lineage` attaches an invisible provenance chain to any value: where it was born, every transformation it passed through, every function that touched it, expressed as a compact directed acyclic graph (DAG) that travels with the value through your system.

When something goes wrong, you call `printLineage(bad_value)` and get the complete, chronological causal biography of that specific piece of data.

---

## The Core Insight
**Data should know its own history the way Git commits know their parents.**

Unlike standard tracing or logging, `data-lineage` decouples the graph from the value. Values simply carry an invisible, non-enumerable `Symbol` representing an ID. The actual lineage graph lives in a centralized, O(1) ref-counted `GraphStore`, making it entirely memory-safe for massive ETL, ML, and financial calculation pipelines.

## Features
* 🛡️ **Memory Safe:** Powered by JS `FinalizationRegistry`. When your data is garbage collected, its lineage is iteratively, cleanly pruned from memory. No memory leaks, no recursive inline data structures.
* 📸 **Value Snapshots:** Captures a shallow snapshot of the data at every transformation step so you know exactly *what* went wrong, not just *where*.
* 🔀 **Topological Traversal:** Produces human-readable, chronologically sorted histories (Source → Step 1 → Step 2 → Crash).
* 🔒 **Safe API:** Explicitly prevents "primitive boxing" bugs that plague other libraries. Cross-platform ready (Browser, Deno, Node) with `globalThis.crypto`.
* 🛑 **Error Propagation:** Safely extracts lineage out of thrown exceptions.

---

## Installation

```bash
npm install data-lineage
```

---

## Usage

### 1. Tracking Data Boundaries

Whenever data enters your system, wrap it in `track()`. 

```typescript
import { track, printLineage } from "data-lineage";

// 1. Data is born
const invoice = track({ amount: 42.50, currency: "EUR" }, "postgres:invoices");

console.log(printLineage(invoice));
// [1/1] source: postgres:invoices @ 2026-06-21T...  value: {"amount":42.5,"currency":"EUR"} (id: f4k2...)
```

### 2. Recording Transformations

Whenever data changes shape or calculates a new result, use `transform()`.

```typescript
import { transform } from "data-lineage";

const tax = transform({ amount: invoice.amount * 0.2 }, "tax_calc", [invoice]);

console.log(printLineage(tax));
// [1/2] source: postgres:invoices @ 2026-06-21T...  value: {"amount":42.5,"currency":"EUR"}
// [2/2] transform: tax_calc @ 2026-06-21T...  value: {"amount":8.5}
```

### 3. Wrapping Functions

You can wrap existing I/O boundaries so they automatically attach lineage to their returns.

```typescript
import { wrapFunction } from "data-lineage";

const applyDiscount = wrapFunction((inv: { amount: number }) => {
  return { amount: inv.amount - 5.0 };
}, "apply_discount");

const discounted = applyDiscount(tax);
```

### 4. Extracting Lineage from Errors

If a function throws an exception, the lineage context is automatically attached to the Error object so your global error handler can log it.

```typescript
import { getErrorLineage } from "data-lineage";

try {
  dangerousTransform(invoice);
} catch (err) {
  const context = getErrorLineage(err);
  console.log("Failed operation:", context?.operation);
  console.log("Input nodes:", context?.parentIds);
}
```

---

## Important Architectural Caveats & "Gotchas"

To achieve performance and correctness in the JavaScript runtime, this library requires developers to understand a few systemic rules.

### 1. The "Honest" Primitive Rule (`T extends object`)
JavaScript operators (`+`, `-`, `===`) immediately strip metadata from primitive values. If we allowed you to track a raw `number`, we would have to box it into a `new Number()`, which breaks `===` equality, JSON serialization, and causes silent pipeline drops.

Therefore, **primitives cannot be directly tracked**. You must wrap them in an object at your system boundary:
```typescript
// ❌ Type Error
const price = track(42.50, "api"); 

// ✅ Correct
const price = track({ value: 42.50 }, "api");
```

### 2. Frozen Objects
Because lineage tracking uses `Object.defineProperty` to attach a hidden `Symbol`, passing a frozen object (`Object.freeze()`) to `track()` cannot mutate it in place. 
Instead, `track` safely returns a **cloned copy** with an identical prototype chain. Make sure to use the returned value:
```typescript
const frozen = Object.freeze({ key: "abc" });
const tracked = track(frozen, "env");

console.log(frozen === tracked); // FALSE! Use `tracked` going forward.
```

### 3. `wrapFunction` Traces Boundaries, Not Internals
`wrapFunction` captures the inputs going into your function, and the output coming out. It **does not** trace intermediate local variables calculated inside the function body. If you need deep internal tracing, you must call `transform()` manually within the function.

### 4. Memory Management (GC & Teardown)
This library uses `FinalizationRegistry` to automatically garbage collect DAG nodes when your JS objects are destroyed. 

However, `FinalizationRegistry` is not guaranteed to fire instantly, or at all in short-lived processes (like CLI scripts or Unit Tests). To prevent memory leaks between test runs, explicitly clear the store:

```typescript
import { clearAll, evictBefore } from "data-lineage";

afterEach(() => {
  clearAll(); // Nukes the store between tests
});

// For edge environments where FinalizationRegistry is unreliable:
setInterval(() => {
  evictBefore(Date.now() - 3600000); // Manually evict nodes older than 1 hour
}, 60000);
```

---

## License
MIT
