/**
 * Load TypeScript modules for Options Surface chart tests.
 * Resolves extensionless relative imports and strips types.
 */
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(new URL('../package.json', import.meta.url))
const ts = require('typescript')
const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      specifier = pathToFileURL(resolve(srcRoot, specifier.slice(2))).href
      if (!specifier.endsWith('.ts') && !specifier.endsWith('.js')) {
        specifier += '.ts'
      }
      return { url: specifier, shortCircuit: true }
    }
    if (
      context.parentURL
      && (specifier.startsWith('./') || specifier.startsWith('../'))
      && !specifier.endsWith('.ts')
      && !specifier.endsWith('.js')
      && !specifier.endsWith('.mjs')
      && !specifier.endsWith('.json')
    ) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      const source = readFileSync(fileURLToPath(url), 'utf8')
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        fileName: fileURLToPath(url),
      })
      return { format: 'module', source: outputText, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
