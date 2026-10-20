/** Shared by the framework helpers: a clear error when a peer dependency is missing. */

export class MissingDependencyError extends Error {
  readonly code = "ERR_PRECLEARED_MISSING_DEPENDENCY";
  readonly packageName: string;

  constructor(entry: string, packageName: string, versionHint: string, cause: unknown) {
    super(
      `${entry} needs the "${packageName}" package (${versionHint}). Install it with: npm install ${packageName}`,
      { cause },
    );
    this.name = "MissingDependencyError";
    this.packageName = packageName;
  }
}

/** Load an optional peer dependency, turning a failed import into a `MissingDependencyError`. */
export async function loadPeer<T>(entry: string, packageName: string, versionHint: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (cause) {
    throw new MissingDependencyError(entry, packageName, versionHint, cause);
  }
}
