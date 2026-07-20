import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, Settings, TablePreview } from "../types";

export const DEFAULT_MODEL = "claude-opus-4-8";

const SYSTEM_PROMPT = `You are the code generator inside a data-transformation tool for non-technical office workers. The user uploads a tabular file (CSV or Excel), which is loaded as a pandas DataFrame, and describes filters or transformations in plain language.

Respond with a short plain-language explanation of what the transformation does (1-3 sentences, no jargon), followed by exactly one Python code block containing the complete script.

Requirements for the script:
- Define \`def transform(df: pd.DataFrame) -> pd.DataFrame\` that takes the input table and returns the output table.
- Include all imports at the top (\`import pandas as pd\`, plus anything else needed).
- Use only pandas, numpy, and the Python standard library.
- No file I/O, no network access — operate only on the DataFrame passed in.
- Be robust to messy real-world data (strip whitespace when matching strings, handle missing values sensibly), but never silently drop data unless the user asked for a filter.
- When revising a previous script, return the full updated script, not a diff.
- If the request is ambiguous, make a reasonable choice and state the assumption in your explanation.`;

function datasetContext(
  fileName: string,
  preview: TablePreview,
  shareSampleRows: boolean,
): string {
  const cols = preview.columns
    .map((c, i) => `  - ${c}: ${preview.dtypes[i]}`)
    .join("\n");
  let context = `The user's uploaded table:
- File: ${fileName}
- Rows: ${preview.rowCount}
- Columns:
${cols}`;
  if (shareSampleRows) {
    const sample = preview.rows.slice(0, 20);
    const csv = [
      preview.columns.join(","),
      ...sample.map((row) =>
        row.map((v) => (v === null ? "" : String(v))).join(","),
      ),
    ].join("\n");
    context += `\n\nSample rows (first ${sample.length}, as CSV):\n${csv}`;
  } else {
    context +=
      "\n\n(The user chose not to share sample rows — only the schema above is available.)";
  }
  return context;
}

export function extractScript(text: string): string | null {
  const matches = [...text.matchAll(/```(?:python)?\s*\n([\s\S]*?)```/g)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1].trim();
}

export async function generateScript(
  settings: Settings,
  input: { fileName: string; preview: TablePreview } | null,
  history: ChatMessage[],
): Promise<{ text: string; script: string | null }> {
  const client = new Anthropic({
    apiKey: settings.apiKey,
    dangerouslyAllowBrowser: true,
  });

  const messages: Anthropic.MessageParam[] = history.map((m, i) => {
    let content = m.text;
    // Attach the dataset context to the first user turn. The conversation
    // resets whenever a new file is loaded, so the context stays accurate.
    if (i === 0 && m.role === "user" && input) {
      content = `${datasetContext(input.fileName, input.preview, settings.shareSampleRows)}\n\nUser request: ${m.text}`;
    }
    return { role: m.role, content };
  });

  const response = await client.messages.create({
    model: settings.model || DEFAULT_MODEL,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages,
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return { text, script: extractScript(text) };
}
