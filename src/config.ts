import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import type { WatcherConfig } from "./types";

const CONFIG_DIR = path.join(os.homedir(), ".config", "claude-watcher");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  check_interval_minutes: 15,
} satisfies Partial<WatcherConfig>;

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

export function loadConfig(): WatcherConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found at ${CONFIG_PATH}. Run \`claude-watcher init\` to set up.`);
  }

  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const parsed = JSON.parse(raw) as Partial<WatcherConfig>;

  assertField(parsed, "session_key");
  assertField(parsed, "org_id");
  assertField(parsed, "slack_webhook_url");

  return { ...DEFAULTS, ...parsed } as WatcherConfig;
}

export function saveConfig(config: WatcherConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // 0o600 = owner read/write only — protects the session key
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ─── Interactive init ─────────────────────────────────────────────────────────

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

export async function runInteractiveInit(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("\n  claude-watcher — first-time setup\n");
    console.log("  Find your session key in browser DevTools → Application → Cookies → claude.ai → sessionKey");
    console.log("  Find your org_id in any authenticated request to claude.ai/api/organizations/<uuid>\n");

    const session_key       = (await prompt(rl, "  Session key (sk-ant-sid01-...): ")).trim();
    const org_id            = (await prompt(rl, "  Organization UUID:              ")).trim();
    const slack_webhook_url = (await prompt(rl, "  Slack webhook URL:              ")).trim();
    const intervalRaw       = (await prompt(rl, "  Check interval in minutes [15]: ")).trim();

    const check_interval_minutes = intervalRaw === "" ? 15 : parseInt(intervalRaw, 10);
    if (isNaN(check_interval_minutes) || check_interval_minutes < 1) {
      throw new Error("Interval must be a positive integer.");
    }

    saveConfig({ session_key, org_id, slack_webhook_url, check_interval_minutes });
    console.log(`\n  Config saved to ${CONFIG_PATH}\n`);
  } finally {
    rl.close();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function assertField(obj: Partial<WatcherConfig>, key: keyof WatcherConfig): void {
  if (!obj[key]) {
    throw new Error(`Config is missing required field: "${key}". Re-run \`claude-watcher init\`.`);
  }
}
