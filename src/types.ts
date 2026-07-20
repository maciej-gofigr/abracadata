export interface TablePreview {
  columns: string[];
  dtypes: string[];
  rows: unknown[][];
  rowCount: number;
}

export interface DiffSummary {
  rowsIn: number;
  rowsOut: number;
  columnsAdded: string[];
  columnsRemoved: string[];
}

export interface RunResult {
  preview: TablePreview;
  diff: DiffSummary;
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

export interface RecipeMeta {
  version: 1;
  name: string;
  created: string;
  prompts: string[];
  expectedColumns: string[];
}
