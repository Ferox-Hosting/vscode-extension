import * as vscode from 'vscode';
import type { DirectoryEntry, FileSearchFilters } from '../api/types.ts';
import { decodeAuthority } from '../fs/fileSystemProvider.ts';
import type { Session } from '../session.ts';

const MAX_RESOLVE_FILE_SIZE = 256 * 1024;
const MAX_RESOLVE_FILES = 64;
const CONTENT_SEARCH_SIZE = Number.MAX_SAFE_INTEGER;

export function toGitGlobs(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]*)\}/);
  if (!match) {
    return [pattern];
  }

  return match[1]
    .split(',')
    .flatMap((alt) => toGitGlobs(pattern.slice(0, match.index) + alt + pattern.slice(match.index! + match[0].length)));
}

function globPatternToString(glob: vscode.GlobPattern): string {
  return typeof glob === 'string' ? glob : glob.pattern;
}

function joinRoot(root: string, relative: string): string {
  const base = root.endsWith('/') ? root : `${root}/`;
  return base + relative.replace(/^\/+/, '');
}

async function searchServer(
  session: Session,
  folder: vscode.Uri,
  filters: FileSearchFilters,
): Promise<DirectoryEntry[]> {
  const { origin, server } = decodeAuthority(folder.authority);
  const client = await session.client(origin);
  return client.searchFiles(server, filters);
}

export class CalagopusFileSearchProvider implements vscode.FileSearchProvider2 {
  constructor(private readonly session: Session) {}

  async provideFileSearchResults(
    pattern: string,
    options: vscode.FileSearchProviderOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.Uri[]> {
    const results: vscode.Uri[] = [];

    for (const folder of options.folderOptions) {
      if (token.isCancellationRequested || results.length >= options.maxResults) {
        break;
      }
      if (folder.folder.scheme !== 'calagopus') {
        continue;
      }

      const root = folder.folder.path || '/';
      const include = pattern ? [pattern.includes('/') ? `**/*${pattern}*` : `*${pattern}*`] : ['**'];

      const entries = await searchServer(this.session, folder.folder, {
        root,
        path_filter: {
          include: [...include, ...folder.includes.flatMap(toGitGlobs)],
          exclude: folder.excludes.map(globPatternToString).flatMap(toGitGlobs),
          case_insensitive: true,
        },
        size_filter: null,
        content_filter: null,
      });

      for (const entry of entries) {
        if (!entry.file) {
          continue;
        }
        results.push(folder.folder.with({ path: joinRoot(root, entry.name) }));
        if (results.length >= options.maxResults) {
          break;
        }
      }
    }

    return results;
  }
}

export class CalagopusTextSearchProvider implements vscode.TextSearchProvider2 {
  constructor(private readonly session: Session) {}

  async provideTextSearchResults(
    query: vscode.TextSearchQuery2,
    options: vscode.TextSearchProviderOptions,
    progress: vscode.Progress<vscode.TextSearchResult2>,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextSearchComplete2> {
    let limitHit = false;
    let reported = 0;
    let resolvedFiles = 0;

    for (const folder of options.folderOptions) {
      if (token.isCancellationRequested) {
        break;
      }
      if (folder.folder.scheme !== 'calagopus') {
        continue;
      }

      const root = folder.folder.path || '/';

      const contentFilter = query.isRegExp
        ? null
        : {
            query: query.pattern,
            max_search_size: CONTENT_SEARCH_SIZE,
            include_unmatched: false,
            case_insensitive: !query.isCaseSensitive,
          };

      const entries = await searchServer(this.session, folder.folder, {
        root,
        path_filter:
          folder.includes.length > 0 || folder.excludes.length > 0
            ? {
                include: folder.includes.flatMap(toGitGlobs),
                exclude: folder.excludes.map(globPatternToString).flatMap(toGitGlobs),
                case_insensitive: true,
              }
            : query.isRegExp
              ? { include: ['**'], exclude: [], case_insensitive: true }
              : null,
        size_filter: query.isRegExp ? { min: 0, max: MAX_RESOLVE_FILE_SIZE } : null,
        content_filter: contentFilter,
      });

      for (const entry of entries) {
        if (token.isCancellationRequested || reported >= options.maxResults) {
          limitHit = limitHit || reported >= options.maxResults;
          break;
        }
        if (!entry.file || entry.size > MAX_RESOLVE_FILE_SIZE) {
          continue;
        }
        if (resolvedFiles >= MAX_RESOLVE_FILES) {
          limitHit = true;
          break;
        }

        const uri = folder.folder.with({ path: joinRoot(root, entry.name) });
        resolvedFiles++;

        const matches = await this.resolveMatches(uri, query, options, token);
        for (const match of matches) {
          progress.report(match);
          if (++reported >= options.maxResults) {
            limitHit = true;
            break;
          }
        }
      }
    }

    return { limitHit };
  }

  private async resolveMatches(
    uri: vscode.Uri,
    query: vscode.TextSearchQuery2,
    options: vscode.TextSearchProviderOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextSearchMatch2[]> {
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      return [];
    }

    const matcher = buildMatcher(query);
    if (!matcher) {
      return [];
    }

    const maxPreview = options.previewOptions?.charsPerLine ?? 250;
    const matches: vscode.TextSearchMatch2[] = [];

    const lines = text.split(/\r?\n/);
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      if (token.isCancellationRequested) {
        break;
      }

      const line = lines[lineNo];
      for (const [start, end] of matcher(line)) {
        const previewText = line.slice(0, maxPreview);
        matches.push(
          new vscode.TextSearchMatch2(
            uri,
            [
              {
                sourceRange: new vscode.Range(lineNo, start, lineNo, end),
                previewRange: new vscode.Range(0, Math.min(start, maxPreview), 0, Math.min(end, maxPreview)),
              },
            ],
            previewText,
          ),
        );
      }
    }

    return matches;
  }
}

function buildMatcher(query: vscode.TextSearchQuery2): ((line: string) => [number, number][]) | null {
  if (query.isRegExp) {
    let regex: RegExp;
    try {
      regex = new RegExp(query.pattern, query.isCaseSensitive ? 'g' : 'gi');
    } catch {
      return null;
    }

    return (line) => {
      const out: [number, number][] = [];
      for (const m of line.matchAll(regex)) {
        if (m[0].length === 0) {
          break;
        }
        out.push([m.index, m.index + m[0].length]);
      }
      return out;
    };
  }

  const needle = query.isCaseSensitive ? query.pattern : query.pattern.toLowerCase();
  const wordBoundary = (line: string, start: number, end: number) => {
    const isWord = (ch: string | undefined) => ch !== undefined && /\w/.test(ch);
    return !isWord(line[start - 1]) && !isWord(line[end]);
  };

  return (line) => {
    const haystack = query.isCaseSensitive ? line : line.toLowerCase();
    const out: [number, number][] = [];
    for (let idx = haystack.indexOf(needle); idx !== -1; idx = haystack.indexOf(needle, idx + 1)) {
      const end = idx + needle.length;
      if (!query.isWordMatch || wordBoundary(line, idx, end)) {
        out.push([idx, end]);
      }
    }
    return out;
  };
}
