import type { TablePreview } from "../types";

interface Props {
  preview: TablePreview;
  maxRows?: number;
}

export function DataTable({ preview, maxRows = 50 }: Props) {
  const rows = preview.rows.slice(0, maxRows);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {preview.columns.map((c, i) => (
              <th key={i} title={preview.dtypes[i]}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci}>{cell === null ? "" : String(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {preview.rowCount > rows.length && (
        <div className="table-note">
          Showing first {rows.length} of {preview.rowCount.toLocaleString()}{" "}
          rows
        </div>
      )}
    </div>
  );
}
