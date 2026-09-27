// Bounded scrollback of a session, replayed on attach so a reloaded window gets its screen back.
// Memory is capped by `maxChars`; when trimming, the head is cut after the next line break so the
// replay rarely starts in the middle of a line or an escape sequence.

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
/** OSC (`ESC ] … BEL|ESC \`), CSI (`ESC [ … final`) and two-character ESC sequences. */
const ESCAPES = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}[@-_]`, "g");

function stripEscapes(text: string): string {
  return text.replace(ESCAPES, "");
}

export class Scrollback {
  private chunks: string[] = [];
  private size = 0;

  constructor(private readonly maxChars: number) {}

  get length(): number {
    return this.size;
  }

  push(data: string): void {
    if (data.length === 0) return;
    this.chunks.push(data);
    this.size += data.length;
    if (this.size > this.maxChars) this.trim();
  }

  /**
   * Plain-text end of the output (escape sequences removed, CR normalized), for the exit report
   * (P5 test counts). Bounded by `maxChars`.
   */
  plainTail(maxChars: number): string {
    // CSI / OSC / other ESC sequences: rendering only, never content.
    const plain = stripEscapes(this.text())
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    return plain.length > maxChars ? plain.slice(plain.length - maxChars) : plain;
  }

  text(): string {
    if (this.chunks.length > 1) this.chunks = [this.chunks.join("")];
    return this.chunks[0] ?? "";
  }

  private trim(): void {
    const all = this.chunks.join("");
    let joined = all.slice(all.length - this.maxChars);
    const newline = joined.indexOf("\n");
    // Realign only when the cut fell inside a line, and only on a nearby break (a huge single line
    // is kept as is).
    const cutInsideLine = all[all.length - this.maxChars - 1] !== "\n";
    if (cutInsideLine && newline !== -1 && newline < 4_096) joined = joined.slice(newline + 1);
    this.chunks = [joined];
    this.size = joined.length;
  }
}
