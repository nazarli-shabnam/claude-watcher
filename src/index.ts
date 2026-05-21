#!/usr/bin/env node
import { loadConfig, runInteractiveInit, configExists, getConfigPath } from "./config";
import { runMonitor } from "./monitor";
import { SlackNotifier, BroadcastNotifier } from "./notifier";
import { fetchUsage } from "./claudeClient";

const COMMANDS = ["init", "start", "status", "help"] as const;
type Command = (typeof COMMANDS)[number];

const [, , rawCommand = "start"] = process.argv;
const command = COMMANDS.includes(rawCommand as Command) ? (rawCommand as Command) : "help";

async function main(): Promise<void> {
  switch (command) {
    case "init":
      await runInteractiveInit();
      break;

    case "status": {
      const config = loadConfig();
      try {
        const usage = await fetchUsage(config);
        console.log("\n  Claude usage snapshot\n");
        console.log(`  5-hour:  ${pad(usage.five_hour.utilization)}%  →  resets ${fmtDate(usage.five_hour.resets_at)}`);
        console.log(`  7-day:   ${pad(usage.seven_day.utilization)}%  →  resets ${fmtDate(usage.seven_day.resets_at)}`);
        console.log();
      } catch (err) {
        die("Failed to fetch usage:", err);
      }
      break;
    }

    case "start": {
      if (!configExists()) {
        console.error(`No config found at ${getConfigPath()}.\nRun \`claude-watcher init\` first.`);
        process.exit(1);
      }
      const config = loadConfig();

      // Build the notifier chain. Add more channels here as you implement them.
      const notifiers = [new SlackNotifier(config.slack_webhook_url)];
      const notifier = new BroadcastNotifier(notifiers);

      // runMonitor loops forever — this is intentional for a background service
      await runMonitor(config, notifier);
      break;
    }

    case "help":
    default:
      printHelp();
  }
}

function printHelp(): void {
  console.log(`
  claude-watcher — Claude Code usage limit monitor

  Commands:
    init      Interactive setup (session key, org ID, Slack webhook)
    status    One-shot usage snapshot — prints current utilization and reset times
    start     Start the background polling loop (default command)
    help      Show this help text

  Config file: ${getConfigPath()}

  Run as a background service:
    # Unix / macOS
    nohup claude-watcher start > ~/.config/claude-watcher/watcher.log 2>&1 &

    # Windows (PowerShell)
    Start-Process -NoNewWindow -FilePath "claude-watcher" -ArgumentList "start" \`
      -RedirectStandardOutput "$env:USERPROFILE\\.config\\claude-watcher\\watcher.log"
  `);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function pad(n: number): string {
  return String(n).padStart(3, " ");
}

function die(msg: string, err?: unknown): never {
  const detail = err instanceof Error ? err.message : String(err ?? "");
  console.error(detail ? `${msg} ${detail}` : msg);
  process.exit(1);
}

main().catch((err) => die("Fatal error:", err));
