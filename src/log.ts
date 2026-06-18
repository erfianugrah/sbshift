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

export const log = {
  step(name: string) {
    process.stdout.write(
      `\n${COLORS.cyan}━━ ${name} ${COLORS.reset}${COLORS.dim}${ts()}${COLORS.reset}\n`,
    );
  },
  info(msg: string) {
    process.stdout.write(`${COLORS.dim}${ts()}${COLORS.reset} ${msg}\n`);
  },
  ok(msg: string) {
    process.stdout.write(`${COLORS.green}✓${COLORS.reset} ${msg}\n`);
  },
  warn(msg: string) {
    process.stdout.write(`${COLORS.yellow}⚠${COLORS.reset} ${msg}\n`);
  },
  err(msg: string) {
    process.stderr.write(`${COLORS.red}✗${COLORS.reset} ${msg}\n`);
  },
  detail(msg: string) {
    process.stdout.write(`  ${COLORS.dim}${msg}${COLORS.reset}\n`);
  },
};
