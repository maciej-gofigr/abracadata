import type { RecipeParam, RecipeStep } from "../types";

// A two-file sample so the v2 runtime can be exercised end-to-end without an
// LLM: join orders → customers, filter by a param, summarize + chart.

export const SAMPLE_ORDERS_CSV = `Order ID,Customer ID,Amount,Date,Status
10001,C-001,248.00,2026-06-01,paid
10002,C-002,76.50,2026-06-01,paid
10003,C-003,1120.00,2026-06-02,paid
10004,C-004,42.00,2026-06-02,refunded
10005,C-005,305.75,2026-06-03,paid
10006,C-006,89.99,2026-06-03,paid
10007,C-007,560.00,2026-06-04,paid
10008,C-008,410.20,2026-06-04,paid
10009,C-001,1890.00,2026-06-05,paid
10010,C-002,150.00,2026-06-05,paid
10011,C-003,60.00,2026-06-06,paid
10012,C-004,720.40,2026-06-06,paid
10013,C-005,95.00,2026-06-07,paid
10014,C-006,2400.00,2026-06-07,paid
10015,C-007,210.00,2026-06-08,paid
10016,C-008,48.50,2026-06-08,refunded
10017,C-001,375.00,2026-06-09,paid
10018,C-003,880.00,2026-06-09,paid
10019,C-005,132.25,2026-06-10,paid
10020,C-007,1650.00,2026-06-10,paid
10021,C-002,505.00,2026-06-11,paid
10022,C-004,275.80,2026-06-11,paid
10023,C-006,99.00,2026-06-12,paid
10024,C-008,1320.00,2026-06-12,paid
`;

export const SAMPLE_CUSTOMERS_CSV = `Customer ID,Customer,Region,Segment
C-001,Acme Corp,East,Enterprise
C-002,Bluebird LLC,East,SMB
C-003,Cedar & Co,West,Enterprise
C-004,Delta Foods,Central,SMB
C-005,Evergreen,West,Mid-Market
C-006,Foxtrot Inc,South,SMB
C-007,Golden Gate,West,Enterprise
C-008,Harbor Ltd,Central,Mid-Market
`;

export const SAMPLE_SCRIPT = `import pandas as pd

def transform(inputs, params):
    orders = inputs["orders"]
    customers = inputs["customers"]

    # join each order to its customer record
    df = orders.merge(customers, on="Customer ID", how="left")

    # keep only orders at or above the threshold
    df["Amount"] = df["Amount"].astype(float)
    df = df[df["Amount"] >= params["min_amount"]]

    # one row per group, with order count and total revenue
    group = params["group_by"]
    summary = (
        df.groupby(group, as_index=False)
          .agg(Orders=("Order ID", "count"), **{"Total Revenue": ("Amount", "sum")})
          .sort_values("Total Revenue", ascending=False)
    )

    chart = plot_bar(
        summary[group], summary["Total Revenue"],
        title="Total revenue by " + group.lower(), ylabel="Revenue ($)",
    )
    return {
        "tables": {"By " + group.lower(): summary, "Joined orders": df},
        "plots": {"Revenue by " + group.lower(): chart},
    }
`;

export const SAMPLE_PARAMS: RecipeParam[] = [
  {
    name: "min_amount",
    label: "Minimum order amount",
    type: "currency",
    default: 100,
    min: 0,
    step: 50,
    help: "Orders below this are dropped",
  },
  {
    name: "group_by",
    label: "Group by",
    type: "enum",
    default: "Region",
    options: ["Region", "Segment"],
    help: "One row per group",
  },
];

// Starter prompts for the sample data — hardcoded because the sample is static,
// so there's no reason to spend a Haiku call generating them each time. Mirrors
// what the live suggester would offer for orders + customers.
export const SAMPLE_SUGGESTIONS: string[] = [
  "Total revenue by region as a bar chart",
  "Top 10 customers by total spend",
  "Revenue by customer segment as a pie chart",
  "Monthly revenue trend as a line chart",
];

export const SAMPLE_STEPS: RecipeStep[] = [
  { title: "Combine orders with customer details" },
  { title: "Keep orders at or above the minimum amount" },
  { title: "Total revenue and order count per group", detail: "Grouped by region or segment" },
  { title: "Chart revenue by group as a bar chart" },
];

export const SAMPLE_INPUT_ALIASES = ["orders", "customers"] as const;
