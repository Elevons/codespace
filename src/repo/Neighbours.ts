import { ClampNeighbourDepth, MaxNeighbourhood, type INeighbour } from '../../public/neighbours.ts'

/**
 * The files around one file: the chosen file first, then the files it imports and the files that
 * import it, outward by one step each time. An import is followed in both directions, so a
 * neighbourhood answers "what does this part of the code touch" rather than only "what does it use".
 * @param edges every import, as the importing file and the imported one
 * @param path the file to stand at
 * @param depth how many steps out to walk, from 1 to `MaxNeighbourDepth`
 */
export function Neighbours(edges: ReadonlyArray<readonly [string, string]>, path: string, depth = 1): INeighbour[]
{
    const steps = ClampNeighbourDepth(depth)
    const around = new Map<string, Set<string>>()
    const link = (a: string, b: string): void =>
    {
        if (a === b) return
        const set = around.get(a) ?? new Set<string>()
        set.add(b)
        around.set(a, set)
    }
    for (const [from, to] of edges) { link(from, to); link(to, from) }

    const found: INeighbour[] = [{ path, depth: 0 }]
    const seen = new Set([path])
    let frontier = [path]
    for (let step = 1; step <= steps && frontier.length > 0; step++)
    {
        const next = new Set<string>()
        for (const at of frontier)
        {
            for (const other of around.get(at) ?? [])
            {
                if (seen.has(other)) continue
                seen.add(other)
                found.push({ path: other, depth: step })
                next.add(other)
            }
        }
        frontier = [...next].sort()
    }

    // The list is ordered by distance, then by name, so two calls agree.
    return found
        .sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : 1))
        .slice(0, MaxNeighbourhood)
}
