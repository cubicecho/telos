export interface Entry {
  id: string;
  term: string;
  aliases: string[];
  definition: string;
  html: string;
}

export interface Group {
  id: string;
  title: string;
  entries: Entry[];
}

export function parseGlossary(markdown: string): Group[];
