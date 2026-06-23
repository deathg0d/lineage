# data-lineage

**Data provenance as a low-overhead annotation layer.**

Every piece of data in your system came from somewhere. A user input, an API response, a database row, a calculation. By the time it causes a problem — a wrong invoice, a corrupted record, a bad ML prediction — the origin is completely untraceable. Standard stack traces tell you *where the code crashed*, but not *how the data became poisoned*.

`data-lineage` attaches an invisible provenance chain to any value: where it was born, every transformation it passed through, every function that touched it, expressed as a compact directed acyclic graph (DAG) that travels with the value through your system.

When something goes wrong, you call `printLineage(bad_value)` and get the complete, chronological causal biography of that specific piece of data.

---

## The Core Insight
**Data should know its own history the way Git commits know their parents.**

Unlike standard tracing or logging, `data-lineage` decouples the graph from the value. Values are tracked invisibly and immutably via a global `WeakMap`. The actual lineage graph lives in a centralized, O(1) ref-counted `GraphStore`, making it entirely memory-safe for massive ETL, ML, and financial calculation pipelines.

## Features
* 🛡️ **Memory Safe:** Native V8 Garbage Collection. By utilizing direct node references and `WeakMap`, history graphs are automatically pruned from memory the exact millisecond your data goes out of scope. No custom GC loops, no memory leaks.
* 📸 **Value Snapshots:** Captures a shallow snapshot of the data at every transformation step so you know exactly *what* went wrong, not just *where*.
* 🔀 **Depth-First Traversal:** Produces human-readable, chronologically sorted histories (Output → Parent → Grandparent). Shared ancestors are cleanly deduplicated to prevent infinite loops.
* 🔒 **Safe API:** Explicitly prevents "primitive boxing" bugs that plague other libraries. Cross-platform ready (Browser, Deno, Node) with `globalThis.crypto`.
* 🛑 **Error Propagation:** Safely extracts lineage out of thrown exceptions.

---

## Installation

```bash
npm install data-lineage
```

[![npm version](https://badge.fury.io/js/data-lineage.svg)](https://badge.fury.io/js/data-lineage)

---

## Usage

### 1. Tracking Data Boundaries

Whenever data enters your system, wrap it in `track()`. 

```typescript
import { track, printLineage } from "data-lineage";

// 1. Data is born
const invoice = track({ amount: 42.50, currency: "EUR" }, "postgres:invoices");

console.log(printLineage(invoice));
// ↳ source: postgres:invoices @ 2026-06-21T...  value: {"amount":42.5,"currency":"EUR"} (id: f4k2...)
```

### 2. Recording Transformations

Whenever data changes shape or calculates a new result, use `transform()`.

```typescript
import { transform } from "data-lineage";

const tax = transform({ amount: invoice.amount * 0.2 }, "tax_calc", [invoice]);

console.log(printLineage(tax));
// ↳ transform: tax_calc @ 2026-06-21T...  value: {"amount":8.5} (id: a1b2...)
//   ↳ source: postgres:invoices @ 2026-06-21T...  value: {"amount":42.5,"currency":"EUR"} (id: f4k2...)
```

### 3. Wrapping Functions

`wrapFunction` is a convenience tool to reduce boilerplate. In a real codebase, you often have dozens of existing functions that process data. Instead of manually calling `transform()` after every function call, you can wrap them once.

**The Scenario: An E-Commerce Checkout**
Imagine calculating regional taxes. Without `wrapFunction`, you'd manually link inputs to outputs:

```typescript
// The manual, tedious way
const rawResult = calculateTax(incomingCart, userRegion);
const finalCart = transform(rawResult, "Calculate Tax", [incomingCart, userRegion]);
```

Here is the clean way using `wrapFunction`:

```typescript
import { track, wrapFunction, printLineage } from "data-lineage";

// 1. Your existing function
function calculateTax(cart: { total: number }, region: { code: string }) {
  const rate = region.code === "NY" ? 0.08 : 0.00;
  return { total: cart.total * (1 + rate) };
}

// 2. Create a "Tracked" version of the function ONCE
const trackedCalculateTax = wrapFunction(calculateTax, "Calculate Regional Tax");

const incomingCart = track({ total: 100.00 }, "checkout_api");
const userRegion = track({ code: "NY" }, "database:users");

// 3. Call the wrapped function normally!
// It automatically records that `finalCart` came from `incomingCart` and `userRegion`.
const finalCart = trackedCalculateTax(incomingCart, userRegion);

console.log(printLineage(finalCart));
```

**The Output:**
```text
↳ transform: Calculate Regional Tax @ 2026-06-21...  value: {"total":108} (id: 5e6f...)
  ↳ source: checkout_api @ 2026-06-21...  value: {"total":100} (id: 1a2b...)
  ↳ source: database:users @ 2026-06-21...  value: {"code":"NY"} (id: 3c4d...)
```

**Three things to know about `wrapFunction`:**
1. **It ignores untracked inputs safely:** If you pass an untracked normal JS object as an argument, the wrapper simply ignores it and only links tracked parents to the result.
2. **It handles third-party libraries:** You can wrap functions you didn't write. (e.g., `const trackedMerge = wrapFunction(lodash.merge, "Lodash Merge");`)
3. **The Boundary Limitation:** It only traces the **boundary** of the function (what went in and what came out). It *does not* track internal local variables inside the function body.

### 4. Extracting Lineage from Errors

If a function throws an exception, the lineage context is automatically attached to the Error object so your global error handler can log it.

```typescript
import { getErrorLineage } from "data-lineage";

try {
  dangerousTransform(invoice);
} catch (err) {
  const context = getErrorLineage(err);
  console.log("Failed operation:", context?.operation);
  console.log("Input nodes:", context?.parents.map(p => p.id));
}
```

---

## Important Architectural Caveats & "Gotchas"

To achieve performance and correctness in the JavaScript runtime, this library requires developers to understand a few systemic rules.

### 1. The "Honest" Primitive Rule
JavaScript operators (`+`, `-`, `===`) immediately strip metadata from primitive values. If we allowed you to track a raw `number`, we would have to box it into a `new Number()`, which breaks `===` equality, JSON serialization, and causes silent pipeline drops.

Therefore, **primitives cannot be directly tracked**. You must wrap them in an object at your system boundary:
```typescript
// ❌ Type Error
const price = track(42.50, "api"); 

// ✅ Correct
const price = track({ value: 42.50 }, "api");
```

### 2. Zero-Mutation via `WeakMap`
`data-lineage` uses a global `WeakMap` to store object IDs invisibly. This means **your objects are never mutated**.
You can safely pass `Object.freeze(myConfig)` into `track()` and it will work natively without throwing errors or requiring cloned copies.

```typescript
const frozen = Object.freeze({ key: "abc" });
track(frozen, "env"); // Works perfectly, zero mutation.
```

### 3. `wrapFunction` Traces Boundaries, Not Internals
`wrapFunction` captures the inputs going into your function, and the output coming out. It **does not** trace intermediate local variables calculated inside the function body. If you need deep internal tracing, you must call `transform()` manually within the function.

### 4. Primitive Extraction
When a primitive property is extracted from a tracked object (e.g. `const price = invoice.amount;`), that primitive loses its identity and carries no lineage. Subsequent operations on that primitive are untracked. If you need to trace primitive values through complex calculations, wrap them back into objects: `const trackedPrice = { value: invoice.amount };`.

### 5. Sensitive Data Redaction
Because `track()` and `transform()` snapshot the object's properties at tracking time, sensitive information (passwords, tokens) can inadvertently leak into the lineage graph. You can provide an optional `redact` hook to scrub sensitive data:

```typescript
const user = track({ id: 1, secret: "XYZ" }, "db", {
  redact: (key, value) => key === "secret" ? "[REDACTED]" : value
});
```
### 6. Snapshot Constraints & Memory Limits
To guarantee that the history graph doesn't create memory leaks or bloat the V8 heap, the `snapshot` function enforces strict serialization rules at capture time:
* **Nested References:** Nested objects, arrays, and functions are replaced with safe string sentinels (`"[Object]"`, `"[Array]"`, `"[Function]"`). This breaks strong references and allows the `FinalizationRegistry` to safely garbage collect tracked objects.
* **Large Strings:** Strings exceeding 200 characters are truncated (appended with `...[truncated]`).
* **Iterables & Dates:** `Map` and `Set` instances are serialized to lightweight metadata (e.g., `{ __type: "Map", size: 5 }`), and `Date` objects are serialized to ISO strings.

### 7. Memory Management (Native V8 GC)
This library previously relied on a custom Garbage Collector (`FinalizationRegistry`) to delete orphaned history graphs. 

With the latest architectural rewrite, `data-lineage` now stores parent dependencies directly by reference rather than globally, meaning **the V8 engine handles 100% of the garbage collection natively at C++ speeds**. 

When a tracked object goes out of scope, the `WeakMap` drops the link, and V8 automatically tears down any upstream lineage history that isn't shared by another active object (Diamond DAG reference counting is handled natively). There are zero memory leaks, and no teardown configuration is required.

---

## License
MIT
