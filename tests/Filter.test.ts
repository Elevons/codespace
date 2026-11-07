import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ancestorFolders, foldersToKeepOpen, matchesQueryTerms, passesSliceValues, queryTerms } from '../public/filter.ts'

test('passesSliceValues treats an empty set as every value and can skip one axis', () =>
{
    const none = new Set<string>()
    const base = new Set(['server'])

    assert.equal(passesSliceValues('browser', 'ui', none, none), true)
    assert.equal(passesSliceValues('browser', 'ui', base, none), false)
    assert.equal(passesSliceValues('browser', 'ui', base, none, 'system'), true)
    assert.equal(passesSliceValues('server', 'ui', base, new Set(['base'])), false)
    assert.equal(passesSliceValues('server', 'ui', base, new Set(['base']), 'layer'), true)
    assert.equal(passesSliceValues(undefined, undefined, base, none), false)
})

test('queryTerms lowercases and splits a search into words', () =>
{
    assert.deepEqual(queryTerms('  Foo   BAR '), ['foo', 'bar'])
    assert.deepEqual(queryTerms('   '), [])
})

test('matchesQueryTerms needs every word in the path or the symbols', () =>
{
    const symbols = ['loadGraph', 'symbolsOf']
    assert.equal(matchesQueryTerms('public/repo.ts', symbols, []), true)
    assert.equal(matchesQueryTerms('public/repo.ts', symbols, ['repo']), true)
    assert.equal(matchesQueryTerms('public/repo.ts', symbols, ['rep', 'graph']), true)
    assert.equal(matchesQueryTerms('public/repo.ts', symbols, ['rep', 'missing']), false)
})

test('ancestorFolders lists every folder above a path, nearest first', () =>
{
    assert.deepEqual(ancestorFolders('src/deep/c.ts'), ['src/deep', 'src'])
    assert.deepEqual(ancestorFolders('src/deep'), ['src'])
    assert.deepEqual(ancestorFolders('README.md'), [])
})

test('foldersToKeepOpen opens the chain above each hidden file or folder, not the hidden folder itself', () =>
{
    const open = foldersToKeepOpen(['src/deep/c.ts', 'tests/a.test.ts'], ['src/deep'])
    assert.deepEqual([...open].sort(), ['src', 'src/deep', 'tests'])
})
