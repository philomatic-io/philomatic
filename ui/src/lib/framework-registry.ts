/**
 * The ACTIVE framework list — the one runtime source every declaration
 * reader derives from. Boots as the baked built-ins (so everything works before any client
 * answers), and swaps to the library's full vocabulary — built-ins + the personal framework +
 * installed imports — when the workbench loads it. The rule libs (edge-families, relations)
 * cache their derived maps against `frameworksVersion()`, so a save in the editor re-styles
 * the maps and dropdowns on the next render with no reload.
 */
import { FRAMEWORKS } from '../generated/framework';
import type { FrameworkFile, FrameworksView, ViewOverrides } from '../client/types';

const NO_OVERRIDES: ViewOverrides = { tags: {}, types: {} };

let active: readonly FrameworkFile[] = FRAMEWORKS as unknown as readonly FrameworkFile[];
let overrides: ViewOverrides = NO_OVERRIDES;
let version = 1;

export const activeFrameworks = (): readonly FrameworkFile[] => active;
export const activeViewOverrides = (): ViewOverrides => overrides;
export const frameworksVersion = (): number => version;

export function setActiveFrameworks(list: readonly FrameworkFile[], view?: ViewOverrides): void {
  active = list;
  overrides = view ?? NO_OVERRIDES;
  version += 1;
}

/** Core is always ambient; every other built-in is OPT-IN. */
export const CORE_FRAMEWORK = 'philomatic-core';

/** One place turns a client's FrameworksView into the active state (App boot, editor saves):
 *  core + the built-ins this library turned on + the personal framework + installs. Public
 *  surfaces never call this, so they keep the full baked set for rendering others' content. */
export function activeList(v: FrameworksView): FrameworkFile[] {
  const on = new Set(v.enabledBuiltins);
  const off = new Set(v.disabledInstalled);
  const builtins = v.builtin.filter((f) => f.framework === CORE_FRAMEWORK || on.has(f.framework));
  const installed = v.installed.filter((f) => !off.has(f.framework));
  return [...builtins, ...(v.mine !== undefined ? [v.mine] : []), ...installed];
}

export function applyFrameworksView(v: FrameworksView): void {
  setActiveFrameworks(activeList(v), v.viewOverrides);
}
