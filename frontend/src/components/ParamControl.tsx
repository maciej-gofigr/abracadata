import { useEffect, useState } from "react";
import { dataWorker } from "../lib/worker";
import type { RecipeParam } from "../types";

export type ParamValues = Record<string, string | number | boolean>;

export function defaultsOf(ps: RecipeParam[]): ParamValues {
  const v: ParamValues = {};
  for (const p of ps) v[p.name] = p.default;
  return v;
}

/**
 * Resolve each param's dropdown options from the actual loaded data:
 * `source: columns` → the input's column names (synchronous); `source: values` →
 * the distinct values of a column (fetched from the worker, cached). Static
 * `options` (enum) pass through. Returns {} entries for params with no options.
 */
export function useParamOptions(
  params: RecipeParam[],
  inputs: { alias: string; columns: string[] }[],
): Record<string, string[]> {
  const [valueOpts, setValueOpts] = useState<Record<string, string[]>>({});

  const valueSpecs = params
    .filter((p) => p.source?.from === "values" && p.source.column)
    .map((p) => ({ name: p.name, alias: p.source!.input ?? inputs[0]?.alias, column: p.source!.column! }));

  const inputSig = inputs.map((i) => `${i.alias}:${i.columns.length}`).join("|");
  const valueSig = valueSpecs.map((v) => `${v.name}:${v.alias}:${v.column}`).join("|");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, string[]> = {};
      for (const v of valueSpecs) {
        if (!v.alias || !inputs.some((i) => i.alias === v.alias)) continue;
        try {
          const r = await dataWorker.distinctValues(v.alias, v.column);
          next[v.name] = r.values ?? [];
        } catch {
          next[v.name] = [];
        }
      }
      if (!cancelled) setValueOpts(next);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputSig, valueSig]);

  const result: Record<string, string[]> = {};
  for (const p of params) {
    if (p.source?.from === "columns") {
      const inp = p.source.input ? inputs.find((i) => i.alias === p.source!.input) : inputs[0];
      result[p.name] = inp?.columns ?? [];
    } else if (p.source?.from === "values") {
      result[p.name] = valueOpts[p.name] ?? [];
    } else if (p.options) {
      result[p.name] = p.options;
    }
  }
  return result;
}

/** One adjustable-knob control, typed by the param spec. Choice params (enum or
 * data-sourced) render as a combobox: pick from the dropdown OR type free-form. */
export function ParamControl({
  param,
  value,
  onChange,
  options,
}: {
  param: RecipeParam;
  value: string | number | boolean;
  onChange: (v: string | number | boolean) => void;
  options?: string[];
}) {
  const isChoice = param.type === "enum" || !!param.source;
  const choiceOptions = options ?? param.options ?? [];
  const listId = `opts-${param.name}`;
  const current = String(value ?? "");
  // Match the runtime's case-insensitive column resolution, so a default of
  // "Amount" is recognized as the file's "amount" and isn't flagged as missing.
  const matched = choiceOptions.find((o) => o.trim().toLowerCase() === current.trim().toLowerCase());
  const isMissing = isChoice && choiceOptions.length > 0 && current !== "" && !matched;
  const [freeForm, setFreeForm] = useState(false);

  return (
    <label className="param">
      <span className="param-label">
        {param.label}
        {param.help && <span className="param-help"> — {param.help}</span>}
      </span>
      {isChoice && choiceOptions.length > 0 && !freeForm ? (
        // A real <select> so the choices are visibly discoverable (a bare
        // datalist looks identical to a text box). "Other…" keeps free-form entry.
        <select
          className={isMissing ? "param-missing" : undefined}
          value={matched ?? (current === "" ? "" : "__missing__")}
          onChange={(e) => {
            if (e.target.value === "__other__") { setFreeForm(true); return; }
            onChange(e.target.value);
          }}
        >
          {current === "" && <option value="">Choose…</option>}
          {isMissing && <option value="__missing__">{current} — not in this file</option>}
          {choiceOptions.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
          <option value="__other__">Other…</option>
        </select>
      ) : isChoice ? (
        <>
          <input
            className="combobox-input"
            list={listId}
            value={current}
            placeholder={choiceOptions.length ? "Type or pick…" : "Type a value…"}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => { if (choiceOptions.length && current === "") setFreeForm(false); }}
          />
          <datalist id={listId}>
            {choiceOptions.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </>
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
