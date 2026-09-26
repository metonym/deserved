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
