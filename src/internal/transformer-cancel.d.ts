/**
 * The WHATWG Streams spec added `Transformer.cancel` (called when the
 * readable side is cancelled or the writable side aborts); Node >= 20
 * implements it but TypeScript's lib.dom does not declare it yet.
 */
interface Transformer<I, O> {
  cancel?: (reason: unknown) => void | PromiseLike<void>;
}
