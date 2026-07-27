// A two-file sample (orders + customers) used to seed the "try it with sample
// data" flow and to exercise the recipe runtime in tests.

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

// Starter prompts for the sample data — hardcoded because the sample is static,
// so there's no reason to spend a Haiku call generating them each time. Mirrors
// what the live suggester would offer for orders + customers.
export const SAMPLE_SUGGESTIONS: string[] = [
  "Total revenue by region as a bar chart",
  "Top 10 customers by total spend",
  "Revenue by customer segment as a pie chart",
  "Monthly revenue trend as a line chart",
];

