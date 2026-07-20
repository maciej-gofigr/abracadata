import type { DiffSummary as Diff } from "../types";

export function DiffSummary({ diff }: { diff: Diff }) {
  const parts: string[] = [
    `${diff.rowsIn.toLocaleString()} rows in → ${diff.rowsOut.toLocaleString()} rows out`,
  ];
  if (diff.columnsAdded.length > 0) {
    parts.push(`added: ${diff.columnsAdded.join(", ")}`);
  }
  if (diff.columnsRemoved.length > 0) {
    parts.push(`removed: ${diff.columnsRemoved.join(", ")}`);
  }
  return <div className="diff-summary">{parts.join(" · ")}</div>;
}
