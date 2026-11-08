import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

/** The endpoint used when none is set: OpenRouter, which speaks the OpenAI chat API. */
export const DefaultBaseUrl = 'https://openrouter.ai/api/v1'

/** The model used when none is set. */
export const DefaultModel = 'deepseek/deepseek-v4.1-flash'

/** The variable read from a key file when none is named. */
const DefaultKeyName = 'MODEL_API_KEY'

/** The model the chat talks to, and how to reach it. */
export interface IModelSettings
{
    /** The OpenAI-compatible endpoint, up to but not including `/chat/completions`. */
    baseUrl: string
    /** The model id the endpoint knows it by. */
    model: string
    /** The key sent with each request, or undefined when none was found. */
    apiKey: string | undefined
    /** Where the key came from, for the page to say, without the key itself. */
    keySource: string
    /** How many tokens the model can read at once. */
    contextWindow: number
    /** The most tokens one reply may use. */
    maxTokens: number
}

/**
 * Reads the chat's model from the environment. The key is either given directly, or read by name
 * from another program's env file, so one key can serve both without being copied.
 *
 *   CODESPACE_MODEL_BASE_URL     the endpoint (default OpenRouter)
 *   CODESPACE_MODEL              the model id
 *   CODESPACE_MODEL_API_KEY      the key itself
 *   CODESPACE_MODEL_KEY_FILE     or an env file holding it
 *   CODESPACE_MODEL_KEY_NAME     the variable to read from that file (default MODEL_API_KEY)
 *   CODESPACE_MODEL_CONTEXT      the context window, in tokens
 *   CODESPACE_MODEL_MAX_TOKENS   the longest reply, in tokens
 *
 * @param env the environment to read
 * @param readText reads a file, so a test need not touch the disk
 */
export function ReadModelSettings(env: Readonly<Record<string, string | undefined>>, readText: (path: string) => string = (path) => readFileSync(path, 'utf8')): IModelSettings
{
    const settings: IModelSettings = {
        baseUrl: (Trimmed(env.CODESPACE_MODEL_BASE_URL) ?? DefaultBaseUrl).replace(/\/+$/, ''),
        model: Trimmed(env.CODESPACE_MODEL) ?? DefaultModel,
        apiKey: undefined,
        keySource: 'none',
        contextWindow: PositiveNumber(env.CODESPACE_MODEL_CONTEXT) ?? 131_072,
        maxTokens: PositiveNumber(env.CODESPACE_MODEL_MAX_TOKENS) ?? 16_384,
    }

    const direct = Trimmed(env.CODESPACE_MODEL_API_KEY)
    const file = Trimmed(env.CODESPACE_MODEL_KEY_FILE)
    if (direct !== undefined)
    {
        settings.apiKey = direct
        settings.keySource = 'CODESPACE_MODEL_API_KEY'
    }
    else if (file !== undefined)
    {
        const name = Trimmed(env.CODESPACE_MODEL_KEY_NAME) ?? DefaultKeyName
        try
        {
            settings.apiKey = Trimmed(parseEnv(readText(file))[name])
            settings.keySource = settings.apiKey === undefined ? `${name} is not set in ${file}` : `${name} from ${file}`
        }
        catch (error)
        {
            settings.keySource = `${file} could not be read: ${(error as Error).message}`
        }
    }
    return settings
}

/** A value with its spaces trimmed, or undefined when nothing is left. */
function Trimmed(value: string | undefined): string | undefined
{
    const trimmed = value?.trim()
    return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** A whole number above zero, or undefined. */
function PositiveNumber(value: string | undefined): number | undefined
{
    const number = Number(value)
    return Number.isInteger(number) && number > 0 ? number : undefined
}
