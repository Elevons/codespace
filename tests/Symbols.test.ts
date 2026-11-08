import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CODE_FILE, symbolsOf } from '../public/symbols.ts'

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

test('symbolsOf reads arrows, async and generic declarations, and default exports', () =>
{
    const found = symbolsOf([
        'export async function fetchAll() {',
        '  return 1',
        '}',
        'export const add = (a: number): number => a + 1',
        'export function identity<T>(value: T): T {',
        '  return value',
        '}',
        'export const id = <T,>(value: T): T => value',
        'export default function run() {',
        '  return 2',
        '}',
        'export default class Widget {',
        '  size = 1',
        '}',
    ].join('\n'))

    assert.deepEqual(found.functions.map((item) => item.name), ['fetchAll', 'add', 'identity', 'id', 'run'])
    assert.deepEqual(found.classes.map((item) => item.name), ['Widget'])
})

test('symbolsOf treats an enum as a class, and an interface member as a function or a variable', () =>
{
    const found = symbolsOf([
        'export enum Color {',
        '  Red,',
        '  Green',
        '}',
        'export interface Shape {',
        '  area(): number;',
        '  label: string;',
        '  readonly size: number;',
        '}',
    ].join('\n'))

    assert.deepEqual(found.classes.map((item) => item.name), ['Color'])
    assert.deepEqual(found.interfaces.map((item) => item.name), ['Shape'])
    assert.deepEqual(found.functions.filter((item) => item.name === 'area').map((item) => item.name), ['area'])
    assert.deepEqual(found.variables.filter((item) => ['label', 'size'].includes(item.name)).map((item) => item.name), ['label', 'size'])
})

test('CODE_FILE accepts code files and rejects files that are not code', () =>
{
    for (const path of ['src/a.ts', 'a.tsx', 'a.mts', 'a.js', 'a.py', 'a.cs', 'Program.cpp', 'README.md', 'data.json'])
        assert.equal(CODE_FILE.test(path), true, `${path} is code`)
    for (const path of ['Makefile', 'LICENSE', 'image.png', 'notes.txt', '.gitignore'])
        assert.equal(CODE_FILE.test(path), false, `${path} is not code`)
})
