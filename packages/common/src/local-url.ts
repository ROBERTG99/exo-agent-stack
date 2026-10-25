// Where a service may be reached when a credential goes with the request (BUILD.md rail 3: loopback
// only). A URL is local if its host is a loopback address, `localhost`, or one of a few names that
// are known to be local: by default the compose service `stackd`. No other name qualifies, not even
// a name without dots, because a DNS search domain can resolve it to another machine. Any other IP,
// userinfo and any scheme but http(s) are refused.
export const LOCAL_SERVICE_NAMES = ["stackd"];

export function isLocalServiceUrl(
  text: string,
  names: readonly string[] = LOCAL_SERVICE_NAMES,
): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase();
  if (host === "[::1]" || host === "::1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return host === "localhost" || names.map((n) => n.toLowerCase()).includes(host);
}
