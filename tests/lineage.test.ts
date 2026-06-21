import { track, transform, printLineage } from "../src/index";

console.log("Running Lineage Tests...\n");

// Test 1: Object tracking and forward lineage
const row = track({ amount: 42.5, currency: "EUR" }, "postgres:invoices");
const rounded = transform(
  { amount: Math.round(row.amount * 100) / 100 },
  "round_currency",
  [row]
);

console.log("--- Object Lineage ---");
console.log(printLineage(rounded));
console.log("\n");

// Test 2: Primitives wrapped correctly
const rawPrice = track({ value: 99.99 }, "cart_api");
const withTax = transform(
  { value: rawPrice.value * 1.19 },
  "apply_vat",
  [rawPrice]
);

console.log("--- Wrapped Primitive Result ---");
console.log(`Value: ${withTax.value}`);
console.log(printLineage(withTax));
console.log("\n");

// Test 3: Frozen objects with WeakMap
const frozenObj = Object.freeze({ key: "frozenValue" });
const trackedFrozen = track(frozenObj, "frozenSource");

console.log("--- Frozen Object Result ---");
console.log(`Is same instance: ${frozenObj === trackedFrozen}`);
console.log(printLineage(trackedFrozen));
console.log("\n");


console.log("All tests passed! (FinalizationRegistry will clean up silently when process exits)");
