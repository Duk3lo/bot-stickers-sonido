const PRIVATE_CHAT_SERVER = "s.whatsapp.net";

/**
 * Extracts the phone digits from a private-chat JID.
 * Handles device suffixes ("34600111222:12@s.whatsapp.net") and returns undefined for
 * anything that is not a private chat (groups, broadcasts, LIDs, ...).
 */
export function phoneFromJid(jid: string | null | undefined): string | undefined {
  if (!jid) {
    return undefined;
  }
  const at = jid.indexOf("@");
  if (at <= 0 || jid.slice(at + 1) !== PRIVATE_CHAT_SERVER) {
    return undefined;
  }
  const user = jid.slice(0, at);
  const phone = user.split(":")[0] ?? "";
  return /^\d+$/.test(phone) ? phone : undefined;
}

/** True only when the JID belongs to a private chat whose number is in the allowlist. */
export function isAllowedJid(jid: string | null | undefined, allowedNumbers: ReadonlySet<string>): boolean {
  const phone = phoneFromJid(jid);
  return phone !== undefined && allowedNumbers.has(phone);
}
