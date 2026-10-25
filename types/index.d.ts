// Hand-written so publishing doesn't need tsc: `bun check` type checks
// but never emits. tests/types/public-api.ts fails `bun check` when this
// drifts from src/index.ts.

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

export declare const DEFAULT_OPTIONS: {
  root: string;
  port: number;
  host: string;
  spa: false;
  watch: false;
  open: false;
  cors: false;
  dir: true;
  cache: false;
  compress: true;
  quiet: false;
};

export type ServerHandle = {
  port: number;
  hostname: string;
  url: string;
  stop: () => Promise<void>;
};

type Handler = {
  (req: Request): Promise<Response>;
  invalidateResolutionCache(): void;
  invalidateCompressedCache(): void;
  resolutionCacheSize(): number;
  compressedCacheBytes(): number;
};

export declare class RootError extends Error {
  constructor(message: string, options?: ErrorOptions);
}

export declare class BindError extends Error {
  constructor(host: string, port: number, options?: ErrorOptions);
}

export declare function serve(
  options?: Partial<Options>,
): Promise<ServerHandle>;

export declare function createHandler(options?: Partial<Options>): Handler;

// A declaration file exports every top-level declaration unless it has an
// `export {}`, which keeps Handler private.
// biome-ignore lint/complexity/noUselessEmptyExport: not useless in a .d.ts
export {};
