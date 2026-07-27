import type { RecipeStep } from "../types";

/**
 * A layperson-readable "how it works" diagram: input files flow top-to-bottom
 * through numbered plain-language steps into the output tables/charts. Shown
 * after every turn so a non-technical user sees what the recipe does without
 * reading Python. `steps` come from the model's submit_recipe; the input/output
 * endcaps are the actual file aliases and produced table/plot names.
 */
export function RecipeFlow({
  inputs,
  steps,
  tables,
  plots,
}: {
  inputs: string[];
  steps: RecipeStep[];
  tables: string[];
  plots: string[];
}) {
  if (steps.length === 0) return null;
  const outputs = [
    ...tables.map((name) => ({ name, icon: "▦", kind: "table" })),
    ...plots.map((name) => ({ name, icon: "▤", kind: "chart" })),
  ];

  return (
    <div className="recipe-flow" aria-label="How this recipe works">
      {inputs.length > 0 && (
        <>
          <div className="flow-endcaps">
            {inputs.map((name) => (
              <span className="flow-chip flow-in" key={name}>
                <span className="flow-ico" aria-hidden="true">▤</span>
                {name}
              </span>
            ))}
          </div>
          <div className="flow-arrow" aria-hidden="true" />
        </>
      )}

      <ol className="flow-steps">
        {steps.map((s, i) => (
          <li className="flow-step" key={i}>
            <span className="flow-num" aria-hidden="true">{i + 1}</span>
            <div className="flow-step-body">
              <div className="flow-step-title">{s.title}</div>
              {s.detail && <div className="flow-step-detail">{s.detail}</div>}
            </div>
          </li>
        ))}
      </ol>

      {outputs.length > 0 && (
        <>
          <div className="flow-arrow" aria-hidden="true" />
          <div className="flow-endcaps">
            {outputs.map((o) => (
              <span className={`flow-chip flow-out flow-${o.kind}`} key={o.kind + o.name}>
                <span className="flow-ico" aria-hidden="true">{o.icon}</span>
                {o.name}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
