import { useEffect, useRef } from "react";
import type { FigureSpec } from "../types";
import { downloadPlotPng, renderPlot } from "../lib/plot";
import { prettify } from "../lib/format";

export function PlotView({ spec }: { spec: FigureSpec }) {
  const ref = useRef<HTMLDivElement>(null);
  const title = prettify(spec.name);

  useEffect(() => {
    const el = ref.current;
    if (el) void renderPlot(el, spec.figure);
  }, [spec]);

  return (
    <div className="card">
      <div className="card-header">
        <h2>{title}</h2>
        <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={() => ref.current && void downloadPlotPng(ref.current, spec.name)}>
          Download PNG
        </button>
      </div>
      <div className="plot-host" ref={ref} />
    </div>
  );
}
