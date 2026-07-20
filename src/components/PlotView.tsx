import { useEffect, useRef } from "react";
import type { FigureSpec } from "../types";
import { downloadPlotPng, renderPlot } from "../lib/plot";

export function PlotView({ spec }: { spec: FigureSpec }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) void renderPlot(el, spec.figure);
  }, [spec]);

  return (
    <div className="card">
      <div className="card-header">
        <h2>{spec.name}</h2>
        <button
          onClick={() => ref.current && void downloadPlotPng(ref.current, spec.name)}
        >
          Download PNG
        </button>
      </div>
      <div className="plot-host" ref={ref} style={{ width: "100%", height: 360 }} />
    </div>
  );
}
