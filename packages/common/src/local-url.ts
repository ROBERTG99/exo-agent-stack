// Where a service may be reached when a credential goes with the request (BUILD.md rail 3: loopback
// only). A URL is local if its host is a loopback address or a single-label name such as the compose
// service `stackd`, which resolves only on the local network. Anything with a dot that is not an
// IPv4 loopback address, any other IP, userinfo, and any scheme but http(s) is refused.
export function isLocalServiceUrl(text: string): boolean {
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
  return host !== "" && !host.includes(".") && !host.includes(":") && host !== "0";
}
