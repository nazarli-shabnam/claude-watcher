import type { Notifier, UsageResponse, WatcherConfig, WindowKey } from "./types";
import { fetchUsage } from "./claudeClient";

// A real reset pushes resets_at forward by 5 hours (5h window) or 7 days (7d window).
// We use 1 hour as the minimum threshold to ignore minor API timestamp fluctuations
// while still catching every legitimate reset.
const RESET_WINDOW_MIN_MS = 60 * 60 * 1000;

interface WindowState {
  lastResetsAt: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ts(): string {
  return new Date().toISOString();
}

function humanDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

async function checkOnce(
  config: WatcherConfig,
  state: Map<WindowKey, WindowState>,
  notifier: Notifier
): Promise<UsageResponse> {
  const usage = await fetchUsage(config);

  const windows = [
    { key: "five_hour" as WindowKey, data: usage.five_hour, label: "5-hour window" },
    { key: "seven_day" as WindowKey, data: usage.seven_day, label: "7-day window" },
  ];

  for (const { key, data, label } of windows) {
    const prev = state.get(key);

    if (!prev) {
      // First poll — just record baseline, never fire on startup
      state.set(key, { lastResetsAt: data.resets_at });
      continue;
    }

    const prevMs = new Date(prev.lastResetsAt).getTime();
    const currMs = new Date(data.resets_at).getTime();
    const delta = currMs - prevMs;

    // Only signal we trust: resets_at moved forward by at least 1 hour
    if (delta > RESET_WINDOW_MIN_MS) {
      console.log(`[${ts()}] RESET DETECTED — ${label}. Sending notification.`);

      await notifier.notify(
        `*${label} has reset!* Your Claude usage window just refreshed — you're back at full capacity.\n` +
        `Next reset scheduled for: ${humanDate(data.resets_at)}`,
        {
          window: key,
          utilization_before: usage[key].utilization,
          utilization_after: data.utilization,
          resets_at: data.resets_at,
        }
      );
    }

    // Always update — next poll compares against the latest resets_at
    state.set(key, { lastResetsAt: data.resets_at });
  }

  return usage;
}

export async function runMonitor(config: WatcherConfig, notifier: Notifier): Promise<never> {
  const state = new Map<WindowKey, WindowState>();
  const intervalMs = config.check_interval_minutes * 60 * 1000;

  console.log(`[${ts()}] claude-watcher started — polling every ${config.check_interval_minutes} min`);

  while (true) {
    try {
      const usage = await checkOnce(config, state, notifier);
      console.log(
        `[${ts()}] ` +
        `5h: ${usage.five_hour.utilization}% (resets ${humanDate(usage.five_hour.resets_at)})  |  ` +
        `7d: ${usage.seven_day.utilization}% (resets ${humanDate(usage.seven_day.resets_at)})`
      );
    } catch (err) {
      console.error(`[${ts()}] ERROR:`, err instanceof Error ? err.message : String(err));
    }

    await sleep(intervalMs);
  }
}
