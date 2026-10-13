// Store build + zip for the Chrome Web Store:
//   pnpm package  →  release/tricobot-gmail-<version>.zip
//
// The store refuses an upload whose version isn't higher than the published
// one, so this refuses to overwrite an existing zip: bump "version" in
// package.json first. Dependency-free zip writer (deflate + crc32 from zlib).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const out = `release/tricobot-gmail-${version}.zip`

if (existsSync(out)) {
  console.error(`${out} already exists — bump "version" in package.json before packaging.`)
  process.exit(1)
}

execFileSync(process.execPath, ['build.mjs', '--store'], { stdio: 'inherit' })

function filesUnder(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

const local = []
const central = []
let offset = 0
for (const path of filesUnder('dist').sort()) {
  const name = Buffer.from(relative('dist', path).split('\\').join('/'))
  const data = readFileSync(path)
  const packed = deflateRawSync(data)
  const crc = crc32(data)

  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4) // version needed
  header.writeUInt16LE(0x0800, 6) // UTF-8 names
  header.writeUInt16LE(8, 8) // deflate
  header.writeUInt32LE(crc, 14)
  header.writeUInt32LE(packed.length, 18)
  header.writeUInt32LE(data.length, 22)
  header.writeUInt16LE(name.length, 26)
  local.push(header, name, packed)

  const entry = Buffer.alloc(46)
  entry.writeUInt32LE(0x02014b50, 0)
  entry.writeUInt16LE(20, 4) // version made by
  entry.writeUInt16LE(20, 6)
  entry.writeUInt16LE(0x0800, 8)
  entry.writeUInt16LE(8, 10)
  entry.writeUInt32LE(crc, 16)
  entry.writeUInt32LE(packed.length, 20)
  entry.writeUInt32LE(data.length, 24)
  entry.writeUInt16LE(name.length, 28)
  entry.writeUInt32LE(offset, 42)
  central.push(entry, name)

  offset += header.length + name.length + packed.length
}

const centralSize = central.reduce((n, b) => n + b.length, 0)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(central.length / 2, 8)
end.writeUInt16LE(central.length / 2, 10)
end.writeUInt32LE(centralSize, 12)
end.writeUInt32LE(offset, 16)

mkdirSync('release', { recursive: true })
writeFileSync(out, Buffer.concat([...local, ...central, end]))

// Put dist/ back to the dev build (with localhost) for the unpacked install.
execFileSync(process.execPath, ['build.mjs'], { stdio: 'ignore' })
console.log(`\n${out} — upload it in the Chrome Web Store developer dashboard.`)
