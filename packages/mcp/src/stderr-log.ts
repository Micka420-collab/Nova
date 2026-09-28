// Bounded ring buffer of a server's stderr lines. Raw lines stay in the process that spawned the
// server (which already holds its secrets); every read is redacted before leaving it.
import { redactSecrets } from "@nova/shared";

const DEFAULT_MAX_LINES = 200;
const MAX_LINE_CHARS = 2_000;
/** Shorter values are too likely to appear by chance to be masked usefully. */
const MIN_SECRET_LENGTH = 4;

export class StderrLog {
  private readonly lines: string[] = [];
  private partial = "";

  constructor(
    private readonly secretValues: readonly string[] = [],
    private readonly maxLines = DEFAULT_MAX_LINES,
  ) {}

  append(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = (parts.pop() ?? "").slice(-MAX_LINE_CHARS);
    for (const line of parts) this.push(line);
  }

  /** Last `count` lines, redacted (known secret values and generic secret shapes). */
  tail(count = 50): string {
    const lines = this.partial ? [...this.lines, this.partial] : this.lines;
    return this.redact(lines.slice(-count).join("\n"));
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secretValues) {
      if (secret.length >= MIN_SECRET_LENGTH) out = out.split(secret).join("[secret masqué]");
    }
    return redactSecrets(out);
  }

  private push(line: string): void {
    this.lines.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
  }
}
