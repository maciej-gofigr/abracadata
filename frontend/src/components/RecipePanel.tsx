import { useState } from "react";
import type { RecipeStep } from "../types";
import { RecipeFlow } from "./RecipeFlow";
import { CodeEditor } from "./CodeEditor";

type Tab = "steps" | "python";

/**
 * The recipe in two views of the same thing: the plain-language step flow
 * (default) and the raw Python, switched by a tab. Downloading the standalone
 * .py lives in the header since it applies to both. When a recipe has no step
 * summary (rare lenient-parse fallback), only the Python view is offered.
 */
export function RecipePanel({
  inputs,
  steps,
  tables,
  plots,
  script,
  onScriptChange,
  onDownload,
}: {
  inputs: string[];
  steps: RecipeStep[];
  tables: string[];
  plots: string[];
  script: string;
  onScriptChange: (value: string) => void;
  onDownload: () => void;
}) {
  const hasSteps = steps.length > 0;
  const [tab, setTab] = useState<Tab>(hasSteps ? "steps" : "python");
  const active: Tab = hasSteps ? tab : "python";

  return (
    <section className="card section recipe-panel">
      <div className="card-header recipe-panel-head">
        {hasSteps ? (
          <div className="recipe-tabs" role="tablist" aria-label="Recipe view">
            <button
              type="button"
              role="tab"
              aria-selected={active === "steps"}
              className={`recipe-tab ${active === "steps" ? "active" : ""}`}
              onClick={() => setTab("steps")}
            >
              Steps
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={active === "python"}
              className={`recipe-tab ${active === "python" ? "active" : ""}`}
              onClick={() => setTab("python")}
            >
              Code
            </button>
          </div>
        ) : (
          <h2>Code</h2>
        )}
        <div className="spacer" />
        <button className="btn ghost" onClick={onDownload}>Download .js</button>
      </div>

      {active === "steps" ? (
        <div className="card-body recipe-steps">
          <RecipeFlow inputs={inputs} steps={steps} tables={tables} plots={plots} />
        </div>
      ) : (
        <div className="code">
          <CodeEditor value={script} onChange={onScriptChange} />
        </div>
      )}
    </section>
  );
}
