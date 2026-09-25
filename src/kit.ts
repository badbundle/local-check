import type { Kit } from "./config.ts";
import { waitFor } from "./wait.ts";
import { xcode } from "./xcode.ts";

/** Handed to a config function, so configs never import this package at runtime. */
export const kit: Kit = { xcode, waitFor };
