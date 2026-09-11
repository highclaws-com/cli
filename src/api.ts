import { getUserConfig } from "./config"

export function hostBase(host: string): string {
  const base = /^https?:\/\//.test(host) ? host : `https://${host}`
  return base.replace(/\/+$/, "")
}

// Authenticated request that returns the response JSON pretty-printed as-is.
export async function apiRequest(
  url: string,
  method = "GET",
  body?: unknown
): Promise<string> {
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
  if (!res.ok) throw new Error(`${url} failed: HTTP ${res.status}`)
  return JSON.stringify(await res.json(), null, 2)
}
