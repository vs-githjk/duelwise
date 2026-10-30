/** Writes `text` to stdout and exits 0 only once it has drained; a bare write-then-exit cuts large output short while the exit code stays 0. */
export function writeStdoutAndExit(text: string): void {
  process.stdout.write(text, () => process.exit(0))
}
