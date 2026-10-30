/**
 * 打包单文件 exe：esbuild（ESM）→ SEA blob → 复制 node.exe → postject 注入。
 * 必须在 Node 26 下运行（sea-config 的 mainFormat: "module" 是 26 才有的能力）。
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { inject } from 'postject'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const major = Number(process.versions.node.split('.')[0])
if (major !== 26) {
  console.error(`需要用 Node 26 构建 exe，当前 ${process.versions.node}`)
  process.exit(1)
}

const outDir = path.join(root, 'build', 'exe')
const distDir = path.join(root, 'dist-exe')
rmSync(outDir, { recursive: true, force: true })
rmSync(distDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
mkdirSync(distDir, { recursive: true })

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

await build({
  entryPoints: [path.join(root, 'src', 'cli.tsx')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  outfile: path.join(outDir, 'app.mjs'),
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
})

writeFileSync(
  path.join(outDir, 'sea-config.json'),
  `${JSON.stringify(
    {
      main: 'app.mjs',
      mainFormat: 'module',
      output: 'sea-prep.blob',
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  )}\n`,
)

execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], {
  cwd: outDir,
  stdio: 'inherit',
})

const exePath = path.join(distDir, 'CodexMonitor.exe')
copyFileSync(process.execPath, exePath)

await inject(exePath, 'NODE_SEA_BLOB', readFileSync(path.join(outDir, 'sea-prep.blob')), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
})

const mb = (statSync(exePath).size / 1024 / 1024).toFixed(1)
console.log(`完成：${exePath}（${mb} MB）`)
