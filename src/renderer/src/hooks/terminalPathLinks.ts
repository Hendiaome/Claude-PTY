import type { IBufferCellPosition, IDisposable, ILink, Terminal } from "@xterm/xterm";
import type { TerminalPathOpenRequest } from "../../../shared/types";

type LinkCell = {
  start: IBufferCellPosition;
  end: IBufferCellPosition;
};

type LogicalBufferText = {
  text: string;
  cells: LinkCell[];
};

export type TerminalPathMatch = TerminalPathOpenRequest & {
  start: number;
  end: number;
  text: string;
};

type OpenTerminalPath = (request: TerminalPathOpenRequest) => void;

const QUOTES = new Set(["'", '"', "`"]);
const START_BOUNDARIES = new Set([
  "'",
  '"',
  "`",
  "(",
  "[",
  "{",
  "<",
  "（",
  "【",
  "：",
  "=",
  ">",
  "•"
]);
const TOKEN_TERMINATORS = new Set([
  "'",
  '"',
  "`",
  "<",
  ">",
  "，",
  "。",
  "；",
  "！",
  "？",
  "、",
  ",",
  ";"
]);
const TRAILING_BRACKET_PAIRS = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
  ["）", "（"],
  ["】", "【"]
]);
const LOCATION_SUFFIX_REGEX = /:(\d+)(?:(?:-(\d+))|(?::(\d+)))?$/u;

/** 把 xterm 输出中的绝对路径注册为可点击 Link，并保留跨折行的准确点击范围。 */
export function registerTerminalPathLinks(terminal: Terminal, openPath: OpenTerminalPath): IDisposable {
  return terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const logicalLine = readLogicalBufferText(terminal, bufferLineNumber);
      if (!logicalLine) {
        callback(undefined);
        return;
      }

      const links = findTerminalPathMatches(logicalLine.text)
        .map((match) => createLink(match, logicalLine.cells, openPath))
        .filter((link): link is ILink => Boolean(link))
        .filter(
          (link) => link.range.start.y <= bufferLineNumber && link.range.end.y >= bufferLineNumber
        );

      callback(links.length > 0 ? links : undefined);
    }
  });
}

export function findTerminalPathMatches(text: string): TerminalPathMatch[] {
  const matches: TerminalPathMatch[] = [];

  for (let index = 0; index < text.length; index += 1) {
    if (!isPathStart(text, index) || !isStartBoundary(text, index)) {
      continue;
    }

    const quote = index > 0 && QUOTES.has(text[index - 1]) ? text[index - 1] : undefined;
    const tokenEnd = findTokenEnd(text, index, quote);
    const token = text.slice(index, tokenEnd);
    const linkText = trimPathDescription(token);
    const reference = parseTerminalPathToken(linkText);
    if (!reference) {
      continue;
    }

    matches.push({
      ...reference,
      start: index,
      end: index + linkText.length,
      text: linkText
    });
    index = tokenEnd - 1;
  }

  return matches;
}

function readLogicalBufferText(terminal: Terminal, bufferLineNumber: number): LogicalBufferText | undefined {
  // xterm 会把长路径折成多行，先还原逻辑行并保留字符到屏幕单元格的映射。
  const buffer = terminal.buffer.active;
  let startLine = bufferLineNumber - 1;
  if (!buffer.getLine(startLine)) {
    return undefined;
  }

  while (startLine > 0 && buffer.getLine(startLine)?.isWrapped) {
    startLine -= 1;
  }

  let endLine = startLine;
  while (endLine + 1 < buffer.length && buffer.getLine(endLine + 1)?.isWrapped) {
    endLine += 1;
  }

  let text = "";
  const cells: LinkCell[] = [];

  for (let lineIndex = startLine; lineIndex <= endLine; lineIndex += 1) {
    const line = buffer.getLine(lineIndex);
    if (!line) {
      continue;
    }

    const columnCount = Math.min(line.length, terminal.cols);
    for (let column = 0; column < columnCount; column += 1) {
      const cell = line.getCell(column);
      if (!cell || cell.getWidth() === 0) {
        continue;
      }

      const chars = cell.getChars() || " ";
      const width = Math.max(cell.getWidth(), 1);
      const location: LinkCell = {
        start: { x: column + 1, y: lineIndex + 1 },
        end: { x: column + width, y: lineIndex + 1 }
      };

      text += chars;
      for (let charIndex = 0; charIndex < chars.length; charIndex += 1) {
        cells.push(location);
      }
    }
  }

  while (text.endsWith(" ")) {
    text = text.slice(0, -1);
    cells.pop();
  }

  return { text, cells };
}

function createLink(match: TerminalPathMatch, cells: LinkCell[], openPath: OpenTerminalPath): ILink | undefined {
  const startCell = cells[match.start];
  const endCell = cells[match.end - 1];
  if (!startCell || !endCell) {
    return undefined;
  }

  return {
    range: {
      start: startCell.start,
      end: endCell.end
    },
    text: match.text,
    decorations: {
      pointerCursor: true,
      underline: true
    },
    activate: () => {
      openPath({
        path: match.path,
        line: match.line,
        column: match.column
      });
    }
  };
}

function isPathStart(text: string, index: number): boolean {
  return text.startsWith("~/", index) || (text[index] === "/" && text[index + 1] !== "/");
}

function isStartBoundary(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }

  const previous = text[index - 1];
  return /\s/u.test(previous) || START_BOUNDARIES.has(previous);
}

function findTokenEnd(text: string, start: number, quote: string | undefined): number {
  if (quote) {
    const closingQuote = text.indexOf(quote, start);
    if (closingQuote >= 0) {
      return closingQuote;
    }
  }

  let end = start;
  while (end < text.length && !/\s/u.test(text[end]) && !TOKEN_TERMINATORS.has(text[end])) {
    end += 1;
  }
  return end;
}

function parseTerminalPathToken(token: string): TerminalPathOpenRequest | undefined {
  const locationMatch = LOCATION_SUFFIX_REGEX.exec(token);
  const path = locationMatch?.index === undefined ? token : token.slice(0, locationMatch.index);
  if (!hasRequiredPathDepth(path)) {
    return undefined;
  }

  const line = locationMatch ? Number(locationMatch[1]) : undefined;
  const column = locationMatch?.[3] ? Number(locationMatch[3]) : undefined;
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) {
    return undefined;
  }
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) {
    return undefined;
  }

  return {
    path,
    line,
    column
  };
}

function trimPathDescription(token: string): string {
  // 路径内部可以包含成对括号；只有正文包裹路径时多出来的右括号才需要去掉。
  const pathToken = trimUnmatchedTrailingBrackets(token);
  const finalSegmentStart = pathToken.lastIndexOf("/") + 1;
  for (let index = finalSegmentStart; index < pathToken.length; index += 1) {
    if (pathToken[index] === "：") {
      return pathToken.slice(0, index);
    }
    if (pathToken[index] === ":" && !isAsciiDigit(pathToken[index + 1])) {
      return pathToken.slice(0, index);
    }
    if (pathToken[index] === "#") {
      // “文件#符号”是代码引用写法，IDEA 打开时只传真实文件路径。
      return pathToken.slice(0, index);
    }
  }

  return pathToken;
}

function trimUnmatchedTrailingBrackets(token: string): string {
  let end = token.length;

  while (end > 0) {
    const closingBracket = token[end - 1];
    const openingBracket = TRAILING_BRACKET_PAIRS.get(closingBracket);
    if (!openingBracket) {
      break;
    }

    const candidate = token.slice(0, end);
    const openingCount = countCharacter(candidate, openingBracket);
    const closingCount = countCharacter(candidate, closingBracket);
    if (closingCount <= openingCount) {
      break;
    }
    end -= 1;
  }

  return token.slice(0, end);
}

function countCharacter(text: string, expected: string): number {
  let count = 0;
  for (const character of text) {
    if (character === expected) {
      count += 1;
    }
  }
  return count;
}

function isAsciiDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function hasRequiredPathDepth(path: string): boolean {
  if (path.startsWith("~/")) {
    return path.slice(2).includes("/");
  }

  if (!path.startsWith("/") || path.startsWith("//")) {
    return false;
  }

  return path.slice(1).includes("/");
}
