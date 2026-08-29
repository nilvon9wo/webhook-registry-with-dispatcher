/**
 * Test helper: run `fn`, return whatever it throws.
 *
 * Keeps the "Act" step of a test to a single statement when the behaviour under
 * test is expected to throw — the returned value is then inspected in "Assert":
 *
 * ```ts
 * // Act
 * const error = captureError(() => loadConfig({ PORT: 'abc' }));
 * // Assert
 * expect(error).toBeInstanceOf(ConfigError);
 * ```
 *
 * Fails loudly if `fn` does not throw, so a silently-passing call cannot be
 * mistaken for a captured error.
 */
export function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('captureError: expected the function to throw, but it returned normally.');
}
