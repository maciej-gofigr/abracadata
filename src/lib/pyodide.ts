import type { RunResult, TablePreview } from "../types";

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

class PyWorker {
  private worker = new Worker(new URL("./pyodideWorker.ts", import.meta.url), {
    type: "module",
  });
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

  private call<T>(
    msg: Record<string, unknown>,
    transfer: Transferable[] = [],
  ): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...msg }, transfer);
    });
  }

  /** Kick off the Pyodide download without waiting for it. */
  warmUp(): void {
    void this.call({ type: "init" }).catch(() => {});
  }

  clearInputs() {
    return this.call<null>({ type: "clearInputs" });
  }

  loadInput(alias: string, name: string, buffer: ArrayBuffer) {
    return this.call<{ preview: TablePreview }>(
      { type: "loadInput", alias, name, buffer },
      [buffer],
    );
  }

  runScript(source: string, params: Record<string, unknown>) {
    return this.call<RunResult>({
      type: "runScript",
      script: source,
      params: JSON.stringify(params ?? {}),
    });
  }

  exportTable(name: string) {
    return this.call<{ csv: string }>({ type: "exportTable", table: name });
  }
}

export const pyWorker = new PyWorker();
