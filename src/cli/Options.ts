/**
 * Reads `--name value` or `--name=value` from the command line.
 * @param args the command-line arguments
 * @param name the option name, with its dashes
 */
export function ReadOption(args: readonly string[], name: string): string | undefined
{
    const withEquals = args.find((arg) => arg.startsWith(name + '='))
    if (withEquals !== undefined) return withEquals.slice(name.length + 1)
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
}

/** The most files, folders, or report items one command hands back. */
export const MaxBatchSize = 40

/**
 * Reads `--size`, kept between 1 and MaxBatchSize.
 * @param args the command-line arguments
 * @param fallback the size when none is given
 */
export function ReadSize(args: readonly string[], fallback: number): number
{
    const size = Number(ReadOption(args, '--size')) || fallback
    return Math.max(1, Math.min(MaxBatchSize, size))
}
