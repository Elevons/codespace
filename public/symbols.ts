/**
 * The declarations a source file lists, read from its text. Kept dependency-free so it can be
 * tested under node, away from the browser's scene and DOM.
 */

/** The files read for their line count and declarations; every other type is shown, not scanned. */
export const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|swift|cs|c|h|cc|cpp|hpp|php|vue|svelte|scala|dart|lua|ex|exs|erl|clj|jl|r|html?|css|scss|less|json|yaml|yml|svg|xml|md|sh|sql)$/;

/** The code files whose imports are read as TypeScript or JavaScript, by relative specifier. */
export const TS_JS_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** One declaration a source file lists: its name, the line it starts on, and the source it spans. */
export interface SymbolInfo
{
  name: string;
  line: number;
  code: string;
}

// The declaration's source: from its line to the closing brace of its block, or the line itself
// when it opens no block. A rough brace count is enough for the shapes this reads.
function symbolBlock(lines: string[], start: number): string
{
  let depth = 0, opened = false;
  for (let i = start; i < lines.length; i++)
  {
    for (const ch of lines[i])
    {
      if (ch === "{") { depth++; opened = true; }
      else if (ch === "}") depth--;
      else if (ch === ";" && !opened && depth === 0) return lines.slice(start, i + 1).join("\n");
    }
    if (opened && depth <= 0) return lines.slice(start, i + 1).join("\n");
  }
  return lines.slice(start).join("\n");
}

// The functions, classes, interfaces, and variables a script declares, each with its source.
// A top-level declaration counts, and so does each method or field a class or interface body
// holds, so a codebase written as one class per file still lists its members.
export function symbolsOf(text: string): { functions: SymbolInfo[]; classes: SymbolInfo[]; interfaces: SymbolInfo[]; variables: SymbolInfo[] }
{
  const lines = text.split("\n");
  const functions: SymbolInfo[] = [], classes: SymbolInfo[] = [], interfaces: SymbolInfo[] = [], variables: SymbolInfo[] = [];

  // The brace depth just before each line, so a body line can be told from a member.
  const depthBefore: number[] = [];
  let depth = 0;
  for (const line of lines)
  {
    depthBefore.push(depth);
    for (const ch of line) { if (ch === "{") depth++; else if (ch === "}") depth--; }
  }

  // The body depths of the classes and interfaces we are inside, innermost last. A line sitting at
  // the innermost body declares a member: a method (a function), or a field (a variable).
  const bodies: number[] = [];
  const member = /^\s+(?:(?:public|private|protected|static|readonly|abstract|async|override|declare|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\??\s*([:(<=])/;

  lines.forEach((raw, i) =>
  {
    // First we forget any body we have left. A lone "{" is the body opening, not a way out.
    while (bodies.length > 0 && depthBefore[i] < bodies[bodies.length - 1] && raw.trim() !== "{") bodies.pop();
    const line = raw.replace(/^export\s+(?:default\s+)?/, "");
    let match: RegExpExecArray | null;

    if (!/^\s/.test(raw) && raw !== "")
    {
      if ((match = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line)) ||
          (match = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)[^=]*=>/.exec(line)) ||
          (match = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/.exec(line)))
      {
        functions.push({ name: match[1], line: i + 1, code: symbolBlock(lines, i) });
      }
      else if ((match = /^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line)) || (match = /^enum\s+([A-Za-z_$][\w$]*)/.exec(line)))
      {
        classes.push({ name: match[1], line: i + 1, code: symbolBlock(lines, i) });
        bodies.push(depthBefore[i] + 1);
      }
      else if ((match = /^interface\s+([A-Za-z_$][\w$]*)/.exec(line)))
      {
        interfaces.push({ name: match[1], line: i + 1, code: symbolBlock(lines, i) });
        bodies.push(depthBefore[i] + 1);
      }
      else if ((match = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line)))
      {
        variables.push({ name: match[1], line: i + 1, code: symbolBlock(lines, i) });
      }
      return;
    }

    // Inside a class or interface body, an indented declaration is a member.
    if (bodies.length > 0 && depthBefore[i] === bodies[bodies.length - 1] && (match = member.exec(raw)) !== null)
    {
      const info = { name: match[1], line: i + 1, code: symbolBlock(lines, i) };
      if (match[2] === "(" || match[2] === "<") functions.push(info);
      else variables.push(info);
    }
  });
  return { functions, classes, interfaces, variables };
}
