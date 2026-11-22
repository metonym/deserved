/** The server's settings; the CLI's flags set the same keys. */
export type Options = {
  root: string;
  port: number;
  host: string;
  spa: boolean;
  watch: boolean;
  open: boolean;
  cors: boolean;
  dir: boolean;
  cache: boolean;
  compress: boolean;
  quiet: boolean;
};

/** The settings `serve()` and the CLI start from. */
export const DEFAULT_OPTIONS = {
  root: ".",
  port: 3000,
  host: "localhost",
  spa: false,
  watch: false,
  open: false,
  cors: false,
  dir: true,
  cache: false,
  compress: true,
  quiet: false,
} satisfies Options;
