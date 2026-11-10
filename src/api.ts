import { getUserConfig } from "./config"

export function hostBase(host: string): string {
  const base = /^https?:\/\//.test(host) ? host : `https://${host}`
  return base.replace(/\/+$/, "")
}

// Authenticated request that returns the parsed response JSON.
export async function apiJson(url: string, method = "GET", body?: unknown): Promise<any> {
  const auth = getUserConfig("auth")
  if (!auth) throw new Error("not logged in: run `hc auth login`")
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      Cookie: `JWT_Token=${auth.jwt}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual"
  })
  if (res.status === 401) {
    throw new Error("login expired: run `hc auth login`")
  } else if (!res.ok) {
    throw new Error(`${url} failed: HTTP ${res.status} ${await res.text()}`)
  }
  return res.json()
}

// Authenticated request that returns the response JSON pretty-printed as-is.
export async function apiRequest(
  url: string,
  method = "GET",
  body?: unknown
): Promise<string> {
  return JSON.stringify(await apiJson(url, method, body), null, 2)
}
