import type { RecipeParam } from "../types";

export type ParamValues = Record<string, string | number | boolean>;

export function defaultsOf(ps: RecipeParam[]): ParamValues {
  const v: ParamValues = {};
  for (const p of ps) v[p.name] = p.default;
  return v;
}

/** One adjustable-knob control, typed by the param spec. */
export function ParamControl({
  param,
  value,
  onChange,
}: {
  param: RecipeParam;
  value: string | number | boolean;
  onChange: (v: string | number | boolean) => void;
}) {
  return (
    <label className="param">
      <span className="param-label">
        {param.label}
        {param.help && <span className="param-help"> — {param.help}</span>}
      </span>
      {param.type === "enum" ? (
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {(param.options ?? []).map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      ) : param.type === "bool" ? (
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
      ) : param.type === "number" || param.type === "currency" ? (
        <div className="num-input">
          {param.type === "currency" && <span>$</span>}
          <input
            type="number"
            value={Number(value)}
            min={param.min}
            max={param.max}
            step={param.step ?? 1}
            onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          />
        </div>
      ) : param.type === "date" ? (
        <input type="date" value={String(value)} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}
