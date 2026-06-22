import { describe, it, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import {
  track, transform, wrapFunction, getLineage, printLineage,
  getErrorLineage, clearAll, evictBefore
} from "../src/index";

describe("data-lineage", () => {
  beforeEach(() => {
    clearAll();
  });

  describe("1. track()", () => {
    it("Returns the exact same object reference (no cloning)", () => {
      const obj = { a: 1 };
      const tracked = track(obj, "source");
      assert.strictEqual(tracked, obj);
    });

    it("getLineage returns a node with correct source, empty parentIds, and a timestamp >= the time recorded just before the call", () => {
      const before = Date.now();
      const obj = track({}, "test_source");
      const lineage = getLineage(obj);
      
      assert.ok(lineage);
      assert.strictEqual(lineage.source, "test_source");
      assert.strictEqual(lineage.parentIds.length, 0);
      assert.ok(lineage.timestamp >= before);
    });

    it("Works on plain objects, class instances, arrays as objects, functions as objects", () => {
      class TestClass {}
      
      const plain = track({}, "plain");
      const instance = track(new TestClass(), "instance");
      const arr = track([], "array");
      const func = track(() => {}, "function");

      assert.ok(getLineage(plain));
      assert.ok(getLineage(instance));
      assert.ok(getLineage(arr));
      assert.ok(getLineage(func));
    });

    it("Calling track on a frozen object works without throwing and returns the same reference", () => {
      const frozen = Object.freeze({ a: 1 });
      const tracked = track(frozen, "frozen");
      assert.strictEqual(tracked, frozen);
      assert.ok(getLineage(tracked));
    });

    it("Snapshot is taken at call time: mutating the object after track does NOT change lineage.valueSnapshot", () => {
      const obj = { val: 1 };
      track(obj, "mutated");
      obj.val = 2;
      const snap = getLineage(obj)?.valueSnapshot as any;
      assert.strictEqual(snap.val, 1);
    });

    it("Object with exactly 10 keys: snapshot has no __truncated marker", () => {
      const obj: any = {};
      for (let i = 0; i < 10; i++) obj[`k${i}`] = i;
      track(obj, "10_keys");
      const snap = getLineage(obj)?.valueSnapshot as any;
      assert.strictEqual(snap.__truncated, undefined);
      assert.strictEqual(Object.keys(snap).length, 10);
    });

    it("Object with exactly 11 keys: snapshot has a __truncated marker", () => {
      const obj: any = {};
      for (let i = 0; i < 11; i++) obj[`k${i}`] = i;
      track(obj, "11_keys");
      const snap = getLineage(obj)?.valueSnapshot as any;
      assert.strictEqual(snap.__truncated, "...(1 more properties)");
      assert.strictEqual(Object.keys(snap).length, 11); // 10 data keys + __truncated
    });

    it("Array with exactly 5 elements: snapshot has no sentinel", () => {
      const arr = track([1, 2, 3, 4, 5], "5_arr");
      const snap = getLineage(arr)?.valueSnapshot as any[];
      assert.strictEqual(snap.length, 5);
      assert.strictEqual(snap[4], 5);
    });

    it("Array with exactly 6 elements: snapshot has a ...(1 more) sentinel", () => {
      const arr = track([1, 2, 3, 4, 5, 6], "6_arr");
      const snap = getLineage(arr)?.valueSnapshot as any[];
      assert.strictEqual(snap.length, 6);
      assert.strictEqual(snap[5], "...(1 more)");
    });

    it("Getter properties are recorded as '[getter]' in the snapshot, not invoked", () => {
      let invoked = false;
      const obj = { get myProp() { invoked = true; return 42; } };
      track(obj, "getter");
      const snap = getLineage(obj)?.valueSnapshot as any;
      assert.strictEqual(invoked, false);
      assert.strictEqual(snap.myProp, "[getter]");
    });

    it("Getter that throws is recorded as '[getter]' without propagating the error", () => {
      const obj = { get myProp() { throw new Error("Boom"); } };
      track(obj, "throwing_getter");
      const snap = getLineage(obj)?.valueSnapshot as any;
      assert.strictEqual(snap.myProp, "[getter]");
    });

    it("Redact hook: matched fields appear redacted in the snapshot", () => {
      const obj = track({ secret: "123", open: "456" }, "redact_test", {
        redact: (k, v) => k === "secret" ? "[REDACTED]" : v
      });
      const snap = getLineage(obj)?.valueSnapshot as any;
      assert.strictEqual(snap.secret, "[REDACTED]");
    });

    it("Redact hook: unmatched fields are unaffected", () => {
      const obj = track({ secret: "123", open: "456" }, "redact_test", {
        redact: (k, v) => k === "secret" ? "[REDACTED]" : v
      });
      const snap = getLineage(obj)?.valueSnapshot as any;
      assert.strictEqual(snap.open, "456");
    });

    it("Class instance: snapshot contains __type equal to the class name", () => {
      class MyEntity { a = 1; }
      const instance = track(new MyEntity(), "class_test");
      const snap = getLineage(instance)?.valueSnapshot as any;
      assert.strictEqual(snap.__type, "MyEntity");
      assert.strictEqual(snap.a, 1);
    });

    it("Plain object: snapshot contains no __type field", () => {
      const plain = track({ a: 1 }, "plain");
      const snap = getLineage(plain)?.valueSnapshot as any;
      assert.strictEqual(snap.__type, undefined);
    });

    it("TypeScript: passing a primitive causes a compile-time type error", () => {
      // @ts-expect-error
      assert.throws(() => track(42, "primitive"));
    });
  });

  describe("2. transform()", () => {
    it("Returns the exact same output object reference", () => {
      const out = { b: 2 };
      const trackedOut = transform(out, "op", []);
      assert.strictEqual(trackedOut, out);
    });

    it("Attaches lineage with correct operation name", () => {
      const out = transform({}, "my_op", []);
      assert.strictEqual(getLineage(out)?.operation, "my_op");
    });

    it("parentIds contains the NodeId of each tracked input", () => {
      const in1 = track({}, "in1");
      const out = transform({}, "op", [in1]);
      const parentId = getLineage(in1)?.id;
      assert.deepStrictEqual(getLineage(out)?.parentIds, [parentId]);
    });

    it("Untracked inputs are silently ignored — parentIds only contains ids of tracked ones", () => {
      const in1 = track({}, "in1");
      const out = transform({}, "op", [in1, { untracked: true }]);
      const parentId = getLineage(in1)?.id;
      assert.deepStrictEqual(getLineage(out)?.parentIds, [parentId]);
    });

    it("Multiple tracked inputs all appear in parentIds", () => {
      const in1 = track({}, "in1");
      const in2 = track({}, "in2");
      const out = transform({}, "op", [in1, in2]);
      const ids = [getLineage(in1)?.id, getLineage(in2)?.id];
      assert.deepStrictEqual(getLineage(out)?.parentIds, ids);
    });

    it("Re-transforming the same output object: calling transform again with the same output reference updates trackingMap; the new node lists the previous node's id in its parentIds; printLineage reflects the latest node", () => {
      const obj = track({}, "source");
      const id1 = getLineage(obj)?.id;
      
      transform(obj, "transform1", [obj]);
      const id2 = getLineage(obj)?.id;
      
      assert.notStrictEqual(id1, id2);
      assert.ok(getLineage(obj)?.parentIds.includes(id1!));
      
      const printOut = printLineage(obj);
      assert.match(printOut, /transform1/);
    });

    it("Snapshot behaviour: same truncation, getter, and redact rules as track", () => {
      let invoked = false;
      const obj = { get myProp() { invoked = true; return 42; }, secret: "yes" };
      transform(obj, "op", [], { redact: (k, v) => k === "secret" ? "no" : v });
      
      const snap = getLineage(obj)?.valueSnapshot as any;
      assert.strictEqual(invoked, false);
      assert.strictEqual(snap.myProp, "[getter]");
      assert.strictEqual(snap.secret, "no");
    });
  });

  describe("3. wrapFunction() — synchronous", () => {
    it("Returns a function", () => {
      const fn = wrapFunction(() => ({}));
      assert.strictEqual(typeof fn, "function");
    });

    it("Calling the wrapped function returns the correct computed result", () => {
      const fn = wrapFunction((a: { v: number }) => ({ result: a.v * 2 }));
      const out = fn({ v: 21 });
      assert.strictEqual(out.result, 42);
    });

    it("The result has lineage with the correct operation name", () => {
      const fn = wrapFunction(() => ({}), "custom_op");
      const out = fn();
      assert.strictEqual(getLineage(out)?.operation, "custom_op");
    });

    it("Operation name defaults to fn.name when not provided", () => {
      function myNamedFunction() { return {}; }
      const fn = wrapFunction(myNamedFunction);
      const out = fn();
      assert.strictEqual(getLineage(out)?.operation, "myNamedFunction");
    });

    it("Operation name defaults to 'anonymous' for an unnamed arrow function", () => {
      const fn = wrapFunction(() => ({}));
      const out = fn();
      assert.strictEqual(getLineage(out)?.operation, "anonymous");
    });

    it("All tracked arguments appear as parents in the result's lineage", () => {
      const fn = wrapFunction((a: any, b: any) => ({}));
      const in1 = track({}, "in1");
      const in2 = track({}, "in2");
      const out = fn(in1, in2);
      
      const parentIds = getLineage(out)?.parentIds;
      assert.ok(parentIds?.includes(getLineage(in1)!.id));
      assert.ok(parentIds?.includes(getLineage(in2)!.id));
    });

    it("Untracked arguments are silently ignored and do not appear in parentIds", () => {
      const fn = wrapFunction((a: any, b: any) => ({}));
      const in1 = track({}, "in1");
      const out = fn(in1, { untracked: true });
      assert.deepStrictEqual(getLineage(out)?.parentIds, [getLineage(in1)!.id]);
    });

    it("When the wrapped function throws an Error, the error has __lineageParents and __operation set", () => {
      const fn = wrapFunction((a: any) => { throw new Error("Sync Fail"); }, "fail_op");
      const in1 = track({}, "in1");
      try {
        fn(in1);
        assert.fail("Should throw");
      } catch (err) {
        assert.ok(err instanceof Error);
        assert.deepStrictEqual((err as any).__lineageParents, [getLineage(in1)!.id]);
        assert.strictEqual((err as any).__operation, "fail_op");
      }
    });

    it("getErrorLineage correctly extracts parentIds and operation from that error", () => {
      const fn = wrapFunction((a: any) => { throw new Error("Sync Fail"); }, "fail_op");
      const in1 = track({}, "in1");
      try {
        fn(in1);
      } catch (err) {
        const info = getErrorLineage(err);
        assert.deepStrictEqual(info, {
          parentIds: [getLineage(in1)!.id],
          operation: "fail_op"
        });
      }
    });

    it("When the wrapped function throws a non-Error value, it is rethrown without modification and getErrorLineage returns undefined", () => {
      const fn = wrapFunction(() => { throw "String Error"; });
      try {
        fn();
        assert.fail("Should throw");
      } catch (err) {
        assert.strictEqual(err, "String Error");
        assert.strictEqual(getErrorLineage(err), undefined);
      }
    });
  });

  describe("4. wrapFunction() — async", () => {
    it("Wrapping an async function returns a function that returns a Promise", () => {
      const fn = wrapFunction(async () => ({}));
      const res = fn();
      assert.ok(res instanceof Promise);
    });

    it("The resolved value has lineage attached with the correct operation name", async () => {
      const fn = wrapFunction(async () => ({}), "async_op");
      const out = await fn();
      assert.strictEqual(getLineage(out)?.operation, "async_op");
    });

    it("The resolved value's parentIds correctly reference all tracked inputs", async () => {
      const fn = wrapFunction(async (a: any) => ({}));
      const in1 = track({}, "in1");
      const out = await fn(in1);
      assert.deepStrictEqual(getLineage(out)?.parentIds, [getLineage(in1)!.id]);
    });

    it("When the async function rejects with an Error, the rejected error has __lineageParents and __operation set", async () => {
      const fn = wrapFunction(async (a: any) => { throw new Error("Async Fail"); }, "async_fail_op");
      const in1 = track({}, "in1");
      await assert.rejects(
        () => fn(in1),
        (err: any) => {
          assert.deepStrictEqual(err.__lineageParents, [getLineage(in1)!.id]);
          assert.strictEqual(err.__operation, "async_fail_op");
          return true;
        }
      );
    });

    it("When the async function rejects with a non-Error value, it rejects without modification", async () => {
      const fn = wrapFunction(async () => { throw "Async String Error"; });
      await assert.rejects(
        () => fn(),
        (err: any) => {
          assert.strictEqual(err, "Async String Error");
          return true;
        }
      );
    });

    it("getErrorLineage correctly extracts fields from an async rejection error", async () => {
      const fn = wrapFunction(async (a: any) => { throw new Error("Async Fail"); }, "async_fail_op");
      const in1 = track({}, "in1");
      try {
        await fn(in1);
      } catch (err) {
        assert.deepStrictEqual(getErrorLineage(err), {
          parentIds: [getLineage(in1)!.id],
          operation: "async_fail_op"
        });
      }
    });
  });

  describe("5. getLineage()", () => {
    it("Returns undefined for an untracked plain object", () => {
      assert.strictEqual(getLineage({}), undefined);
    });

    it("Returns undefined for a number primitive", () => {
      assert.strictEqual(getLineage(42), undefined);
    });

    it("Returns undefined for null", () => {
      assert.strictEqual(getLineage(null), undefined);
    });

    it("Returns undefined for undefined", () => {
      assert.strictEqual(getLineage(undefined), undefined);
    });

    it("Returns undefined for a string primitive", () => {
      assert.strictEqual(getLineage("str"), undefined);
    });

    it("Returns the correct LineageNode for a tracked value", () => {
      const obj = track({}, "src");
      const node = getLineage(obj);
      assert.ok(node);
      assert.strictEqual(node.source, "src");
      assert.ok(typeof node.id === "string");
      assert.ok(Array.isArray(node.parentIds));
    });
  });

  describe("6. printLineage()", () => {
    it("Returns 'No lineage found.' for an untracked plain object", () => {
      assert.strictEqual(printLineage({}), "No lineage found.");
    });

    it("Returns 'No lineage found.' for a primitive", () => {
      assert.strictEqual(printLineage(42), "No lineage found.");
    });

    it("Single source node: output contains the source name and a valid ISO timestamp", () => {
      const obj = track({}, "single_source");
      const out = printLineage(obj);
      assert.match(out, /source: single_source/);
      assert.match(out, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    });

    it("Linear chain A → B → C: C appears at depth 0, B at depth 1 (two spaces), A at depth 2 (four spaces)", () => {
      const a = track({}, "A");
      const b = transform({}, "B", [a]);
      const c = transform({}, "C", [b]);
      const out = printLineage(c);
      
      const lines = out.split("\n");
      assert.match(lines[0], /^↳ transform: C/);
      assert.match(lines[1], /^  ↳ transform: B/);
      assert.match(lines[2], /^    ↳ source: A/);
    });

    it("Every line starts with ↳", () => {
      const a = track({}, "A");
      const b = transform({}, "B", [a]);
      const out = printLineage(b);
      out.split("\n").forEach(line => {
        assert.ok(line.trimStart().startsWith("↳"));
      });
    });

    it("Diamond DAG (A → B, A → C, B+C → D): A's id appears exactly once as a full node; the second occurrence is a [shared node: ...] line", () => {
      const a = track({}, "A");
      const b = transform({}, "B", [a]);
      const c = transform({}, "C", [a]);
      const d = transform({}, "D", [b, c]);
      const out = printLineage(d);
      
      const aMatchCount = (out.match(/source: A/g) || []).length;
      assert.strictEqual(aMatchCount, 1);
      assert.match(out, /\[shared node: /);
    });

    it("After clearAll(), calling printLineage on a previously tracked value returns 'No lineage found.'", () => {
      const obj = track({}, "src");
      clearAll();
      assert.strictEqual(printLineage(obj), "No lineage found.");
    });

    it("A chain where the middle node has been evicted via evictBefore: the output contains [evicted: ...] for that node rather than crashing", async () => {
      const a = track({}, "A");
      
      await new Promise(r => setTimeout(r, 2));
      const afterA = Date.now();
      await new Promise(r => setTimeout(r, 2));

      // Evicts A safely
      evictBefore(afterA);
      
      // Pass the tracked (but evicted from nodeStore) object `a` to a new transform
      const b = transform({}, "B", [a]);
      
      const out = printLineage(b);
      assert.match(out, /\[evicted: /);
    });
  });

  describe("7. clearAll()", () => {
    it("After clearAll(), getLineage returns undefined for a previously tracked value", () => {
      const obj = track({}, "src");
      clearAll();
      assert.strictEqual(getLineage(obj), undefined);
    });

    it("After clearAll(), printLineage returns 'No lineage found.' for a previously tracked value", () => {
      const obj = track({}, "src");
      clearAll();
      assert.strictEqual(printLineage(obj), "No lineage found.");
    });

    it("After clearAll(), new track calls work correctly and produce fresh lineage", () => {
      clearAll();
      const obj = track({}, "src");
      assert.ok(getLineage(obj));
    });

    it("Calling clearAll() twice does not throw", () => {
      clearAll();
      clearAll();
      assert.ok(true);
    });
  });

  describe("8. evictBefore()", () => {
    it("A node tracked after the cutoff timestamp survives eviction", async () => {
      const cutoff = Date.now();
      await new Promise(r => setTimeout(r, 2));
      const obj = track({}, "survivor");
      evictBefore(cutoff);
      assert.ok(getLineage(obj));
    });

    it("A node tracked before the cutoff timestamp with refCount 0 is evicted", async () => {
      const obj = track({}, "evictee");
      await new Promise(r => setTimeout(r, 2));
      const after = Date.now();
      evictBefore(after);
      assert.strictEqual(getLineage(obj), undefined);
    });

    it("A node tracked before the cutoff but with a live child (refCount > 0) is NOT evicted", async () => {
      const obj1 = track({}, "parent");
      
      await new Promise(r => setTimeout(r, 2));
      const cutoff = Date.now();
      await new Promise(r => setTimeout(r, 2));
      
      const obj2 = transform({}, "child", [obj1]);
      
      evictBefore(cutoff);
      
      assert.ok(getLineage(obj1));
      assert.ok(getLineage(obj2));
    });

    it("After a leaf node is evicted, its parent is also evicted if it has no other children (cascade)", async () => {
      const obj1 = track({}, "parent");
      const obj2 = transform({}, "child", [obj1]);
      
      await new Promise(r => setTimeout(r, 2));
      const after = Date.now();
      
      evictBefore(after);
      
      assert.strictEqual(getLineage(obj1), undefined);
      assert.strictEqual(getLineage(obj2), undefined);
    });

    it("After a leaf node is evicted, a parent shared by another live child is NOT evicted", async () => {
      const parent = track({}, "parent");
      
      await new Promise(r => setTimeout(r, 2));
      const cutoffChild1 = Date.now();
      await new Promise(r => setTimeout(r, 2));
      
      const child1 = transform({}, "child1", [parent]);
      
      await new Promise(r => setTimeout(r, 2));
      const afterChild1 = Date.now();
      await new Promise(r => setTimeout(r, 2));
      
      const child2 = transform({}, "child2", [parent]);
      
      // We want to evict child1, but child1 was tracked BEFORE afterChild1.
      // But wait, evictBefore(timestamp) evicts anything BEFORE timestamp.
      // Since parent, child1, child2 were all tracked before `afterChild1`?
      // No, child2 was tracked AFTER afterChild1!
      // So evictBefore(afterChild1) will evict child1 (and parent if cascade, but child2 holds parent!)
      
      evictBefore(afterChild1);
      
      assert.strictEqual(getLineage(child1), undefined);
      assert.ok(getLineage(parent));
      assert.ok(getLineage(child2));
    });

    it("Calling evictBefore on an already-empty store does not throw", () => {
      evictBefore(Date.now() + 1000);
      assert.ok(true);
    });

    it("Calling evictBefore twice with the same timestamp does not throw", () => {
      const t = Date.now();
      evictBefore(t);
      evictBefore(t);
      assert.ok(true);
    });
  });

  describe("9. Redaction", () => {
    it("Redact hook is called for every non-getter own enumerable key", () => {
      const keysChecked: string[] = [];
      track({ a: 1, b: 2 }, "src", {
        redact: (k, v) => { keysChecked.push(k); return v; }
      });
      assert.deepStrictEqual(keysChecked.sort(), ["a", "b"]);
    });

    it("Redact hook returning undefined stores undefined in the snapshot", () => {
      const obj = track({ a: 1 }, "src", { redact: () => undefined });
      const snap = getLineage(obj)?.valueSnapshot as any;
      assert.strictEqual(snap.a, undefined);
    });

    it("Redact hook throwing does not propagate — the snapshot falls back to '[unsnapshotable]' for that object", () => {
      const obj = track({ a: 1 }, "src", {
        redact: () => { throw new Error("Redact fail"); }
      });
      const snap = getLineage(obj)?.valueSnapshot;
      assert.strictEqual(snap, "[unsnapshotable]");
    });

    it("Nested objects: redact only applies to top-level keys, not recursively to nested object values", () => {
      const keysChecked: string[] = [];
      track({ nested: { a: 1 } }, "src", {
        redact: (k, v) => { keysChecked.push(k); return v; }
      });
      assert.deepStrictEqual(keysChecked, ["nested"]);
    });
  });

  describe("10. DAG integrity", () => {
    it("Linear chain of 100 transforms: printLineage completes without throwing (no stack overflow)", () => {
      let current = track({}, "src");
      for (let i = 0; i < 100; i++) {
        current = transform({}, `step_${i}`, [current]);
      }
      const out = printLineage(current);
      assert.match(out, /transform: step_99/);
      assert.match(out, /source: src/);
    });

    it("Diamond DAG refCount cascade: after evicting both B and C (the children of A), A is also evicted because its refCount reaches 0", async () => {
      const a = track({}, "A");
      const b = transform({}, "B", [a]);
      const c = transform({}, "C", [a]);
      
      await new Promise(r => setTimeout(r, 2));
      const afterAll = Date.now();
      
      evictBefore(afterAll);
      assert.strictEqual(getLineage(a), undefined);
      assert.strictEqual(getLineage(b), undefined);
      assert.strictEqual(getLineage(c), undefined);
    });

    it("Re-tracking the same object: calling track then transform on the same object reference produces a chain where printLineage shows the transform node first and the source node as its parent", () => {
      const obj = track({}, "src");
      transform(obj, "reused_op", [obj]);
      const out = printLineage(obj);
      
      const lines = out.split("\n");
      assert.match(lines[0], /transform: reused_op/);
      assert.match(lines[1], /source: src/);
    });

    it("Two independent lineage chains do not interfere: evicting one does not affect getLineage on the other", async () => {
      const chain1 = track({}, "chain1");
      
      await new Promise(r => setTimeout(r, 2));
      const cutoff = Date.now();
      await new Promise(r => setTimeout(r, 2));
      
      const chain2 = track({}, "chain2");
      
      evictBefore(cutoff);
      assert.strictEqual(getLineage(chain1), undefined);
      assert.ok(getLineage(chain2));
    });
  });

  describe("11. Snapshot edge cases", () => {
    it("Object with a getter that throws: key is recorded as '[getter]', no error propagates", () => {
      const obj = { get boom() { throw new Error(); } };
      track(obj, "throwing_getter");
      const snap = getLineage(obj)?.valueSnapshot as any;
      assert.strictEqual(snap.boom, "[getter]");
    });

    it("Object with exactly 10 keys: no __truncated field in snapshot", () => {
      const obj: any = {};
      for (let i = 0; i < 10; i++) obj[`k${i}`] = i;
      track(obj, "10_keys");
      const snap = getLineage(obj)?.valueSnapshot as any;
      assert.strictEqual(snap.__truncated, undefined);
    });

    it("Object with exactly 11 keys: __truncated field present", () => {
      const obj: any = {};
      for (let i = 0; i < 11; i++) obj[`k${i}`] = i;
      track(obj, "11_keys");
      const snap = getLineage(obj)?.valueSnapshot as any;
      assert.ok(snap.__truncated);
    });

    it("Array with 5 elements: no sentinel in snapshot", () => {
      const arr = track([1, 2, 3, 4, 5], "5_arr");
      const snap = getLineage(arr)?.valueSnapshot as any[];
      assert.strictEqual(snap.length, 5);
      assert.ok(!snap.includes("...(1 more)"));
    });

    it("Array with 6 elements: sentinel '...(1 more)' present at index 5", () => {
      const arr = track([1, 2, 3, 4, 5, 6], "6_arr");
      const snap = getLineage(arr)?.valueSnapshot as any[];
      assert.strictEqual(snap[5], "...(1 more)");
    });

    it("Class instance snapshot: __type set to class name, own properties also present", () => {
      class Thing { data = 123; }
      const instance = track(new Thing(), "thing");
      const snap = getLineage(instance)?.valueSnapshot as any;
      assert.strictEqual(snap.__type, "Thing");
      assert.strictEqual(snap.data, 123);
    });

    it("Plain object snapshot: no __type field", () => {
      const plain = track({}, "plain");
      const snap = getLineage(plain)?.valueSnapshot as any;
      assert.strictEqual(snap.__type, undefined);
    });

    it("Circular reference object: printLineage output contains '[circular]' and does not throw", () => {
      const obj: any = { data: 1 };
      obj.self = obj;
      track(obj, "circular");
      const out = printLineage(obj);
      assert.match(out, /"\[circular\]"/);
    });

    it("null passed as a transform input: handled without throwing, not included in parentIds", () => {
      const obj = transform({}, "null_input", [null]);
      assert.deepStrictEqual(getLineage(obj)?.parentIds, []);
    });
  });
});