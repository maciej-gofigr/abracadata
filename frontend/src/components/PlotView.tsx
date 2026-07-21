import { useEffect, useRef, useState } from "react";
import type { FigureSpec } from "../types";
import { downloadPlotPng, renderPlot } from "../lib/plot";
import { prettify } from "../lib/format";

export function PlotView({ spec }: { spec: FigureSpec }) {
  const ref = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);
  const title = prettify(spec.name);

  useEffect(() => {
    const el = ref.current;
    if (el) void renderPlot(el, spec.figure);
  }, [spec]);

  async function download() {
    if (!ref.current || downloading) return;
    setDownloading(true);
    try {
      await downloadPlotPng(ref.current, spec.name);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2>{title}</h2>
        <button className="btn ghost" style={{ marginLeft: "auto" }} disabled={downloading} onClick={download}>
          {downloading ? <><span className="spinner" aria-hidden="true" />Preparing…</> : "Download PNG"}
        </button>
      </div>
      <div className="plot-host" ref={ref} />
    </div>
  );
}
