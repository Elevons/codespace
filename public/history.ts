export const MaxHistoryCommits = 400;

export const HeatWindow = 10;

export interface IHistoryCommit
{
  hash: string;
  date: string;
  subject: string;
  files: string[];
}

export interface IHistoryAnswer { commits: IHistoryCommit[]; }

export interface ITimeline
{
  touches: Map<string, number[]>;
  first: Map<string, number>;
  last: number;
}

export function buildTimeline(commits: readonly IHistoryCommit[]): ITimeline
{
  const touches = new Map<string, number[]>();
  const first = new Map<string, number>();
  commits.forEach((commit, index) =>
  {
    for (const path of commit.files)
    {
      const list = touches.get(path);
      if (list) list.push(index);
      else { touches.set(path, [index]); first.set(path, index); }
    }
  });
  return { touches, first, last: commits.length - 1 };
}

// -1 for a file that does not exist yet at commit `at`; otherwise 1 for a file the commit touched,
// fading to 0 over HeatWindow commits. A file git never saw (untracked) exists only at the newest commit.
export function historyHeat(timeline: ITimeline, path: string, at: number): number
{
  const born = timeline.first.get(path);
  if (born === undefined) return at >= timeline.last ? 0 : -1;
  if (born > at) return -1;
  const list = timeline.touches.get(path)!;
  let latest = born;
  for (let i = list.length - 1; i >= 0; i--) if (list[i] <= at) { latest = list[i]; break; }
  return Math.max(0, 1 - (at - latest) / HeatWindow);
}
