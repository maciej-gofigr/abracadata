// Talks to the backend. In dev, Vite proxies /api to FastAPI; in prod, nginx does.
// Recipe generation is an agent loop — see src/lib/agent.ts (it owns /api/generate).

/** Strip fenced code blocks from streamed narration for display. */
export function explanationOnly(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Fast (Haiku) prompt suggestions for the loaded files. Best-effort → [] on failure. */
export function suggestPrompts(
  inputs: { alias: string; columns: string[]; dtypes: string[]; sample_rows?: unknown[][] }[],
): Promise<string[]> {
  return fetch("/api/suggest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ inputs }),
  })
    .then((r) => (r.ok ? r.json() : { suggestions: [] }))
    .then((d) => (Array.isArray(d?.suggestions) ? (d.suggestions as string[]) : []))
    .catch(() => []);
}

// ---------- auth (passwordless email code) ----------

export interface AuthState { email: string | null; is_admin: boolean }

export function authMe(): Promise<AuthState> {
  return fetch("/api/auth/me", { credentials: "include" }).then(j<AuthState>);
}

/** FastAPI puts a human-readable reason in `detail`; prefer it over a bare status
 * code, which is what users were being shown for throttled sign-ins. */
async function serverDetail(r: Response): Promise<string | null> {
  try {
    const body = await r.json();
    const d = (body as { detail?: unknown }).detail;
    return typeof d === "string" && d.trim() ? d.trim() : null;
  } catch {
    return null;
  }
}

export function authRequest(email: string): Promise<{ sent: boolean; dev_code: string | null }> {
  return fetch("/api/auth/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email }),
  }).then(async (r) => {
    if (r.status === 422) throw new Error("Enter a valid email address.");
    if (r.status === 429) {
      throw new Error((await serverDetail(r)) ?? "That's a lot of sign-in codes. Please try again in a few minutes.");
    }
    if (!r.ok) throw new Error((await serverDetail(r)) ?? `Couldn't send the code (${r.status}).`);
    return r.json();
  });
}

export function authVerify(email: string, code: string): Promise<AuthState> {
  return fetch("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, code }),
  }).then(async (r) => {
    if (r.status === 400) throw new Error("That code is invalid or expired.");
    if (r.status === 429) {
      throw new Error((await serverDetail(r)) ?? "Too many attempts. Please try again in a few minutes.");
    }
    if (!r.ok) throw new Error((await serverDetail(r)) ?? `Sign-in failed (${r.status}).`);
    return r.json();
  });
}

export function authLogout(): Promise<AuthState> {
  return fetch("/api/auth/logout", { method: "POST", credentials: "include" }).then(j<AuthState>);
}

// ---------- recipe library (persistence + versioning) ----------

export interface RecipeSummary {
  id: string;
  name: string;
  version_count: number;
  updated_at: string;
  share_token: string | null;
}

export interface SharedRecipe {
  name: string;
  script: string;
  params: unknown;
  param_values: unknown;
  inputs: unknown;
  prompt: string | null;
}

export interface RecipeDetail {
  id: string;
  name: string;
  share_token: string | null;
  current_version: {
    id: string;
    version_no: number;
    script: string;
    params: unknown;
    param_values: unknown;
    inputs: unknown;
    prompt: string | null;
  } | null;
}

export interface VersionSummary {
  id: string;
  version_no: number;
  created_at: string;
  prompt: string | null;
  params: unknown;
  param_values: unknown;
}

export interface RecipePayload {
  script: string;
  params: unknown;
  param_values: unknown;
  inputs: unknown;
  prompt?: string;
}

const JSON_HEADERS = { "content-type": "application/json" };

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  return (await r.json()) as T;
}

export function listRecipes(): Promise<RecipeSummary[]> {
  return fetch("/api/recipes", { credentials: "include" }).then(j<RecipeSummary[]>);
}

export function createRecipe(body: { name: string } & RecipePayload): Promise<RecipeDetail> {
  return fetch("/api/recipes", {
    method: "POST",
    headers: JSON_HEADERS,
    credentials: "include",
    body: JSON.stringify(body),
  }).then(j<RecipeDetail>);
}

export function addVersion(id: string, body: RecipePayload): Promise<RecipeDetail> {
  return fetch(`/api/recipes/${id}/versions`, {
    method: "POST",
    headers: JSON_HEADERS,
    credentials: "include",
    body: JSON.stringify(body),
  }).then(j<RecipeDetail>);
}

export function getRecipe(id: string): Promise<RecipeDetail> {
  return fetch(`/api/recipes/${id}`, { credentials: "include" }).then(j<RecipeDetail>);
}

export function listVersions(id: string): Promise<VersionSummary[]> {
  return fetch(`/api/recipes/${id}/versions`, { credentials: "include" }).then(j<VersionSummary[]>);
}

export function renameRecipe(id: string, name: string): Promise<RecipeDetail> {
  return fetch(`/api/recipes/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    credentials: "include",
    body: JSON.stringify({ name }),
  }).then(j<RecipeDetail>);
}

export async function deleteRecipe(id: string): Promise<void> {
  const r = await fetch(`/api/recipes/${id}`, { method: "DELETE", credentials: "include" });
  if (!r.ok) throw new Error(`Delete failed (${r.status})`);
}

// ---------- sharing ----------

export function shareRecipe(id: string): Promise<RecipeDetail> {
  return fetch(`/api/recipes/${id}/share`, { method: "POST", credentials: "include" }).then(j<RecipeDetail>);
}

export function unshareRecipe(id: string): Promise<RecipeDetail> {
  return fetch(`/api/recipes/${id}/share`, { method: "DELETE", credentials: "include" }).then(j<RecipeDetail>);
}

export async function getSharedRecipe(token: string): Promise<SharedRecipe> {
  const r = await fetch(`/api/recipes/shared/${encodeURIComponent(token)}`, { credentials: "include" });
  if (r.status === 404) throw new Error("This shared recipe wasn't found — the link may have been revoked.");
  if (!r.ok) throw new Error(`Couldn't load the shared recipe (${r.status}).`);
  return r.json();
}

// ---------- admin (all routes 404 for non-admins) ----------

export interface AdminFlags { llm_enabled: boolean; updated_at: string | null; updated_by: string | null }
export interface AdminStats { users: number; recipes: number; codes_last_hour: number }
export interface AdminUsage {
  calls: number; input_tokens: number; output_tokens: number;
  estimated_cost: number; budget: number; pct_of_budget: number;
}
export interface AdminCosts {
  month: string; total: number; currency: string;
  by_service: { service: string; amount: number }[];
  cached_at: string; error?: string | null;
}

export function adminFlags(): Promise<AdminFlags> {
  return fetch("/api/admin/flags", { credentials: "include" }).then(j<AdminFlags>);
}

export function adminSetLlm(enabled: boolean): Promise<AdminFlags> {
  return fetch("/api/admin/flags/llm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ enabled }),
  }).then(j<AdminFlags>);
}

export function adminSetBudget(usd: number): Promise<AdminUsage> {
  return fetch("/api/admin/budget", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ usd }),
  }).then(j<AdminUsage>);
}

export function adminUsage(): Promise<AdminUsage> {
  return fetch("/api/admin/usage", { credentials: "include" }).then(j<AdminUsage>);
}

export function adminStats(): Promise<AdminStats> {
  return fetch("/api/admin/stats", { credentials: "include" }).then(j<AdminStats>);
}

/** `refresh` bypasses the server-side cache (each real lookup bills ~$0.01). */
export function adminCosts(refresh = false): Promise<AdminCosts> {
  return fetch(`/api/admin/costs${refresh ? "?refresh=true" : ""}`, { credentials: "include" }).then(j<AdminCosts>);
}

/** Public service state — drives the "we're having trouble" banner. */
export function serviceStatus(): Promise<{ llm_enabled: boolean }> {
  return fetch("/api/status").then(j<{ llm_enabled: boolean }>);
}
