/** Turn machine-y output names (`orders_per_customer`) into a friendly heading
 * ("Orders per customer") for display. The recipe still uses the raw name. */
export function prettify(name: string): string {
  const s = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return name;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
