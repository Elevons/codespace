import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Graph } from '../src/repo/Graph.ts'
import { Repo } from '../src/repo/Repo.ts'

test('Graph links C# files by the namespaces they use', async () =>
{
    // First we make a repository of C# files that name each other's namespaces.
    const root = await mkdtemp(join(tmpdir(), 'codespace-graph-'))
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
    finally { await rm(root, { recursive: true, force: true }) }
})

test('Graph reads static, global, and alias C# using directives', async () =>
{
    // First we make one C# file that reaches a sibling through each directive form.
    const root = await mkdtemp(join(tmpdir(), 'codespace-graph-'))
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
    finally { await rm(root, { recursive: true, force: true }) }
})

test('Graph still links TypeScript imports by relative specifier', async () =>
{
    // First we make a small TypeScript pair, so the C# path does not disturb the old one.
    const root = await mkdtemp(join(tmpdir(), 'codespace-graph-'))
    try
    {
        await writeFile(join(root, 'a.ts'), "import { b } from './b.ts'\nexport const a = b\n")
        await writeFile(join(root, 'b.ts'), 'export const b = 1\n')

        // Then the relative specifier resolves as before.
        const repo = await Repo.OpenAsync(root)
        const graph = await Graph.BuildAsync(repo)
        assert.deepEqual(graph.ImportsOf('a.ts'), ['b.ts'])
    }
    finally { await rm(root, { recursive: true, force: true }) }
})
