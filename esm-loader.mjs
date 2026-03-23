import { resolve as pathResolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Custom ESM loader that appends .js extensions to extensionless imports
 * within @yellow-org/sdk package (which uses extensionless ESM imports).
 */
export async function resolve(specifier, context, nextResolve) {
  // Only handle relative imports within @yellow-org/sdk
  if (
    context.parentURL?.includes('@yellow-org/sdk') &&
    specifier.startsWith('.')
  ) {
    // Try appending .js
    const withJs = specifier + '.js';
    try {
      return await nextResolve(withJs, context);
    } catch {
      // Try as directory with /index.js
      const withIndex = specifier + '/index.js';
      try {
        return await nextResolve(withIndex, context);
      } catch {
        // Fall through to default
      }
    }
  }

  return nextResolve(specifier, context);
}
