// Checked by `bun check`, never run: each line fails to type check when
// types/index.d.ts drifts from what src/index.ts actually exports.

import type * as Src from "../../src/index";
import type * as Dts from "../../types/index";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

function expectTrue<_ extends true>(): void {}

expectTrue<Equal<keyof typeof Src, keyof typeof Dts>>();
expectTrue<Equal<Src.Options, Dts.Options>>();
expectTrue<Equal<typeof Src.DEFAULT_OPTIONS, typeof Dts.DEFAULT_OPTIONS>>();
expectTrue<Equal<Src.ServerHandle, Dts.ServerHandle>>();
expectTrue<Equal<typeof Src.RootError, typeof Dts.RootError>>();
expectTrue<Equal<typeof Src.BindError, typeof Dts.BindError>>();
expectTrue<Equal<typeof Src.serve, typeof Dts.serve>>();

// createHandler's second parameter (the live-reload hub) is internal, so
// the declaration leaves it out; everything else must match.
expectTrue<
  Equal<
    Parameters<typeof Src.createHandler>[0],
    Parameters<typeof Dts.createHandler>[0]
  >
>();
expectTrue<
  Equal<
    ReturnType<typeof Src.createHandler>,
    ReturnType<typeof Dts.createHandler>
  >
>();
