export interface TablePreview {
  columns: string[];
  dtypes: string[];
  rows: unknown[][];
  rowCount: number;
}

/** A named output table (a recipe can return several). */
export interface NamedTable {
  name: string;
  preview: TablePreview;
}

/** A Plotly figure spec, built in Python and rendered by Plotly.js in the browser. */
export interface PlotlyFigure {
  data: unknown[];
  layout?: Record<string, unknown>;
}

export interface FigureSpec {
  name: string;
  figure: PlotlyFigure;
}

/** One uploaded input file, keyed by an editable alias the recipe references. */
export interface InputFile {
  alias: string;
  fileName: string;
  preview: TablePreview;
}

export type ParamType =
  | "number"
  | "currency"
  | "date"
  | "enum"
  | "bool"
  | "text";

/** Where a choice param's dropdown values come from — resolved from the actual
 * loaded data at render time, so the options adapt to the user's file. */
export interface ParamSource {
  from: "columns" | "values";
  input?: string; // which input alias (defaults to the only/first input)
  column?: string; // for "values": the column whose distinct values to offer
}

/** An inferred, user-adjustable knob (default = the value the recipe first used). */
export interface RecipeParam {
  name: string;
  label: string;
  type: ParamType;
  default: string | number | boolean;
  options?: string[];
  source?: ParamSource; // data-driven dropdown options (columns or a column's values)
  min?: number;
  max?: number;
  step?: number;
  help?: string;
}

/** Result of running a recipe: 1+ tables, 0+ plots. */
export interface RunResult {
  tables: NamedTable[];
  plots: FigureSpec[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface Settings {
  apiKey: string;
  model: string;
  shareSampleRows: boolean;
}

/** v2 recipe metadata header. */
export interface RecipeMeta {
  version: 2;
  name: string;
  created: string;
  prompts: string[];
  inputs: { alias: string; columns: string[] }[];
  params: RecipeParam[];
}

/** Legacy — kept for the (currently unused) DiffSummary component. */
export interface DiffSummary {
  rowsIn: number;
  rowsOut: number;
  columnsAdded: string[];
  columnsRemoved: string[];
}
