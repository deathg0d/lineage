import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  track, transform, wrapFunction, getLineage, printLineage,
  getErrorLineage
} from "../src/index";

describe("data-lineage", () => {
  describe("1. track()", () => {
    it("Returns the exact same object reference (no cloning)", () => {
      const obj = { a: 1 };
      const tracked = track(obj, "source");
      assert.strictEqual(tracked, obj);
    });

    it("getLineage returns a node with correct source, empty parents, and a timestamp >= the time recorded just before the call", () => {
      const before = Date.now();
      const obj = track({}, "test_source");
      const lineage = getLineage(obj);
      
      assert.ok(lineage);
      assert.strictEqual(lineage.source, "test_source");
      assert.strictEqual(lineage.parents.length, 0);
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
      assert.strictEqual(Object.keys(snap).length, 11);
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

    it("parents contains the LineageNode of each tracked input", () => {
      const in1 = track({}, "in1");
      const out = transform({}, "op", [in1]);
      const parentId = getLineage(in1)?.id;
      assert.deepStrictEqual(getLineage(out)?.parents.map(p => p.id), [parentId]);
    });

    it("Untracked inputs are silently ignored — parents only contains nodes of tracked ones", () => {
      const in1 = track({}, "in1");
      const out = transform({}, "op", [in1, { untracked: true }]);
      const parentId = getLineage(in1)?.id;
      assert.deepStrictEqual(getLineage(out)?.parents.map(p => p.id), [parentId]);
    });

    it("Multiple tracked inputs all appear in parents", () => {
      const in1 = track({}, "in1");
      const in2 = track({}, "in2");
      const out = transform({}, "op", [in1, in2]);
      const ids = [getLineage(in1)?.id, getLineage(in2)?.id];
      assert.deepStrictEqual(getLineage(out)?.parents.map(p => p.id), ids);
    });

    it("Re-transforming the same output object updates trackingMap; the new node lists the previous node's id in its parents; printLineage reflects the latest node", () => {
      const obj = track({}, "source");
      const id1 = getLineage(obj)?.id;
      
      transform(obj, "transform1", [obj]);
      const id2 = getLineage(obj)?.id;
      
      assert.notStrictEqual(id1, id2);
      assert.ok(getLineage(obj)?.parents.map(p => p.id).includes(id1!));
      
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
      
      const parentIds = getLineage(out)?.parents.map(p => p.id);
      assert.ok(parentIds?.includes(getLineage(in1)!.id));
      assert.ok(parentIds?.includes(getLineage(in2)!.id));
    });

    it("Untracked arguments are silently ignored and do not appear in parents", () => {
      const fn = wrapFunction((a: any, b: any) => ({}));
      const in1 = track({}, "in1");
      const out = fn(in1, { untracked: true });
      assert.deepStrictEqual(getLineage(out)?.parents.map(p => p.id), [getLineage(in1)!.id]);
    });

    it("When the wrapped function throws an Error, the error has __lineageParents and __operation set", () => {
      const fn = wrapFunction((a: any) => { throw new Error("Sync Fail"); }, "fail_op");
      const in1 = track({}, "in1");
      try {
        fn(in1);
        assert.fail("Should throw");
      } catch (err) {
        assert.ok(err instanceof Error);
        assert.deepStrictEqual((err as any).__lineageParents.map((p: any) => p.id), [getLineage(in1)!.id]);
        assert.strictEqual((err as any).__operation, "fail_op");
      }
    });

    it("getErrorLineage correctly extracts parents and operation from that error", () => {
      const fn = wrapFunction((a: any) => { throw new Error("Sync Fail"); }, "fail_op");
      const in1 = track({}, "in1");
      try {
        fn(in1);
      } catch (err) {
        const info = getErrorLineage(err);
        assert.deepStrictEqual(info?.parents.map(p => p.id), [getLineage(in1)!.id]);
        assert.strictEqual(info?.operation, "fail_op");
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

    it("Preserves `this` context when wrapping a class method", () => {
      class Cart {
        multiplier = 2;
        calc(val: number) { return { total: val * this.multiplier }; }
      }
      const cart = new Cart();
      cart.calc = wrapFunction(cart.calc, "calc_method");
      const out = cart.calc(10);
      assert.strictEqual(out.total, 20);
      assert.strictEqual(getLineage(out)?.operation, "calc_method");
    });

    it("Does not overwrite deeper errors in nested wrappers", () => {
      const inner = wrapFunction(() => { throw new Error("Boom"); }, "Inner");
      const outer = wrapFunction(() => inner(), "Outer");
      try {
        outer();
        assert.fail("Should throw");
      } catch (err) {
        const lineage = getErrorLineage(err);
        assert.strictEqual(lineage?.operation, "Inner");
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

    it("The resolved value's parents correctly reference all tracked inputs", async () => {
      const fn = wrapFunction(async (a: any) => ({}));
      const in1 = track({}, "in1");
      const out = await fn(in1);
      assert.deepStrictEqual(getLineage(out)?.parents.map(p => p.id), [getLineage(in1)!.id]);
    });

    it("When the async function rejects with an Error, the rejected error has __lineageParents and __operation set", async () => {
      const fn = wrapFunction(async (a: any) => { throw new Error("Async Fail"); }, "async_fail_op");
      const in1 = track({}, "in1");
      await assert.rejects(
        () => fn(in1),
        (err: any) => {
          assert.deepStrictEqual(err.__lineageParents.map((p: any) => p.id), [getLineage(in1)!.id]);
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
        const info = getErrorLineage(err);
        assert.deepStrictEqual(info?.parents.map(p => p.id), [getLineage(in1)!.id]);
        assert.strictEqual(info?.operation, "async_fail_op");
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
      assert.ok(Array.isArray(node.parents));
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
  });

  describe("7. Redaction", () => {
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

  describe("8. DAG integrity", () => {
    it("Linear chain of 100 transforms: printLineage respects the depth limit and prints without crashing", () => {
      let current = track({}, "src");
      for (let i = 0; i < 100; i++) {
        // Create a new object to ensure a proper transformation chain
        current = transform({ step: i }, `step_${i}`, [current]);
      }
      const out = printLineage(current);
      assert.match(out, /transform: step_99/);
      
      // The original source "src" will be correctly pruned to prevent infinite memory chains.
      assert.doesNotMatch(out, /source: src/);
    });

    it("Re-tracking the same object: calling track then transform on the same object reference produces a chain where printLineage shows the transform node first and the source node as its parent", () => {
      const obj = track({}, "src");
      transform(obj, "reused_op", [obj]);
      const out = printLineage(obj);
      
      const lines = out.split("\n");
      assert.match(lines[0], /transform: reused_op/);
      assert.match(lines[1], /source: src/);
    });
  });

  describe("9. Snapshot edge cases", () => {
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

    it("Circular reference object: printLineage output safely replaces the circular reference with '[Object]' and does not throw", () => {
      const obj: any = { data: 1 };
      obj.self = obj;
      track(obj, "circular");
      const out = printLineage(obj);
      assert.match(out, /"\[Object\]"/);
    });

    it("null passed as a transform input: handled without throwing, not included in parents", () => {
      const obj = transform({}, "null_input", [null]);
      assert.deepStrictEqual(getLineage(obj)?.parents, []);
    });

    it("Nested objects, arrays, and functions in objects are replaced with sentinels to prevent memory leaks", () => {
      const obj = track({
        num: 42,
        nestedObj: { a: 1 },
        nestedArr: [1, 2],
        nestedFunc: () => {}
      }, "nested_test");
      const snap = getLineage(obj)?.valueSnapshot as any;
      assert.strictEqual(snap.num, 42);
      assert.strictEqual(snap.nestedObj, "[Object]");
      assert.strictEqual(snap.nestedArr, "[Array]");
      assert.strictEqual(snap.nestedFunc, "[Function]");
    });

    it("Array elements that are objects/arrays/functions are replaced with sentinels to prevent memory leaks", () => {
      const arr = track([42, { a: 1 }, [1, 2], () => {}], "nested_arr_test");
      const snap = getLineage(arr)?.valueSnapshot as any[];
      assert.strictEqual(snap[0], 42);
      assert.strictEqual(snap[1], "[Object]");
      assert.strictEqual(snap[2], "[Array]");
      assert.strictEqual(snap[3], "[Function]");
    });

    it("Truncates strings larger than 200 characters in snapshots", () => {
      const longStr = "A".repeat(250);
      const obj = track({ str: longStr }, "long_string");
      const snap = getLineage(obj)?.valueSnapshot as any;
      assert.ok(snap.str.endsWith("...[truncated]"));
      assert.strictEqual(snap.str.length, 200 + "...[truncated]".length);
    });

    it("Formats Map, Set, and Date objects correctly instead of empty objects", () => {
      const obj = track({
        m: new Map([["a", 1]]),
        s: new Set([1, 2, 3]),
        d: new Date("2026-01-01T00:00:00Z")
      }, "iterables");
      const snap = getLineage(obj)?.valueSnapshot as any;
      assert.deepStrictEqual(snap.m, { __type: "Map", size: 1 });
      assert.deepStrictEqual(snap.s, { __type: "Set", size: 3 });
      assert.deepStrictEqual(snap.d, { __type: "Date", value: "2026-01-01T00:00:00.000Z" });
    });
  });
});