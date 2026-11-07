import { test } from 'node:test'
import assert from 'node:assert/strict'
import { symbolsOf } from '../public/symbols.ts'

test('symbolsOf lists top-level declarations and class members with their source', () =>
{
    const found = symbolsOf([
        'export function foo() {',
        '  return 1',
        '}',
        'export class Bar {',
        '  baz() { return 2; }',
        '  value = 1;',
        '}',
        'interface Shape { x: number }',
        'const n = 2',
    ].join('\n'))

    assert.deepEqual(found.functions.map((item) => item.name), ['foo', 'baz'])
    assert.deepEqual(found.classes.map((item) => item.name), ['Bar'])
    assert.deepEqual(found.interfaces.map((item) => item.name), ['Shape'])
    assert.deepEqual(found.variables.map((item) => item.name), ['value', 'n'])

    // A symbol's source runs from its line to the end of its block, so the code panel can show it.
    const foo = found.functions[0]!
    assert.equal(foo.line, 1)
    assert.match(foo.code, /return 1/)
    assert.doesNotMatch(foo.code, /class Bar/)
})
