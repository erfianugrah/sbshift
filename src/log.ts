/** Minimal structured logger with level colours. No deps. */

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
} as const;

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

// Non-error logs go here; flipped to stderr by `log.toStderr()` so a command
// emitting machine-readable JSON on stdout (e.g. `run --json`) stays parseable.
let out: NodeJS.WriteStream = process.stdout;

export const log = {
  /** Route all human logs to stderr, keeping stdout for machine output. */
  toStderr() {
    out = process.stderr;
  },
  step(name: string) {
    out.write(`\n${COLORS.cyan}━━ ${name} ${COLORS.reset}${COLORS.dim}${ts()}${COLORS.reset}\n`);
  },
  info(msg: string) {
    out.write(`${COLORS.dim}${ts()}${COLORS.reset} ${msg}\n`);
  },
  ok(msg: string) {
    out.write(`${COLORS.green}✓${COLORS.reset} ${msg}\n`);
  },
  warn(msg: string) {
    out.write(`${COLORS.yellow}⚠${COLORS.reset} ${msg}\n`);
  },
  err(msg: string) {
    process.stderr.write(`${COLORS.red}✗${COLORS.reset} ${msg}\n`);
  },
  detail(msg: string) {
    out.write(`  ${COLORS.dim}${msg}${COLORS.reset}\n`);
  },
};
