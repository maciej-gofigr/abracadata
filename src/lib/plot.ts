import type { PlotlyFigure } from "../types";

// Plotly.js is large, so it's loaded lazily — only when a recipe actually
// produces a plot. The Python side emits a plain figure spec (data + layout);
// Plotly.js renders it natively here in the browser (no Plotly in Pyodide).
let plotlyPromise: Promise<any> | null = null;

function getPlotly(): Promise<any> {
  if (!plotlyPromise) {
    plotlyPromise = import("plotly.js-dist-min").then((m: any) => m.default ?? m);
  }
  return plotlyPromise;
}

const BASE_LAYOUT = {
  autosize: true,
  margin: { t: 44, r: 18, b: 44, l: 60 },
  font: { family: "-apple-system, Segoe UI, Helvetica, Arial, sans-serif" },
  colorway: ["#1a6e5a", "#5b5bd6", "#c6537a", "#2f9e68", "#b8892b"],
  paper_bgcolor: "transparent",
  plot_bgcolor: "transparent",
};

export async function renderPlot(el: HTMLElement, figure: PlotlyFigure) {
  const Plotly = await getPlotly();
  await Plotly.react(el, figure.data ?? [], { ...BASE_LAYOUT, ...(figure.layout ?? {}) }, {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  });
}

export async function downloadPlotPng(el: HTMLElement, name: string) {
  const Plotly = await getPlotly();
  await Plotly.downloadImage(el, { format: "png", filename: name, width: 1000, height: 500 });
}
