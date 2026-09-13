const RATE_LIMIT_RESET_TIME_RE =
  /\bresets? (?:at )?((?:1[0-2]|[1-9])(?::[0-5]\d)? ?(?:am|pm)) \(([A-Za-z_]+(?:\/[A-Za-z_+-]+){1,2})\)/iu;

// Default replies may disclose clock/zone facts, not the surrounding provider body.
export function renderRateLimitResetCopy(raw: string): string | undefined {
  if (raw.length > 500 || /[\r\n<>{}]/u.test(raw)) {
    return undefined;
  }
  const match = raw.match(RATE_LIMIT_RESET_TIME_RE);
  if (!match) {
    return undefined;
  }
  const [, time, timeZone] = match;
  try {
    const zone = new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
    return `⚠️ Usage limit reached. Resets at ${time} (${zone}). Try again after the reset.`;
  } catch {
    return undefined;
  }
}
