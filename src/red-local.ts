/** Which network origins and Host headers the control API accepts. Pure functions, no sockets. */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV4_MAPPED_PREFIX = "::ffff:";

function parseIPv4(text: string): [number, number, number, number] | undefined {
  const match = IPV4.exec(text);
  if (match === null) {
    return undefined;
  }
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return undefined;
  }
  return octets as [number, number, number, number];
}

/** 10/8, 172.16/12 or 192.168/16. */
export function isPrivateIPv4(text: string): boolean {
  const octets = parseIPv4(text);
  if (octets === undefined) {
    return false;
  }
  const [first, second] = octets;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

/** Loopback, private ranges or Tailscale (100.64/10), also in their IPv4-mapped IPv6 form. */
export function isAllowedOrigin(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) {
    return false;
  }
  if (remoteAddress === "::1") {
    return true;
  }
  const address = remoteAddress.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)
    ? remoteAddress.slice(IPV4_MAPPED_PREFIX.length)
    : remoteAddress;
  const octets = parseIPv4(address);
  if (octets === undefined) {
    return false;
  }
  const [first, second] = octets;
  return first === 127 || isPrivateIPv4(address) || (first === 100 && second >= 64 && second <= 127);
}

/** Local names, the one `tailscale serve` forwards, or a private IPv4 with its port. Else suggests DNS rebinding. */
const NAMED_HOST = /^(127\.0\.0\.1|localhost|([a-z0-9-]+\.)+ts\.net)(:\d{1,5})?$/i;
const IPV4_HOST_WITH_PORT = /^([\d.]+):\d{1,5}$/;

export function isAllowedHost(host: string): boolean {
  if (NAMED_HOST.test(host)) {
    return true;
  }
  const address = IPV4_HOST_WITH_PORT.exec(host)?.[1];
  return address !== undefined && isPrivateIPv4(address);
}
