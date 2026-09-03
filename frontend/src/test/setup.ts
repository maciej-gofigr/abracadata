import "@testing-library/jest-dom/vitest";

// happy-dom has no Worker. Components mount the data worker (warmUp/clearInputs)
// on render, so without this any component test touching it dies with
// "ReferenceError: Worker is not defined" — and, because the failure surfaces
// asynchronously, it does so intermittently: it passed locally and failed in CI.
// The stub is inert: recipes/tools are exercised directly against recipeRuntime.
class WorkerStub {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
if (typeof globalThis.Worker === "undefined") {
  (globalThis as unknown as { Worker: unknown }).Worker = WorkerStub;
}
