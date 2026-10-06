// An exact, independent copy of an object graph (Navigator.fork, the replay's forks): every object reached is copied
// once, keeping its prototype, so references shared inside the original stay shared inside the copy (cycles too).
// `known` maps objects to what the copy uses in their place: itself to share it (read-only data such as the road
// graph), or a stand-in already made. A function can't be copied — a closure would keep working on the original — so
// one reached throws: state meant to be forked keeps no closures (methods live on the prototype, not reached).

type Ctor<T> = new (...args: never[]) => T;

export function deepCopy<T>(value: T, known: Map<object, unknown> = new Map()): T {
  const path: (string | number)[] = [];

  const copy = (v: unknown): unknown => {
    if (typeof v === "function") throw new Error(`deepCopy: can't copy a function at ${path.join(".") || "the root"}`);
    if (v === null || typeof v !== "object") return v;
    if (known.has(v)) return known.get(v);

    // By internal tag, not `instanceof`: an object from another realm (Node's buffers under Jest) is copied too.
    const tag = Object.prototype.toString.call(v).slice(8, -1);
    if (tag === "ArrayBuffer") return remember(v, (v as ArrayBuffer).slice(0));
    if (ArrayBuffer.isView(v)) {
      // Views over one buffer stay views over the one copied buffer.
      const buffer = copy(v.buffer) as ArrayBuffer;
      if (tag === "DataView") return remember(v, new DataView(buffer, v.byteOffset, v.byteLength));
      const typed = v as unknown as { length: number; byteOffset: number; constructor: Ctor<unknown> };
      return remember(v, new typed.constructor(buffer as never, typed.byteOffset as never, typed.length as never));
    }
    if (Array.isArray(v)) {
      const out = remember(v, new Array(v.length));
      for (let i = 0; i < v.length; i++) {
        path.push(i);
        out[i] = copy(v[i]);
        path.pop();
      }
      return out;
    }
    if (tag === "Map") {
      const out = remember(v, new Map());
      for (const [k, x] of v as Map<unknown, unknown>) {
        path.push(String(k));
        out.set(copy(k), copy(x));
        path.pop();
      }
      return out;
    }
    if (tag === "Set") {
      const out = remember(v, new Set());
      for (const x of v as Set<unknown>) out.add(copy(x));
      return out;
    }
    if (tag === "Date") return remember(v, new Date((v as Date).getTime()));
    if (tag !== "Object" && tag !== "Array") throw new Error(`deepCopy: can't copy a ${tag} at ${path.join(".") || "the root"}`);

    const out = remember(v, Object.create(Object.getPrototypeOf(v)) as Record<PropertyKey, unknown>);
    for (const key of Reflect.ownKeys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      path.push(String(key));
      if (!("value" in d)) throw new Error(`deepCopy: can't copy the accessor at ${path.join(".")}`);
      d.value = copy(d.value);
      path.pop();
      if (d.writable && d.enumerable && d.configurable) out[key] = d.value;
      else Object.defineProperty(out, key, d);
    }
    if (Object.isFrozen(v)) Object.freeze(out);
    else if (Object.isSealed(v)) Object.seal(out);
    else if (!Object.isExtensible(v)) Object.preventExtensions(out);
    return out;
  };

  const remember = <O>(original: object, made: O): O => {
    known.set(original, made);
    return made;
  };

  return copy(value) as T;
}
