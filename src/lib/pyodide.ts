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

  loadFile(name: string, buffer: ArrayBuffer) {
    return this.call<{ preview: TablePreview }>(
      { type: "loadFile", name, buffer },
      [buffer],
    );
  }

  runScript(script: string) {
    return this.call<RunResult>({ type: "runScript", script });
  }

  exportOutput() {
    return this.call<{ csv: string }>({ type: "exportOutput" });
  }
}

export const pyWorker = new PyWorker();
