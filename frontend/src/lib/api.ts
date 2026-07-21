// Talks to the backend. In dev, Vite proxies /api to FastAPI; in prod, nginx does.
// Recipe generation is an agent loop — see src/lib/agent.ts (it owns /api/generate).

/** Strip fenced code blocks from streamed narration for display. */
export function explanationOnly(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- auth (passwordless email code) ----------

export function authMe(): Promise<{ email: string | null }> {
  return fetch("/api/auth/me", { credentials: "include" }).then(j<{ email: string | null }>);
}

export function authRequest(email: string): Promise<{ sent: boolean; dev_code: string | null }> {
  return fetch("/api/auth/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email }),
  }).then(async (r) => {
    if (r.status === 422) throw new Error("Enter a valid email address.");
    if (!r.ok) throw new Error(`Couldn't send the code (${r.status}).`);
    return r.json();
  });
}

export function authVerify(email: string, code: string): Promise<{ email: string | null }> {
  return fetch("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, code }),
  }).then(async (r) => {
    if (r.status === 400) throw new Error("That code is invalid or expired.");
    if (!r.ok) throw new Error(`Sign-in failed (${r.status}).`);
    return r.json();
  });
}

export function authLogout(): Promise<{ email: string | null }> {
  return fetch("/api/auth/logout", { method: "POST", credentials: "include" }).then(
    j<{ email: string | null }>,
  );
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
