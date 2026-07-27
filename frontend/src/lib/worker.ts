import type { RunResult, TablePreview } from "../types";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

// Typed RPC bridge to the data worker (jsWorker.ts), which owns the recipe
// runtime + parsed inputs. Same method surface the app has always used; only the
// engine underneath changed (Arquero/JS instead of Pyodide/pandas).
class DataWorker {
  private worker = new Worker(new URL("./jsWorker.ts", import.meta.url), { type: "module" });
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent) => {
      const { id, ok, payload, error } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (ok) p.resolve(payload);
      else p.reject(new Error(error));
    };
  }

  private call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, ...msg }, transfer);
    });
  }

  /** No heavy runtime to fetch anymore; kept for call-site compatibility. */
  warmUp(): void {
    void this.call({ type: "init" }).catch(() => {});
  }

  clearInputs() {
    return this.call<null>({ type: "clearInputs" });
  }

  loadInput(alias: string, name: string, buffer: ArrayBuffer) {
    return this.call<{ preview: TablePreview }>({ type: "loadInput", alias, name, buffer }, [buffer]);
  }

  renameInput(oldAlias: string, alias: string) {
    return this.call<null>({ type: "renameInput", oldAlias, alias });
  }

  removeInput(alias: string) {
    return this.call<null>({ type: "removeInput", alias });
  }

  distinctValues(alias: string, column: string, limit = 100) {
    return this.call<{ values: string[] }>({ type: "distinctValues", alias, column, limit });
  }

  runScript(source: string, params: Record<string, unknown>) {
    return this.call<RunResult>({ type: "runScript", script: source, params: JSON.stringify(params ?? {}) });
  }

  exportTable(name: string) {
    return this.call<{ csv: string }>({ type: "exportTable", table: name });
  }

  // --- Agent tools (resolve with the raw tool result, including {ok:false}) ---

  previewRows(alias: string, n = 5) {
    return this.call<unknown>({ type: "previewRows", alias, n });
  }

  columnProfile(alias: string, column: string) {
    return this.call<unknown>({ type: "columnProfile", alias, column });
  }

  runRecipeTest(script: string, params: Record<string, unknown>, includeValues: boolean) {
    return this.call<unknown>({ type: "runRecipeTest", script, params: JSON.stringify(params ?? {}), includeValues });
  }
}

export const dataWorker = new DataWorker();
