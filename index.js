'use strict'
const ts = require('typescript')
const fs = require('fs')
const findRoot = require('find-root')
const os = require('os')
const path = require('path')
const process = require('process')
const semver = require('semver')
const traverse = require('babel-traverse')
const crypto = require('crypto')
const chalk = require('chalk')
const deepmerge = require('deepmerge')

let upstreamTransformer = null

const reactNativeVersionString = require('react-native/package.json').version
const reactNativeMinorVersion = semver(reactNativeVersionString).minor

if (reactNativeMinorVersion >= 73) {
  upstreamTransformer = require('@react-native/metro-babel-transformer/src/index')
} else if (reactNativeMinorVersion >= 59) {
  upstreamTransformer = require('metro-react-native-babel-transformer/src/index')
} else if (reactNativeMinorVersion >= 56) {
  upstreamTransformer = require('metro/src/reactNativeTransformer')
} else if (reactNativeMinorVersion >= 52) {
  upstreamTransformer = require('metro/src/transformer')
} else if (reactNativeMinorVersion >= 47) {
  upstreamTransformer = require('metro-bundler/src/transformer')
} else if (reactNativeMinorVersion === 46) {
  upstreamTransformer = require('metro-bundler/build/transformer')
} else {
  // handle RN <= 0.45
  const oldUpstreamTransformer = require('react-native/packager/transformer')
  upstreamTransformer = {
    transform({ src, filename, options }) {
      return oldUpstreamTransformer.transform(src, filename, options)
    },
  }
}

const { SourceMapConsumer, SourceMapGenerator } = require('source-map')

function loadJsonFile(jsonFileName) {
  try {
    const buffer = fs.readFileSync(jsonFileName)
    const jju = require('jju')
    return jju.parse(buffer.toString())
  } catch (error) {
    throw new Error(
      `Error reading "${jsonFileName}":${os.EOL}  ${error.message}`
    )
  }
}

function getFileOrModulePath(location) {
  try {
    return require.resolve(location)
  } catch (e) {}
}

function isFile(location) {
  return fs.existsSync(location)
}

// loads config file supporting recursive extendsion from files or node modules
function loadConfig(location) {
  let json
  const configPath = getFileOrModulePath(location)
  if (configPath) {
    try {
      json = loadJsonFile(configPath)
    } catch (error) {
      throw new Error(
        `Error loading config ${location}:${os.EOL}  ${error.message}`
      )
    }
  } else {
    throw new Error(`Could not load config from ${location}`)
  }

  if (typeof json.extends === 'string') {
    const relativeCandidate = path.join(
      path.dirname(configPath),
      `${json.extends}${json.extends.endsWith('.json') ? '' : '.json'}`
    )
    const extendedLocation = isFile(relativeCandidate)
      ? relativeCandidate
      : json.extends
    const extendedJson = loadConfig(extendedLocation)
    json = deepmerge(extendedJson, json, { arrayMerge: (_, source) => source })
    delete json.extends
  }
  return json
}

// only used with RN >= 52
function sourceMapAstInPlace(tsMap, babelAst) {
  const tsConsumer = new SourceMapConsumer(tsMap)
  traverse.default.cheap(babelAst, node => {
    if (node.loc) {
      const originalStart = tsConsumer.originalPositionFor(node.loc.start)
      if (originalStart.line) {
        node.loc.start.line = originalStart.line
        node.loc.start.column = originalStart.column
      }
      const originalEnd = tsConsumer.originalPositionFor(node.loc.end)
      if (originalEnd.line) {
        node.loc.end.line = originalEnd.line
        node.loc.end.column = originalEnd.column
      }
    }
  })
}

function composeRawSourceMap(tsMap, babelMap) {
  const tsConsumer = new SourceMapConsumer(tsMap)
  const composedMap = []
  babelMap.forEach(
    ([generatedLine, generatedColumn, originalLine, originalColumn, name]) => {
      if (originalLine) {
        const tsOriginal = tsConsumer.originalPositionFor({
          line: originalLine,
          column: originalColumn,
        })
        if (tsOriginal.line) {
          if (typeof name === 'string') {
            composedMap.push([
              generatedLine,
              generatedColumn,
              tsOriginal.line,
              tsOriginal.column,
              name,
            ])
          } else {
            composedMap.push([
              generatedLine,
              generatedColumn,
              tsOriginal.line,
              tsOriginal.column,
            ])
          }
        }
      }
    }
  )
  return composedMap
}

function composeSourceMaps(tsMap, babelMap, tsFileName, tsContent, babelCode) {
  const tsConsumer = new SourceMapConsumer(tsMap)
  const babelConsumer = new SourceMapConsumer(babelMap)
  const map = new SourceMapGenerator()
  map.setSourceContent(tsFileName, tsContent)
  babelConsumer.eachMapping(
    ({
      source,
      generatedLine,
      generatedColumn,
      originalLine,
      originalColumn,
      name,
    }) => {
      if (originalLine) {
        const original = tsConsumer.originalPositionFor({
          line: originalLine,
          column: originalColumn,
        })
        if (original.line) {
          map.addMapping({
            generated: {
              line: generatedLine,
              column: generatedColumn,
            },
            original: {
              line: original.line,
              column: original.column,
            },
            source: tsFileName,
            name: name,
          })
        }
      }
    }
  )
  return map.toJSON()
}

function loadTSConfig() {
  const TSCONFIG_PATH = process.env.TSCONFIG_PATH

  if (TSCONFIG_PATH) {
    const resolvedTsconfigPath = path.resolve(process.cwd(), TSCONFIG_PATH)
    if (isFile(resolvedTsconfigPath)) {
      return loadConfig(resolvedTsconfigPath)
    }
    console.warn(
      'tsconfig file specified by TSCONFIG_PATH environment variable was not found'
    )
    console.warn(`TSCONFIG_PATH = ${TSCONFIG_PATH}`)
    console.warn(`resolved = ${resolvedTsconfigPath}`)
    console.warn('looking in app root directory')
  }

  const expectedTsConfigFileName = 'tsconfig.json'

  let root
  try {
    root = findRoot(process.cwd(), dir => {
      return isFile(path.join(dir, expectedTsConfigFileName))
    })
  } catch (error) {
    console.error(`${chalk.bold(`***ERROR***`)} in react-native-typescript-transformer
  
  ${chalk.red(`  Unable to find a "${expectedTsConfigFileName}" file.`)}
  
  It should be placed at the root of your project.
        Otherwise, you can specify another location using the TSCONFIG_PATH environment variable.

`)
    process.exit(1)
  }

  const tsConfigPath = path.join(root, expectedTsConfigFileName)

  // the error message thrown by this is good enough on it's own
  return loadConfig(tsConfigPath)
}

const tsConfig = loadTSConfig()

const compilerOptions = Object.assign(tsConfig.compilerOptions, {
  sourceMap: true,
  inlineSources: true,
})

function getCacheKey() {
  const upstreamCacheKey = upstreamTransformer.getCacheKey
    ? upstreamTransformer.getCacheKey()
    : ''
  var key = crypto.createHash('md5')
  key.update(upstreamCacheKey)
  key.update(fs.readFileSync(__filename))
  key.update(JSON.stringify(tsConfig))
  return key.digest('hex')
}

function transform(src, filename, options) {
  if (typeof src === 'object') {
    // handle RN >= 0.46
    ;({ src, filename, options } = src)
  }

  if (filename.endsWith('.ts') || filename.endsWith('.tsx')) {
    const tsCompileResult = ts.transpileModule(src, {
      compilerOptions,
      fileName: filename,
      reportDiagnostics: true,
    })

    const errors = tsCompileResult.diagnostics.filter(
      ({ category }) => category === ts.DiagnosticCategory.Error
    )

    if (errors.length) {
      // report first error
      const error = errors[0]
      const message = ts.flattenDiagnosticMessageText(error.messageText, '\n')
      if (error.file) {
        let { line, character } = error.file.getLineAndCharacterOfPosition(
          error.start
        )
        if (error.file.fileName === 'module.ts') {
          console.error({
            error,
            filename,
            options,
          })
        }
        throw new Error(
          `${error.file.fileName} (${line + 1},${character + 1}): ${message}`
        )
      } else {
        throw new Error(message)
      }
    }

    const babelCompileResult = upstreamTransformer.transform({
      src: tsCompileResult.outputText,
      filename,
      options,
    })

    if (reactNativeMinorVersion >= 52) {
      sourceMapAstInPlace(tsCompileResult.sourceMapText, babelCompileResult.ast)
      return babelCompileResult
    }

    const composedMap = Array.isArray(babelCompileResult.map)
      ? composeRawSourceMap(
          tsCompileResult.sourceMapText,
          babelCompileResult.map
        )
      : composeSourceMaps(
          tsCompileResult.sourceMapText,
          babelCompileResult.map,
          filename,
          src,
          babelCompileResult.code
        )

    return Object.assign({}, babelCompileResult, {
      map: composedMap,
    })
  } else {
    return upstreamTransformer.transform({
      src,
      filename,
      options,
    })
  }
}

module.exports = {
  getCacheKey,
  loadTSConfig,
  transform,
}
