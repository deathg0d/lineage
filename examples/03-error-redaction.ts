import { track, wrapFunction, getErrorLineage, printLineage } from "../src/index";

/**
 * Scenario 3: Error Propagation & Sensitive Redaction
 * 
 * Demonstrates:
 * - How `data-lineage` safely extracts the history graph out of thrown Exceptions.
 * - Using the `redact` hook to scrub API keys from the generated snapshot.
 */

console.log("==================================================");
console.log("=  SCENARIO 3: ERROR PROPAGATION & REDACTION     =");
console.log("==================================================\n");

// 1. Data enters the system, but contains sensitive fields!
//    We apply a redact hook to scrub it from the debugging snapshots.
const userSession = track({ userId: "u_123", apiKey: "sk_live_12345", permission: "admin" }, "auth_service", {
  redact: (key, value) => key === "apiKey" ? "[REDACTED]" : value
});

// 2. An operation that might fail
const executeAdminAction = wrapFunction((session: any) => {
  throw new Error("Database timeout while executing action");
}, "Execute_Admin_Action");

// 3. Catching the error and extracting the context
console.log("Attempting dangerous action...");
try {
  executeAdminAction(userSession);
} catch (err) {
  console.log("💥 Exception Caught!");
  
  // Extract the exact inputs that caused this function to fail
  const context = getErrorLineage(err);
  console.log("Failed Operation:", context?.operation);
  
  if (context && context.parents.length > 0) {
    const offendingInputNode = context.parents[0];
    console.log("Offending Parent Node ID:", offendingInputNode.id);
    
    console.log("\nFull Causal Biography of the crash:");
    // We can print the exact node that caused the crash, and the apiKey is safely redacted!
    console.log(printLineage(userSession));
  }
}
