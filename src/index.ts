#!/usr/bin/env node
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { loadConfig, runInteractiveInit, configExists, getConfigPath } from "./config";
import { runMonitor } from "./monitor";
import { SlackNotifier, BroadcastNotifier } from "./notifier";
import { fetchUsage } from "./claudeClient";

const LOG_PATH = path.join(os.homedir(), ".config", "claude-watcher", "watcher.log");

const COMMANDS = ["init", "start", "status", "stop", "logs", "test-notify", "help"] as const;
type Command = (typeof COMMANDS)[number];

const [, , rawCommand = "start"] = process.argv;
const command = COMMANDS.includes(rawCommand as Command) ? (rawCommand as Command) : "help";
const args = process.argv.slice(3);

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

      const showLogs = args.includes("--logs");
      const isDaemon = args.includes("--daemon");

      if (!showLogs && !isDaemon) {
        // Spawn a detached background process that writes to the log file
        fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
        const logFd = fs.openSync(LOG_PATH, "a");

        const child = spawn(process.execPath, [__filename, "start", "--daemon"], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          windowsHide: true,
        });
        child.unref();
        fs.closeSync(logFd);

        console.log("claude-watcher running in background.");
        console.log(`Logs  → ${LOG_PATH}`);
        console.log(`Stop  → claude-watcher stop`);
        break;
      }

      // --logs or --daemon: run the monitor directly in this process
      const config = loadConfig();
      const notifier = new BroadcastNotifier([new SlackNotifier(config.slack_webhook_url)]);
      await runMonitor(config, notifier);
      break;
    }

    case "test-notify": {
      const config = loadConfig();
      const notifier = new SlackNotifier(config.slack_webhook_url);
      try {
        await notifier.notify(
          "Test message from claude-watcher — if you see this, your Slack webhook is working correctly.",
          { window: "five_hour", utilization_before: 89, utilization_after: 2, resets_at: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString() }
        );
        console.log("Test notification sent. Check your Slack channel.");
      } catch (err) {
        die("Failed to send test notification:", err);
      }
      break;
    }

    case "stop": {
      // Locate and kill any background claude-watcher daemon
      try {
        const { execSync } = await import("child_process");
        // Works on Windows (wmic) and Unix (pgrep)
        if (process.platform === "win32") {
          // wmic is deprecated on Windows 11 22H2+ — use Get-CimInstance instead.
          // Filter by Name=node.exe to avoid the query's own PowerShell process
          // self-matching (its command line contains the search strings as literals).
          const out = execSync(
            `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*claude-watcher*' -and $_.CommandLine -like '*--daemon*' } | Select-Object -ExpandProperty ProcessId"`,
            { encoding: "utf-8" }
          );
          const pids = out.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l));
          if (!pids.length) { console.log("claude-watcher is not running."); break; }
          pids.forEach((pid) => execSync(`taskkill /PID ${pid} /F`));
        } else {
          execSync(`pkill -f "claude-watcher.*--daemon"`);
        }
        console.log("claude-watcher stopped.");
      } catch {
        console.log("claude-watcher is not running.");
      }
      break;
    }

    case "logs": {
      if (!fs.existsSync(LOG_PATH)) {
        console.error(`No log file found at ${LOG_PATH}. Has the monitor been started yet?`);
        process.exit(1);
      }
      // Tail the log file — Ctrl+C to exit
      console.log(`Tailing ${LOG_PATH}  (Ctrl+C to stop)\n`);
      const tail = spawn(
        process.platform === "win32" ? "powershell" : "tail",
        process.platform === "win32"
          ? ["-Command", `Get-Content '${LOG_PATH}' -Tail 20 -Wait`]
          : ["-f", "-n", "20", LOG_PATH],
        { stdio: "inherit" }
      );
      await new Promise<void>((resolve, reject) => {
        tail.on("error", reject);
        tail.on("close", resolve);
      });
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
    init          Interactive setup (session key, org ID, Slack webhook)
    start         Start in background — silent, writes to log file
    start --logs  Start in terminal with live log output
    stop          Stop the background process
    logs          Tail the log file (Ctrl+C to exit)
    status        One-shot usage snapshot
    test-notify   Send a test message to your Slack channel
    help          Show this help text

  Config file: ${getConfigPath()}
  Log file:    ${LOG_PATH}
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
