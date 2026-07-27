import type { RecipeParam } from "../types";

// Curated starter recipes. Each is a real, tested transform(inputs, params) that
// works on the user's own files — column names are resolved case-insensitively
// and are adjustable via knobs — and ships with example data so it can be tried
// in one click. Opening one drops you into the apply screen.

export interface TemplateSample {
  alias: string;
  filename: string;
  csv: string;
}

export interface Template {
  slug: string;
  name: string;
  category: string;
  icon: string;
  description: string;
  script: string;
  params: RecipeParam[];
  inputs: { alias: string; columns: string[] }[];
  samples: TemplateSample[];
}

const SALES_CSV = `Category,Amount,Region
Software,1200,West
Hardware,450,East
Software,800,West
Services,300,Central
Hardware,600,East
Services,900,West
Software,1500,East
Services,250,Central
Hardware,720,West`;

export const TEMPLATES: Template[] = [
  {
    slug: "total-by-category",
    name: "Total by category",
    category: "Summarize",
    icon: "📊",
    description: "Group a file by a category column and total up a value — with a bar chart. The classic pivot-table summary.",
    params: [
      { name: "category_column", label: "Group by column", type: "text", source: { from: "columns", input: "data" }, default: "Category", help: "The column to group rows by" },
      { name: "value_column", label: "Value to total", type: "text", source: { from: "columns", input: "data" }, default: "Amount", help: "The number column to sum" },
    ],
    inputs: [{ alias: "data", columns: ["Category", "Amount"] }],
    samples: [{ alias: "data", filename: "sales.csv", csv: SALES_CSV }],
    script: `function transform(inputs, params) {
  const t = inputs.data;
  const cat = col(t, params.category_column ?? 'Category');
  const val = col(t, params.value_column ?? 'Amount');
  const out = t
    .derive({ __v: aq.escape(d => parseNumber(d[val])) })
    .groupby(cat)
    .rollup({ Total: op.sum('__v') })
    .orderby(aq.desc('Total'))
    .derive({ Total: d => op.round(d.Total * 100) / 100 });
  const chart = plotBar(out.array(cat), out.array('Total'), { title: 'Total by ' + cat, ylabel: 'Total' });
  return { tables: { Summary: out }, plots: { 'Total by category': chart } };
}`,
  },
  {
    slug: "top-n",
    name: "Top N by value",
    category: "Summarize",
    icon: "🏆",
    description: "Find the biggest rows by any number column — your top customers, largest orders, best sellers.",
    params: [
      { name: "value_column", label: "Rank by column", type: "text", source: { from: "columns", input: "data" }, default: "Amount", help: "The number column to sort by" },
      { name: "top_n", label: "How many", type: "number", default: 10, min: 1, help: "Number of top rows to keep" },
    ],
    inputs: [{ alias: "data", columns: ["Name", "Amount"] }],
    samples: [{
      alias: "data", filename: "customers.csv", csv: `Customer,Amount
Acme Corp,18400
Globex,9200
Initech,15600
Umbrella,7300
Stark Industries,22100
Wayne Enterprises,13800
Wonka,4200
Cyberdyne,11000
Soylent,6100
Tyrell,19500
Hooli,8700
Pied Piper,3100`,
    }],
    script: `function transform(inputs, params) {
  const t = inputs.data;
  const val = col(t, params.value_column ?? 'Amount');
  const n = Math.max(1, Math.floor(params.top_n ?? 10));
  const out = t
    .derive({ [val]: aq.escape(d => parseNumber(d[val])) })
    .orderby(aq.desc(val))
    .slice(0, n);
  const label = t.columnNames()[0];
  const chart = plotBar(out.array(label), out.array(val), { title: 'Top ' + n + ' by ' + val });
  return { tables: { ['Top ' + n]: out }, plots: { 'Top items': chart } };
}`,
  },
  {
    slug: "monthly-totals",
    name: "Monthly totals",
    category: "Summarize",
    icon: "📅",
    description: "Roll a dated file up into a total per month — spot trends across the year at a glance.",
    params: [
      { name: "date_column", label: "Date column", type: "text", source: { from: "columns", input: "data" }, default: "Date" },
      { name: "value_column", label: "Value to total", type: "text", source: { from: "columns", input: "data" }, default: "Amount" },
    ],
    inputs: [{ alias: "data", columns: ["Date", "Amount"] }],
    samples: [{
      alias: "data", filename: "transactions.csv", csv: `Date,Amount,Note
2026-01-05,1200,invoice
2026-01-19,800,invoice
2026-02-03,1500,invoice
2026-02-21,600,invoice
2026-02-28,900,invoice
2026-03-10,1100,invoice
2026-03-25,1400,invoice
2026-04-08,700,invoice
2026-04-30,1300,invoice
2026-05-14,1000,invoice
2026-05-22,1600,invoice
2026-06-02,850,invoice`,
    }],
    script: `function transform(inputs, params) {
  const t = inputs.data;
  const dcol = col(t, params.date_column ?? 'Date');
  const vcol = col(t, params.value_column ?? 'Amount');
  const out = t
    .derive({ Month: aq.escape(d => yearMonth(d[dcol])), __v: aq.escape(d => parseNumber(d[vcol])) })
    .filter(aq.escape(d => d.Month !== null))
    .groupby('Month')
    .rollup({ Total: op.sum('__v') })
    .orderby('Month')
    .derive({ Total: d => op.round(d.Total * 100) / 100 });
  const chart = plotLine(out.array('Month'), out.array('Total'), { title: 'Total by month', xlabel: 'Month', ylabel: 'Total' });
  return { tables: { 'By month': out }, plots: { 'Monthly total': chart } };
}`,
  },
  {
    slug: "merge-two-files",
    name: "Look up values from another file",
    category: "Combine",
    icon: "🔗",
    description: "Bring columns from a second file into your main file by a shared ID — a VLOOKUP that never breaks.",
    params: [{ name: "key_column", label: "Shared column (the key)", type: "text", source: { from: "columns", input: "main" }, default: "ID", help: "The column both files have in common" }],
    inputs: [
      { alias: "main", columns: ["ID", "…"] },
      { alias: "lookup", columns: ["ID", "…"] },
    ],
    samples: [
      { alias: "main", filename: "orders.csv", csv: `ID,Order,Amount
C-001,Widget,120
C-002,Gadget,340
C-003,Gizmo,90
C-004,Doohickey,560
C-009,Thingamajig,210` },
      { alias: "lookup", filename: "customers.csv", csv: `ID,Customer,Region
C-001,Acme Corp,West
C-002,Globex,East
C-003,Initech,West
C-004,Umbrella,Central` },
    ],
    script: `function transform(inputs, params) {
  const main = inputs.main, lookup = inputs.lookup;
  const key = params.key_column ?? 'ID';
  const km = col(main, key), kl = col(lookup, key);
  const merged = main.join_left(lookup, [[km], [kl]]);
  const extra = lookup.columnNames().filter(c => c !== kl);
  const tables = { Merged: merged };
  if (extra.length) {
    const unmatched = merged.filter(aq.escape(d => d[extra[0]] === undefined || d[extra[0]] === null));
    if (unmatched.numRows() > 0) tables['Unmatched rows'] = unmatched;
  }
  return { tables, plots: {} };
}`,
  },
  {
    slug: "find-duplicates",
    name: "Find duplicate rows",
    category: "Clean",
    icon: "🧹",
    description: "Surface rows that repeat a value (same email, same ID) so you can dedupe with confidence.",
    params: [{ name: "key_column", label: "Column to check", type: "text", source: { from: "columns", input: "data" }, default: "ID", help: "Rows sharing this value are duplicates" }],
    inputs: [{ alias: "data", columns: ["ID"] }],
    samples: [{
      alias: "data", filename: "contacts.csv", csv: `ID,Name,Signed up
C-001,Alice,2026-01-05
C-002,Bob,2026-01-06
C-001,Alice A.,2026-02-11
C-003,Carol,2026-02-14
C-002,Bob B.,2026-03-02
C-004,Dave,2026-03-10`,
    }],
    script: `function transform(inputs, params) {
  const t = inputs.data;
  const key = col(t, params.key_column ?? 'ID');
  const withNorm = t.derive({ __k: aq.escape(d => String(d[key] ?? '').trim().toLowerCase()) });
  const counts = withNorm.groupby('__k').rollup({ __n: op.count() });
  const joined = withNorm.join_left(counts, ['__k', '__k']);
  const dups = joined.filter(d => d.__n > 1).orderby('__k').select(aq.not('__k', '__n'));
  const uniq = joined.filter(d => d.__n === 1).select(aq.not('__k', '__n'));
  return { tables: { Duplicates: dups, 'Unique rows': uniq }, plots: {} };
}`,
  },
  {
    slug: "whats-missing",
    name: "What's in one list but not the other",
    category: "Combine",
    icon: "⚖️",
    description: "Reconcile two lists — e.g. invoices not yet paid, or customers missing from a report. Rows in A whose key isn't in B.",
    params: [{ name: "key_column", label: "Column to match on", type: "text", source: { from: "columns", input: "list_a" }, default: "ID" }],
    inputs: [
      { alias: "list_a", columns: ["ID"] },
      { alias: "list_b", columns: ["ID"] },
    ],
    samples: [
      { alias: "list_a", filename: "all_invoices.csv", csv: `ID,Invoice,Amount
INV-001,Jan services,1200
INV-002,Feb services,1500
INV-003,Mar services,900
INV-004,Apr services,1100
INV-005,May services,1300` },
      { alias: "list_b", filename: "paid_invoices.csv", csv: `ID,Paid on
INV-001,2026-02-01
INV-003,2026-04-01
INV-005,2026-06-01` },
    ],
    script: `function transform(inputs, params) {
  const a = inputs.list_a, b = inputs.list_b;
  const key = params.key_column ?? 'ID';
  const ka = col(a, key), kb = col(b, key);
  const bset = new Set(b.array(kb).map(v => String(v ?? '').trim().toLowerCase()));
  const missing = a.filter(aq.escape(d => !bset.has(String(d[ka] ?? '').trim().toLowerCase())));
  return { tables: { 'In list_a but not list_b': missing }, plots: {} };
}`,
  },
];

export const TEMPLATE_CATEGORIES = ["Summarize", "Combine", "Clean"];

export function templateBySlug(slug: string): Template | undefined {
  return TEMPLATES.find((t) => t.slug === slug);
}
