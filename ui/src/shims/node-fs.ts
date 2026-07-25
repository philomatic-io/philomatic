/** Browser stand-in for node:fs (demo build only): the engine's fs paths are gated behind
 *  file-backed stores, which a browser engine never is — reaching past existsSync is a bug. */
export const existsSync = (): boolean => false;
const unavailable = (): never => {
  throw new Error('node:fs is not available in the browser demo');
};
export const mkdirSync = unavailable;
export const readFileSync = unavailable;
export const renameSync = unavailable;
export const writeFileSync = unavailable;
