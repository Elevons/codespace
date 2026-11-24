import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MaxHistoryCommits, type IHistoryCommit } from '../../public/history.ts'

const Run = promisify(execFile)

const RecordMark = '\x1e'
const FieldMark = '\x1f'

export function ParseHistory(log: string): IHistoryCommit[]
{
    const parsed: Array<{ hash: string, date: string, subject: string, touched: string[], renames: Array<[string, string]> }> = []
    for (const chunk of log.split(RecordMark))
    {
        const lines = chunk.split('\n')
        const [hash, date, ...subject] = lines[0]!.split(FieldMark)
        if (!hash || date === undefined) continue
        const touched: string[] = []
        const renames: Array<[string, string]> = []
        for (const line of lines.slice(1))
        {
            const [status, from, to] = line.split('\t')
            if (!status || from === undefined) continue
            if (status[0] === 'D') continue
            if (status[0] === 'R' && to !== undefined) { renames.push([from, to]); touched.push(to) }
            else touched.push(to ?? from)
        }
        parsed.push({ hash, date, subject: subject.join(FieldMark), touched, renames })
    }

    // Newest first, so a file touched before it was renamed is credited to the name it has now.
    const now = new Map<string, string>()
    const commits: IHistoryCommit[] = []
    for (let i = parsed.length - 1; i >= 0; i--)
    {
        const entry = parsed[i]!
        const files = [...new Set(entry.touched.map((path) => now.get(path) ?? path))].sort()
        for (const [from, to] of entry.renames) now.set(from, now.get(to) ?? to)
        commits.unshift({ hash: entry.hash, date: entry.date, subject: entry.subject, files })
    }
    return commits
}

// Oldest first, relative to the repository folder. Outside git, or without git, there is no history.
export async function ReadHistoryAsync(root: string): Promise<IHistoryCommit[]>
{
    try
    {
        const { stdout } = await Run('git', [
            '-c', 'core.quotePath=false', '-C', root, 'log', '--reverse', '-M', '--relative', '--name-status',
            `--max-count=${MaxHistoryCommits}`, `--format=${RecordMark}%H${FieldMark}%as${FieldMark}%s`,
        ], { maxBuffer: 64 * 1024 * 1024 })
        return ParseHistory(stdout)
    }
    catch
    {
        return []
    }
}
