# Data-Lineage Examples

This directory contains executable, real-world scenarios demonstrating how `data-lineage` can be used to debug and trace data in complex Node.js/TypeScript applications.

## How to Run the Examples

The examples are written in TypeScript. The easiest way to run them directly from your terminal is using [`tsx`](https://github.com/privatenumber/tsx) (a TypeScript executor for Node.js).

From the root of the test project, run:

```bash
npx tsx examples/01-ecommerce-checkout.ts
npx tsx examples/02-ml-pipeline.ts
npx tsx examples/03-error-redaction.ts
npx tsx examples/04-frozen-config.ts
```

*(Note: If you have compiled the library, you can also run them using `node dist/examples/...`)*

---

## How to Read the Output

When you run `printLineage(value)`, the library outputs a **Depth-First Traversal** of the object's history. It reads backwards in time from top to bottom (like a stack trace), showing exactly how a value was derived.

### Example Output
```text
↳ transform: apply_loyalty_discount @ 2026-06-24T18:15:47.564Z  (id: e12b...)  value: {"items":2,"tax":8,"discount":10}
  ↳ transform: calculate_ny_tax @ 2026-06-24T18:15:47.564Z  (id: 4f87...)  value: {"items":2,"tax":8}
    ↳ source: api:incoming_cart @ 2026-06-24T18:15:47.564Z  (id: bff3...)  value: {"items":2}
    ↳ source: db:user_profile @ 2026-06-24T18:15:47.564Z  (id: 3de8...)  value: {"region":"NY","loyaltyStatus":"GOLD"}
  ↳ [shared node: 3de8...]
```

### Decoding the format:
1. **Indentation:** The indentation represents causality. The top line is the final output. The lines indented beneath it are the inputs that were used to calculate it.
2. **`source` vs `transform`:** 
   * `source:` denotes where data originally entered the system (e.g., from a database or API).
   * `transform:` denotes a mathematical operation or function that changed the data.
3. **`value: {...}`:** A shallow snapshot of exactly what the data looked like *at that exact moment in time*.
4. **`[shared node: ID]`:** Data pipelines are often DAGs (Directed Acyclic Graphs), meaning the exact same piece of data might be used in multiple steps. To keep the logs clean and prevent infinite recursion loops, if `data-lineage` sees a parent it has already printed out fully higher up in the tree, it simply prints `[shared node]` with its ID. In the example above, the `user_profile` was used for both the tax calculation and the loyalty discount!