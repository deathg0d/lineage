import { track, wrapFunction, printLineage } from "../src/index";

/**
 * Scenario 2: Machine Learning Pipeline
 * 
 * Demonstrates:
 * - Using `wrapFunction` to automatically intercept and track data through
 *   an existing normalization algorithm.
 * - Processing raw event data into model-ready features.
 */

console.log("==================================================");
console.log("=         SCENARIO 2: ML DATA PIPELINE           =");
console.log("==================================================\n");

// 1. You have existing logic that you want to track without manually
//    calling `transform` all over the place.
function normalizeAlgorithm(data: { age: number, income: number }) {
  return {
    normalized_age: data.age / 100,
    normalized_income: data.income / 150000
  };
}

// 2. Wrap the function once
const normalizeFeatures = wrapFunction(normalizeAlgorithm, "ML_Feature_Normalization");

// 3. Raw data enters the pipeline
const rawEvent = track({ age: 35, income: 85000 }, "kafka:user_events");

// 4. Pass the tracked data through the wrapped function
const mlFeatures = normalizeFeatures(rawEvent);

console.log("ML Features Prepared:");
console.log(printLineage(mlFeatures));
