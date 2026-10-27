/** An error caused by how the tool was called (flags, refs, config): the CLI exits with 2. */
export function usageError(message) {
  return Object.assign(new Error(message), { code: 'USAGE' });
}
