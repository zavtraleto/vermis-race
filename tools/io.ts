// I/O handed to TS tools by tools/run-ts.mjs (keeps the tools free of node typings).
export interface Io {
  argv: string[];
  read(path: string): string;
  write(path: string, text: string): void;
  exists(path: string): boolean;
  list(dir: string): string[];
  log(line: string): void;
}

/** Value of `--name N` or `--name=N`, else undefined. */
export function argValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}
