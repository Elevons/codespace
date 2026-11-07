import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Makes an empty temporary repository folder, named with the given prefix. */
export function makeTemp(prefix: string): Promise<string>
{
    return mkdtemp(join(tmpdir(), prefix))
}

/** Removes one or more temporary folders, and everything under them. */
export async function removeTemp(...roots: string[]): Promise<void>
{
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
}
