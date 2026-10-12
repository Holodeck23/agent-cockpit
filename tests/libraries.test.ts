import { mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isInside, MAX_DIRECTORIES, nodeScanFs, parseLayerStatus, scanLibrary, scanPaths, type LibraryScan, type ScanFs } from '../server/projects/libraries.ts'

const newRoot = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-libraries-')))
const dir = (...parts: string[]): string => { const p = join(...parts); mkdirSync(p, { recursive: true }); return p }
const file = (path: string, text = ''): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
const area = (scan: LibraryScan, name: string) => scan.areas.find((a) => a.name === name)
const names = (scan: LibraryScan, name: string): string[] => (area(scan, name)?.projects ?? []).map((p) => p.name)
const expectUnique = (scan: LibraryScan): void => { const paths = scanPaths(scan); expect(new Set(paths).size).toBe(paths.length) }

/** A small invented library: two areas, a shelf, a loose project, a sub-project. */
function codeLibrary(): string {
  const root = newRoot()
  dir(root, 'apps', 'tidepool', '.git')
  file(join(root, 'apps', 'tidepool', 'CLAUDE.md'))
  dir(root, 'apps', 'tidepool', 'docs-site', '.git') // sub-project
  dir(root, 'apps', 'tidepool', 'src') // plain folder, not a project
  dir(root, 'apps', 'lantern')
  dir(root, 'sketches', 'kiln')
  dir(root, 'parked', 'old-orchard')
  dir(root, 'Archive', 'copperline')
  dir(root, 'Field Notes ', '.git') // a top-level project, trailing space in its name
  dir(root, '.hidden', 'secret')
  dir(root, 'apps', 'node_modules', 'left-pad')
  return root
}

describe('library scanner', () => {
  it('turns top-level folders into areas and their child folders into projects', () => {
    const scan = scanLibrary({ root: codeLibrary() }, [])
    expect(scan.areas.map((a) => a.name).sort()).toEqual(['Archive', 'Loose', 'apps', 'parked', 'sketches'])
    expect(names(scan, 'apps')).toEqual(['lantern', 'tidepool'])
    expect(names(scan, 'sketches')).toEqual(['kiln'])
    expect(scan.truncated).toBe(false)
    expectUnique(scan)
  })

  it('skips dot-folders and node_modules', () => {
    const scan = scanLibrary({ root: codeLibrary() }, [])
    expect(scanPaths(scan).some((p) => p.includes('.hidden') || p.includes('node_modules'))).toBe(false)
    expect(scan.areas.some((a) => a.name.startsWith('.'))).toBe(false)
  })

  it('marks parked, archive, archived, third-party and vendor as shelves', () => {
    const scan = scanLibrary({ root: codeLibrary() }, [])
    expect(area(scan, 'parked')?.shelf).toBe(true)
    expect(area(scan, 'Archive')?.shelf).toBe(true)
    expect(area(scan, 'apps')?.shelf).toBe(false)
  })

  it('puts a top-level folder that is itself a project in "Loose", name trimmed', () => {
    const scan = scanLibrary({ root: codeLibrary() }, [])
    expect(names(scan, 'Loose')).toEqual(['Field Notes'])
    expect(area(scan, 'Field Notes ')).toBeUndefined()
  })

  it('a top-level folder with its own CLAUDE.md and folders inside is an area; an empty top-level folder is nothing', () => {
    const root = codeLibrary()
    file(join(root, 'life', 'CLAUDE.md'))
    dir(root, 'life', 'money')
    dir(root, 'life', 'health')
    file(join(root, 'notes-only', 'readme.md'))
    file(join(root, 'just-instructions', 'AGENTS.md'))
    const scan = scanLibrary({ root }, [])
    expect(names(scan, 'life')).toEqual(['health', 'money'])
    expect(area(scan, 'notes-only')).toBeUndefined()
    expect(names(scan, 'Loose')).toEqual(['Field Notes', 'just-instructions'])
  })

  it('nests a project inside another project as a sub-project; plain folders are not projects', () => {
    const scan = scanLibrary({ root: codeLibrary() }, [])
    const tidepool = area(scan, 'apps')!.projects.find((p) => p.name === 'tidepool')!
    expect(tidepool.children.map((c) => c.name)).toEqual(['docs-site'])
  })

  it('nests a known project under the deepest scanned project that contains it', () => {
    const root = codeLibrary()
    const deep = dir(root, 'apps', 'tidepool', 'src', 'widgets')
    const scan = scanLibrary({ root }, [], nodeScanFs, [deep, '/no/such/folder'])
    const tidepool = area(scan, 'apps')!.projects.find((p) => p.name === 'tidepool')!
    expect(tidepool.children.map((c) => c.name).sort()).toEqual(['docs-site', 'widgets'])
    expectUnique(scan)
  })

  it('a known project already found by the scan is not added twice', () => {
    const root = codeLibrary()
    const scan = scanLibrary({ root }, [], nodeScanFs, [join(root, 'apps', 'tidepool'), join(root, 'apps', 'tidepool', 'docs-site')])
    expectUnique(scan)
    expect(scanPaths(scan)).toHaveLength(scanPaths(scanLibrary({ root }, [])).length)
  })

  it('skips a symlink into another library, so nothing is listed twice or picks up the other library\'s privacy', () => {
    const notes = newRoot()
    dir(notes, 'garden', 'atlas')
    const priv = newRoot()
    dir(priv, 'table', 'budget')
    symlinkSync(join(notes, 'garden'), join(priv, 'garden-link'))
    symlinkSync(join(notes, 'garden', 'atlas'), join(priv, 'table', 'atlas-link'))
    const scan = scanLibrary({ root: priv, private: true }, [notes])
    expect(scan.areas.map((a) => a.name)).toEqual(['table'])
    expect(names(scan, 'table')).toEqual(['budget'])
    expect(scan.areas.every((a) => a.private)).toBe(true)
    expect(scanPaths(scan).some((p) => isInside(p, notes))).toBe(false)
  })

  it('skips a symlink to a folder inside the same library: the real folder is listed once, under its own name', () => {
    const root = codeLibrary()
    symlinkSync(join(root, 'apps', 'lantern'), join(root, 'sketches', 'aaa-lantern-link'))
    const scan = scanLibrary({ root }, [])
    expect(names(scan, 'sketches')).toEqual(['kiln'])
    expect(names(scan, 'apps')).toContain('lantern')
    expectUnique(scan)
  })

  it('survives a symlink loop and a link back up the tree', () => {
    const root = codeLibrary()
    symlinkSync(join(root, 'loop-b'), join(root, 'loop-a'))
    symlinkSync(join(root, 'loop-a'), join(root, 'loop-b'))
    symlinkSync(root, join(root, 'apps', 'up'))
    symlinkSync(join(root, 'nowhere'), join(root, 'dangling'))
    const scan = scanLibrary({ root }, [])
    expect(names(scan, 'apps')).toEqual(['lantern', 'tidepool'])
    expect(scan.areas.some((a) => a.name.startsWith('loop'))).toBe(false)
    expectUnique(scan)
  })

  it('follows a symlink to a folder outside every library', () => {
    const outside = newRoot()
    dir(outside, 'shared-thing', '.git')
    const root = codeLibrary()
    symlinkSync(join(outside, 'shared-thing'), join(root, 'apps', 'shared-link'))
    const scan = scanLibrary({ root }, [])
    const linked = area(scan, 'apps')!.projects.find((p) => p.name === 'shared-link')
    expect(linked?.path).toBe(join(outside, 'shared-thing'))
  })

  it('stops after the directory budget and says so', () => {
    const root = newRoot()
    for (let i = 0; i < 30; i += 1) dir(root, 'area', `p${i}`)
    let reads = 0
    const counting: ScanFs = { ...nodeScanFs, readdir: (p) => { reads += 1; return nodeScanFs.readdir(p) } }
    const small = scanLibrary({ root }, [], counting)
    expect(small.truncated).toBe(false)
    expect(reads).toBeLessThanOrEqual(MAX_DIRECTORIES)
    for (let i = 0; i < MAX_DIRECTORIES; i += 1) dir(root, 'big', `d${i}`)
    const big = scanLibrary({ root }, [])
    expect(big.truncated).toBe(true)
  })

  it('reads layers from what is on disk, with each layer\'s own mtime', () => {
    const root = newRoot()
    const p = dir(root, 'apps', 'tidepool')
    file(join(p, 'CLAUDE.md'))
    dir(p, 'rules')
    dir(p, '.claude', 'skills')
    const layers = scanLibrary({ root }, []).areas[0]!.projects[0]!.layers
    expect(layers.map((l) => [l.id, l.state])).toEqual([
      ['identity', 'present'], ['substrate', 'missing'], ['rules', 'present'], ['skills', 'present'], ['tools', 'missing'], ['agents', 'missing'],
    ])
    expect(layers[0]!.changedAt).toBe(new Date(statSync(join(p, 'CLAUDE.md')).mtimeMs).toISOString())
    expect(layers[1]!.changedAt).toBeUndefined()
  })

  it('an os-coach memory.md Layer status block overrides what is found on disk', () => {
    const root = newRoot()
    const p = dir(root, 'apps', 'tidepool')
    file(join(p, 'CLAUDE.md'))
    file(join(p, 'memory.md'), '# OS Coach Memory\n\n## Layer status\n- Identity: solid - fine\n- Substrate: in progress - notes\n- Rules: not started - none\n\n## Decisions\n- Tools: solid - not in the block\n')
    const layers = scanLibrary({ root }, []).areas[0]!.projects[0]!.layers
    expect(layers.map((l) => l.state)).toEqual(['solid', 'in-progress', 'missing', 'missing', 'missing', 'missing'])
  })

  it('parses Layer status names loosely and ignores lines it does not know', () => {
    expect(parseLayerStatus('## Layer status\n- Rules & hooks: solid - x\n- Tools & connections: in progress\n- Mood: solid\n')).toEqual({ rules: 'solid', tools: 'in-progress' })
    expect(parseLayerStatus('no block here')).toEqual({})
  })

  it('never writes: the library listing is identical before and after a scan', () => {
    const root = codeLibrary()
    const listing = (d: string): string[] => readdirSync(d, { recursive: true }).map(String).sort()
    const before = listing(root)
    scanLibrary({ root }, [])
    expect(listing(root)).toEqual(before)
  })

  it('isInside compares whole segments', () => {
    expect(isInside('/a/b/c', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/bc', '/a/b')).toBe(false)
  })

  it('gives every area a stable id', () => {
    const root = codeLibrary()
    expect(scanLibrary({ root }, []).areas.map((a) => a.id)).toEqual(scanLibrary({ root }, []).areas.map((a) => a.id))
    expect(new Set(scanLibrary({ root }, []).areas.map((a) => a.id)).size).toBe(5)
  })
})
