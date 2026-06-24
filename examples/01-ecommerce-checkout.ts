import { track, transform, printLineage } from "../src/index";

/**
 * Scenario 1: E-Commerce Checkout
 * 
 * Demonstrates:
 * - Tracking raw data from multiple sources (API, Database)
 * - Using `transform()` to link data across multiple calculation steps
 * - Diamond DAG generation (User Profile is used in both tax and discount steps)
 */

console.log("==================================================");
console.log("=       SCENARIO 1: E-COMMERCE CHECKOUT          =");
console.log("==================================================\n");

// 1. Raw inputs enter the system from various boundaries
const incomingCart = track({ items: 2, subtotal: 100 }, "api:incoming_cart");
const userProfile = track({ region: "NY", loyaltyStatus: "GOLD" }, "db:user_profile");

// 2. We perform business logic transformations
const cartWithTax = transform(
  { ...incomingCart, tax: 8 }, 
  "calculate_ny_tax", 
  [incomingCart, userProfile]
);

const finalOrder = transform(
  { ...cartWithTax, discount: 10, finalTotal: 98 }, 
  "apply_loyalty_discount", 
  [cartWithTax, userProfile]
);

// 3. When something goes wrong (or for auditing), print the causal biography
console.log("Final Order Lineage:");
console.log(printLineage(finalOrder));
