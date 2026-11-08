import { Architecture } from './Architecture.ts'
import { Graph } from './Graph.ts'
import { NextBatchAsync, type IIngestBatch } from './Ingest.ts'
import type { Repo } from './Repo.ts'
import { SyncAsync } from './Sync.ts'

/**
 * Hands out the next files or folders to describe, the same way for the CLI and the map API: entries
 * follow moved files and leave deleted ones first, and generated files in the batch are settled on the spot.
 * @param repo the repository being described
 * @param size the most files or folders to hand out
 */
export async function TakeNextAsync(repo: Repo, size: number): Promise<IIngestBatch>
{
    // Entries follow moved files and leave deleted ones first, so neither is described again from nothing.
    await SyncAsync(repo)
    const known = await repo.ListFilesAsync()
    const architecture = await Architecture.ReadAsync(repo.Root, known)
    const batch = await NextBatchAsync(repo, architecture, await Graph.BuildAsync(repo), size)

    // Generated files are settled here, so the agent never spends a read on them.
    if (batch.skipped.length > 0)
    {
        const files = Object.fromEntries(batch.skipped.map((item) => [item.path, { summary: item.summary }]))
        await Architecture.UpdateAsync(repo.Root, known, { files })
    }
    return batch
}
