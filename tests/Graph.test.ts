import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { makeTemp, removeTemp } from './support.ts'
import { join } from 'node:path'
import { Graph } from '../src/repo/Graph.ts'
import { Repo } from '../src/repo/Repo.ts'

test('Graph links C# files by the namespaces they use', async () =>
{
    // First we make a repository of C# files that name each other's namespaces.
    const root = await makeTemp('codespace-graph-')
    try
    {
        await mkdir(join(root, 'App'))
        await writeFile(join(root, 'App', 'Program.cs'),
            'using App.Core;\nnamespace App;\nclass Program { static void Main() { } }\n')
        await writeFile(join(root, 'App', 'Service.cs'),
            'using App.Core;\nnamespace App.Core;\nclass Service { }\n')
        await writeFile(join(root, 'App', 'Away.cs'),
            'using System;\nnamespace App;\nclass Away { }\n')

        // Then we build the graph: Program names App.Core, so it links to the file that declares it.
        const repo = await Repo.OpenAsync(root)
        const graph = await Graph.BuildAsync(repo)
        assert.deepEqual(graph.ImportsOf('App/Program.cs'), ['App/Service.cs'])

        // Finally: a namespace outside the repository links nowhere, and a file does not import itself.
        assert.deepEqual(graph.ImportsOf('App/Away.cs'), [])
        assert.deepEqual(graph.ImportsOf('App/Service.cs'), [])
        assert.deepEqual(graph.Edges(), [['App/Program.cs', 'App/Service.cs']])
    }
    finally { await removeTemp(root) }
})

test('Graph reads static, global, and alias C# using directives', async () =>
{
    // First we make one C# file that reaches a sibling through each directive form.
    const root = await makeTemp('codespace-graph-')
    try
    {
        await writeFile(join(root, 'Core.cs'), 'namespace App.Core;\npublic class Core { }\n')
        await writeFile(join(root, 'Program.cs'),
            'global using App.Core;\nusing static App.Core;\nusing Alias = App.Core;\nnamespace App;\nclass Program { }\n')

        // Then every form resolves to the file that declares App.Core, counted once.
        const repo = await Repo.OpenAsync(root)
        const graph = await Graph.BuildAsync(repo)
        assert.deepEqual(graph.ImportsOf('Program.cs'), ['Core.cs'])
    }
    finally { await removeTemp(root) }
})

test('Graph still links TypeScript imports by relative specifier', async () =>
{
    // First we make a small TypeScript pair, so the C# path does not disturb the old one.
    const root = await makeTemp('codespace-graph-')
    try
    {
        await writeFile(join(root, 'a.ts'), "import { b } from './b.ts'\nexport const a = b\n")
        await writeFile(join(root, 'b.ts'), 'export const b = 1\n')

        // Then the relative specifier resolves as before.
        const repo = await Repo.OpenAsync(root)
        const graph = await Graph.BuildAsync(repo)
        assert.deepEqual(graph.ImportsOf('a.ts'), ['b.ts'])
        // The names it imports travel with the edge, so a wire can meet the block that declares b.
        assert.deepEqual(graph.ImportNames(), { 'a.ts': { 'b.ts': ['b'] } })
    }
    finally { await removeTemp(root) }
})

test('A .mts file importing ./a.mjs links to a.mts, and .cts to .cjs the same way', async () =>
{
    const root = await makeTemp('codespace-graph-')
    try
    {
        await writeFile(join(root, 'a.mts'), 'export const a = 1\n')
        await writeFile(join(root, 'b.mts'), "import { a } from './a.mjs'\nexport const b = a\n")
        await writeFile(join(root, 'c.cts'), 'export const c = 1\n')
        await writeFile(join(root, 'd.cts'), "import { c } from './c.cjs'\nexport const d = c\n")

        const repo = await Repo.OpenAsync(root)
        const graph = await Graph.BuildAsync(repo)
        assert.deepEqual(graph.ImportsOf('b.mts'), ['a.mts'])
        assert.deepEqual(graph.ImportNames()['b.mts'], { 'a.mts': ['a'] })
        assert.deepEqual(graph.ImportsOf('d.cts'), ['c.cts'])
    }
    finally { await removeTemp(root) }
})
