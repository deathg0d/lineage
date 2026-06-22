import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert";
import { 
  track, 
  transform, 
  wrapFunction, 
  getLineage, 
  printLineage, 
  getErrorLineage,
  clearAll,
  evictBefore
} from "../src/index";

describe("data-lineage", () => {
  beforeEach(() => {
    // Ensure clean state before each test
    clearAll();
  });

  describe("Core Tracking & Transformations", () => {
    it("should track an object and generate a source node", () => {
      const data = track({ user: "alice" }, "auth_service");
      const lineage = getLineage(data);
      
      assert.ok(lineage, "Lineage should exist");
      assert.strictEqual(lineage.source, "auth_service");
      assert.strictEqual(lineage.parentIds.length, 0);
      assert.deepStrictEqual(lineage.valueSnapshot, { user: "alice" });
    });

    it("should link multiple tracked inputs to a transformed output", () => {
      const price = track({ value: 100 }, "cart");
      const tax = track({ rate: 0.2 }, "db:tax");
      
      const total = transform({ value: price.value * (1 + tax.rate) }, "calc_total", [price, tax]);
      const lineage = getLineage(total);

      assert.ok(lineage);
      assert.strictEqual(lineage.operation, "calc_total");
      assert.strictEqual(lineage.parentIds.length, 2);
      
      const priceLineage = getLineage(price);
      const taxLineage = getLineage(tax);
      assert.ok(lineage.parentIds.includes(priceLineage!.id));
      assert.ok(lineage.parentIds.includes(taxLineage!.id));
    });

    it("should generate a correct nested tree graph string", () => {
      const a = track({ val: 1 }, "source_A");
      const b = transform({ val: 2 }, "step_1", [a]);
      const c = transform({ val: 3 }, "step_2", [b]);

      const output = printLineage(c);
      
      assert.match(output, /↳ transform: step_2/);
      assert.match(output, /  ↳ transform: step_1/);
      assert.match(output, /    ↳ source: source_A/);
    });
  });

  describe("Snapshot Edge Cases & Truncation", () => {
    it("should preserve class names in snapshots", () => {
      class UserToken {
        constructor(public token: string) {}
      }
      const token = track(new UserToken("xyz"), "login");
      const lineage = getLineage(token);
      
      assert.deepStrictEqual(lineage?.valueSnapshot, { __type: "UserToken", token: "xyz" });
    });

    it("should truncate arrays larger than 5 elements", () => {
      const arr = track([1, 2, 3, 4, 5, 6, 7], "large_array");
      const lineage = getLineage(arr);
      
      const snapshot = lineage?.valueSnapshot as any[];
      assert.strictEqual(snapshot.length, 6);
      assert.strictEqual(snapshot[5], "...(2 more)");
    });

    it("should truncate objects with more than 10 keys", () => {
      const obj: Record<string, number> = {};
      for (let i = 0; i < 15; i++) obj[`k${i}`] = i;
      
      const trackedObj = track(obj, "large_object");
      const lineage = getLineage(trackedObj);
      
      const snapshot = lineage?.valueSnapshot as Record<string, any>;
      assert.strictEqual(Object.keys(snapshot).length, 11); // 10 keys + __truncated
      assert.strictEqual(snapshot.__truncated, "...(5 more properties)");
    });

    it("should handle circular references gracefully in printLineage", () => {
      const circular: any = { name: "circle" };
      circular.self = circular;
      
      const trackedCircle = track(circular, "circular_source");
      const output = printLineage(trackedCircle);
      
      assert.match(output, /"\[circular\]"/);
    });

    it("should track frozen objects without throwing (WeakMap support)", () => {
      const frozen = Object.freeze({ secure: true });
      const tracked = track(frozen, "frozen_source");
      
      assert.strictEqual(frozen, tracked, "Should be the exact same instance");
      assert.ok(getLineage(tracked), "Should have lineage attached via WeakMap");
    });
  });

  describe("wrapFunction & Error Handling", () => {
    it("should automatically track boundaries for a wrapped function", () => {
      const add = wrapFunction((a: { val: number }, b: { val: number }) => {
        return { val: a.val + b.val };
      }, "addition");

      const x = track({ val: 10 }, "input_x");
      const y = track({ val: 20 }, "input_y");
      
      const result = add(x, y);
      const lineage = getLineage(result);

      assert.strictEqual(lineage?.operation, "addition");
      assert.strictEqual(lineage?.parentIds.length, 2);
    });

    it("should attach lineage to thrown errors and extract them", () => {
      const crashFunc = wrapFunction((input: { trigger: boolean }) => {
        if (input.trigger) throw new Error("Intentional Crash");
        return { success: true };
      }, "dangerous_operation");

      const badInput = track({ trigger: true }, "user_input");

      try {
        crashFunc(badInput);
        assert.fail("Should have thrown");
      } catch (err) {
        const errorLineage = getErrorLineage(err);
        assert.ok(errorLineage, "Error lineage should be extractable");
        assert.strictEqual(errorLineage.operation, "dangerous_operation");
        
        const parentId = getLineage(badInput)?.id;
        assert.deepStrictEqual(errorLineage.parentIds, [parentId]);
      }
    });
  });

  describe("Store & Memory Management", () => {
    it("should completely wipe the store on clearAll()", () => {
      const a = track({ data: 1 }, "temp");
      assert.ok(getLineage(a));
      
      clearAll();
      assert.strictEqual(getLineage(a), undefined, "Lineage should be gone after clearAll");
    });

    it("should manually evict old nodes via evictBefore()", () => {
      const a = track({ data: 1 }, "old_node");
      const lineage = getLineage(a);
      assert.ok(lineage);
      
      // Override timestamp to simulate old node
      lineage.timestamp = Date.now() - 10000;
      
      evictBefore(Date.now() - 5000);
      
      assert.strictEqual(getLineage(a), undefined, "Old node should be evicted");
    });
  });
});
