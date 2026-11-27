export const DEFAULT_MAX_JOBS_PER_WINDOW = 5;
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

/** Replies sent without processing anything: a burst of messages must not get a burst of answers. */
const MAX_NOTICES_PER_WINDOW = 3;

export type Notice = "ayuda" | "no-es-video" | "ajustes" | "ocupado" | "limite";

export type GateDecision = "started" | "busy" | "rate-limited";

export interface JobGateOptions {
  readonly maxJobsPerWindow?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
}

/**
 * Per-sender admission control: one job at a time and at most `maxJobsPerWindow`
 * jobs per sliding window.
 */
export class JobGate {
  private readonly active = new Set<string>();
  private readonly starts = new Map<string, number[]>();
  private readonly notices = new Map<string, { readonly notice: Notice; readonly at: number }[]>();
  private readonly maxJobsPerWindow: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: JobGateOptions = {}) {
    this.maxJobsPerWindow = options.maxJobsPerWindow ?? DEFAULT_MAX_JOBS_PER_WINDOW;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  tryStart(sender: string): GateDecision {
    if (this.active.has(sender)) {
      return "busy";
    }
    const current = this.now();
    const recent = (this.starts.get(sender) ?? []).filter((at) => current - at < this.windowMs);
    if (recent.length >= this.maxJobsPerWindow) {
      this.starts.set(sender, recent);
      return "rate-limited";
    }
    recent.push(current);
    this.starts.set(sender, recent);
    this.active.add(sender);
    return "started";
  }

  /** One reply of each kind per chat and window, with a small overall cap. */
  tryNotice(chat: string, notice: Notice): boolean {
    const current = this.now();
    const recent = (this.notices.get(chat) ?? []).filter((sent) => current - sent.at < this.windowMs);
    const allowed = recent.length < MAX_NOTICES_PER_WINDOW && !recent.some((sent) => sent.notice === notice);
    if (allowed) {
      recent.push({ notice, at: current });
    }
    this.notices.set(chat, recent);
    return allowed;
  }

  finish(sender: string): void {
    this.active.delete(sender);
  }
}
