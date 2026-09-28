// In-context half of the « Chaîne » sandbox. This source is compiled INSIDE the program's fresh V8
// context, so every object the program can reach (`nova`, `console`, call promises, errors) belongs
// to that context: none leads back to the host's realm (`x.constructor.constructor` is the
// context's own Function, and code generation from strings is disabled there).
//
// The host hands exactly one function in, `post(kind, a, b, c)`, kept in this closure (the program
// is compiled separately, at global scope, and cannot name it) and only ever called with
// primitives; `post` never throws into the program. Built-ins are captured before the program runs,
// so a program that patches JSON, Promise or Reflect cannot change how the bridge talks to the host.
// Kept as plain JavaScript text: it must be created by the context, not imported by the host.

/** Kinds posted by the bridge to the host. */
export type BridgeEvent =
  | { kind: "call"; id: string; tool: string; argsJson: string }
  | { kind: "log"; text: string }
  | { kind: "done"; ok: true; resultJson: string | null }
  | { kind: "done"; ok: false; error: string };

/**
 * Returns the bridge source: a function expression `(post) => void` that installs the two host
 * entry points as non-writable, non-configurable globals named `enterKey` / `deliverKey`.
 */
export function bridgeSource(enterKey: string, deliverKey: string): string {
  return `(function (post) {
  "use strict";
  const G = globalThis;
  const create = Object.create;
  const defineProperty = Object.defineProperty;
  const freeze = Object.freeze;
  const stringify = JSON.stringify;
  const apply = Reflect.apply;
  const PromiseCtor = Promise;
  const promiseThen = Promise.prototype.then;
  const promiseResolve = Promise.resolve;
  const ErrorCtor = Error;
  const TypeErrorCtor = TypeError;
  const StringCtor = String;
  const ProxyCtor = Proxy;
  const pending = create(null);
  let nextId = 0;
  let started = false;
  let settled = false;

  // Engine extras a program never needs: blocking waits and raw modules.
  delete G.console;
  delete G.Atomics;
  delete G.SharedArrayBuffer;
  delete G.WebAssembly;

  function send(kind, a, b, c) {
    try { post(kind, a, b, c); } catch (_) { /* host failures never reach the program */ }
  }
  function text(value) {
    if (typeof value === "string") return value;
    try { const json = stringify(value); if (typeof json === "string") return json; } catch (_) { /* fall through */ }
    try { return StringCtor(value); } catch (_) { return "[value]"; }
  }
  function messageOf(error) {
    try {
      if (error !== null && typeof error === "object") {
        const message = error.message;
        const name = error.name;
        if (typeof message === "string") return (typeof name === "string" && name ? name + ": " : "") + message;
      }
      return text(error);
    } catch (_) {
      return "unknown error";
    }
  }
  function rejected(message) {
    return new PromiseCtor(function (_resolve, reject) { reject(new TypeErrorCtor(message)); });
  }
  function call(tool, args) {
    if (settled) return rejected("the program has already ended");
    let argsJson;
    try {
      argsJson = args === undefined ? "{}" : stringify(args);
    } catch (error) {
      return rejected("the arguments of nova." + tool + " must be JSON: " + messageOf(error));
    }
    if (typeof argsJson !== "string") return rejected("the arguments of nova." + tool + " must be a JSON object");
    nextId += 1;
    const id = "c" + nextId;
    const promise = new PromiseCtor(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
    // A refused call the program never awaits must not surface as an unhandled rejection.
    apply(promiseThen, promise, [undefined, function () {}]);
    send("call", id, tool, argsJson);
    return promise;
  }
  const nova = new ProxyCtor(create(null), {
    get: function (_target, name) {
      if (typeof name !== "string" || name === "then") return undefined;
      return function (args) { return call(name, args); };
    },
    has: function (_target, name) { return typeof name === "string" && name !== "then"; },
    set: function () { return false; },
    defineProperty: function () { return false; },
    deleteProperty: function () { return false; },
    setPrototypeOf: function () { return false; },
  });
  function log() {
    let line = "";
    for (let index = 0; index < arguments.length; index += 1) line += (index > 0 ? " " : "") + text(arguments[index]);
    send("log", line);
  }
  const consoleObject = freeze({ log: log, info: log, warn: log, error: log, debug: log });
  function succeed(value) {
    if (settled) return;
    settled = true;
    if (value === undefined) { send("done", true, null); return; }
    let json;
    try {
      json = stringify(value);
    } catch (error) {
      send("done", false, "the return value is not JSON-serializable: " + messageOf(error));
      return;
    }
    send("done", true, typeof json === "string" ? json : null);
  }
  function fail(error) {
    if (settled) return;
    settled = true;
    send("done", false, messageOf(error));
  }
  function enter(program) {
    if (started) return;
    started = true;
    if (typeof program !== "function") { fail(new TypeErrorCtor("the program must be the body of an async function")); return; }
    let result;
    try { result = program(nova, consoleObject); } catch (error) { fail(error); return; }
    apply(promiseThen, apply(promiseResolve, PromiseCtor, [result]), [succeed, fail]);
  }
  function deliver(id, ok, content) {
    const entry = pending[id];
    if (entry === undefined) return;
    delete pending[id];
    if (ok) entry.resolve(content);
    else entry.reject(new ErrorCtor(content));
  }
  defineProperty(G, ${JSON.stringify(enterKey)}, { value: enter });
  defineProperty(G, ${JSON.stringify(deliverKey)}, { value: deliver });
})`;
}
