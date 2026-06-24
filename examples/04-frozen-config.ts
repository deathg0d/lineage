import { track, transform, printLineage } from "../src/index";

/**
 * Scenario 4: Tracing Frozen Configurations
 * 
 * Demonstrates:
 * - Tracking an `Object.freeze()` configuration object.
 * - Proving the `WeakMap` zero-mutation architecture allows tracking 
 *   without throwing native JS immutable/readonly errors.
 */

console.log("==================================================");
console.log("=   SCENARIO 4: TRACING FROZEN CONFIGURATIONS    =");
console.log("==================================================\n");

// 1. A perfectly frozen, immutable configuration object
const baseConfig = Object.freeze({
  retries: 3,
  timeoutMs: 5000
});

// 2. We track it directly! Because of the WeakMap architecture,
//    data-lineage never mutates the developer's object.
const trackedConfig = track(baseConfig, "env_vars");

// 3. Transform it downstream
const dbConnection = transform(
  { status: "connected", timeoutUsed: trackedConfig.timeoutMs }, 
  "initialize_db", 
  [trackedConfig]
);

console.log("Connection initialized:");
console.log(printLineage(dbConnection));

// Proof that it wasn't mutated
console.log("Did the library mutate the frozen config?", Object.isFrozen(trackedConfig) ? "No, still frozen!" : "Yes :(");
