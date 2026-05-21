import type { Notifier, UsageResponse, WatcherConfig, WindowKey } from "./types";
import { fetchUsage } from "./claudeClient";

// Utilization must drop below this threshold to be considered "reset"
const RESET_THRESHOLD_PCT = 5;

interface WindowState {
  lastUtilization: number;
  // Prevents firing the same reset notification twice if we poll while still at 0%
  resetFired: boolean;
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
    const prev: WindowState = state.get(key) ?? { lastUtilization: 0, resetFired: false };
    const current = data.utilization;

    const wasAboveThreshold = prev.lastUtilization >= RESET_THRESHOLD_PCT;
    const isNowBelowThreshold = current < RESET_THRESHOLD_PCT;
    const shouldFire = wasAboveThreshold && isNowBelowThreshold && !prev.resetFired;

    if (shouldFire) {
      const message =
        `*${label} has reset!* Your Claude usage window just refreshed — you\'re back at full capacity.\n` +
        `Next reset scheduled for: ${humanDate(data.resets_at)}`;

      console.log(`[${ts()}] RESET DETECTED — ${label}. Sending notification.`);

      await notifier.notify(message, {
        window: key,
        utilization_before: prev.lastUtilization,
        utilization_after: current,
        resets_at: data.resets_at,
      });

      state.set(key, { lastUtilization: current, resetFired: true });
    } else {
      state.set(key, {
        lastUtilization: current,
        // Once usage climbs again it's a fresh session — arm the trigger for the next reset
        resetFired: isNowBelowThreshold ? prev.resetFired : false,
      });
    }
  }

  return usage;
}

export async function runMonitor(config: WatcherConfig, notifier: Notifier): Promise<never> {
  const state = new Map<WindowKey, WindowState>();
  const intervalMs = config.check_interval_minutes * 60 * 1000;

  console.log(`[${ts()}] claude-watcher started — polling every ${config.check_interval_minutes} min`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const usage = await checkOnce(config, state, notifier);
      console.log(
        `[${ts()}] ` +
        `5h: ${usage.five_hour.utilization}% (resets ${humanDate(usage.five_hour.resets_at)})  |  ` +
        `7d: ${usage.seven_day.utilization}% (resets ${humanDate(usage.seven_day.resets_at)})`
      );
    } catch (err) {
      // Non-fatal: log and keep looping — transient network/auth errors shouldn't kill the process
      console.error(`[${ts()}] ERROR:`, err instanceof Error ? err.message : String(err));
    }

    await sleep(intervalMs);
  }
}
